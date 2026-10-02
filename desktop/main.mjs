import { app, BrowserWindow, Menu, Tray, dialog, ipcMain, nativeImage, shell } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import {
  buildChatRequestBody,
  buildRequestMessages,
  chatQualityDefaults,
  createRequestRegistry,
  extractStreamDelta,
} from './lib/chat-pipeline.mjs'
import { appendVisibleLogs, createLogChunkBuffers, flushLogChunkBuffer, processBufferedLogChunk, processLogChunk } from './lib/log-pipeline.mjs'
import { computeStablePreset, parseGgufMetadata, suggestPresetName } from './lib/stable-preset.mjs'
import { DEFAULT_HOST, assertNoCoreArgConflicts, assertStartableServerConfig, runtimeWarnings, serviceUrls, splitExtraArgs } from './lib/runtime-policy.mjs'
import {
  ENGINE_DEFINITIONS,
  assertEngineCompatible,
  detectEngineByPath,
  engineCandidateFromFile,
  engineSupportsFlag,
  extractPresetMetadata,
  getEngineLabel,
  describeUnknownFlags,
  isEngineServerFile,
  mergeDiscoveredEngines,
  pickRecommendedEngine,
  rankEngineCandidates,
  recommendEngineIdForModel,
  unknownExtraFlags,
  sanitizeEngineParams,
  stripUiPreferences,
  restoreEmptyPathFields,
  listPresetNamesFromFiles,
  pickExistingDir,
  pickServerExecutable,
  presetFileName,
  resolveEngineBinDir,
  vramSnapshot,
} from './lib/preset-engine.mjs'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rootDir = path.resolve(__dirname, '..')
// ---------------------------------------------------------------------------
// 独立实例(硬约束,别改回去)
//
// 1) 数据根 = 应用自己的目录:config.toml 与 configs\ 只在自己的目录里读写;
// 2) Electron 用户数据目录也搬进应用目录。原装 exe 的 ProductName 同为
//    "Llama Rig",两者共用 %APPDATA%\Llama Rig 时会命中同一个
//    单实例锁 —— 先启动的那个会把另一个直接踢退。
//
// 原装安装目录只在「首次运行播种」时被读一次,运行期永不触碰。
// ---------------------------------------------------------------------------
// 打包后数据根放在 exe 旁边 —— 但 portable 目标是"自解压 exe"，
// 运行时先解包到临时目录，process.execPath 指向的是那个临时目录，
// 照它建 config.toml/configs/userdata 会在退出后被清掉。
// electron-builder 为此提供 PORTABLE_EXECUTABLE_DIR（真正的 exe 所在目录），优先用它。
const appOwnDir = app.isPackaged
  ? (process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath))
  : rootDir
const legacyUserDataDir = app.getPath('userData')
const ownUserDataDir = path.join(appOwnDir, 'userdata')
mkdirSync(ownUserDataDir, { recursive: true })
app.setPath('userData', ownUserDataDir)

const preloadPath = path.join(__dirname, 'preload.cjs')
const rendererPath = path.join(rootDir, 'renderer', 'index.html')
const iconPath = path.join(rootDir, 'assets', 'llamarig.ico')
const trayIconPath = path.join(rootDir, 'assets', 'llamarig-tray.png')
const execFileAsync = promisify(execFile)

// 主进程保留的日志条数上限。原先这个 1200 只裸写在 appendVisibleLogs 调用处，
// 而界面文案里也手抄了一份 —— 常量一改两边就不同步。
const STORED_LOG_LIMIT = 1200
// 原装安装目录：仅供「首次运行播种」使用(只读)，不是运行期数据根。
// 开发机便利路径。**默认必须为空** —— 一旦写死成默认值，就会随包发给每个用户，
// 把开发机的目录布局强加给他们，指向他们机器上根本不存在的位置。
//
// 这里连「开发机用哪个文件夹」都不写进源码：公开仓库里不该出现作者本机的目录命名。
// 开发时用两个环境变量直接指向目标目录（见 dev/README.md）：
//   LLAMA_RIG_DEV_MODELS_DIR  —— 模型根目录（扫描 gguf 用）
//   LLAMA_RIG_DEV_LEGACY_DIR  —— 旧版安装目录（首次运行播种 config.toml / 预设用）
const devModelsDir = String(process.env.LLAMA_RIG_DEV_MODELS_DIR || '').trim()
const legacyBaseDir = String(process.env.LLAMA_RIG_DEV_LEGACY_DIR || '').trim()
// 引擎二进制目录：与数据根解耦，引擎装在别处。
const authoredModelsBaseDir = devModelsDir
const authoredServerPath = authoredModelsBaseDir
  ? path.join(authoredModelsBaseDir, 'llama.cpp', 'bin', 'llama-server.exe')
  : ''
const authoredServerDir = authoredServerPath ? path.dirname(authoredServerPath) : ''

let mainWindow = null
let tray = null
let appIsQuitting = false
let firstHideNoticeShown = false
let serverChild = null
let stoppingServer = false
let runtimeStatus = {
  state: 'stopped',
  message: '服务未启动',
  pid: null,
  url: 'http://127.0.0.1:8080',
  startedAt: null,
}
let logs = { entries: [], filtered: 0, truncated: 0, dropped: 0 }
let serverLogChunkBuffers = createLogChunkBuffers()
const requestRegistry = createRequestRegistry()
// 见 loadConfig()：默认主题从「跟随系统」迁到「浅色」，只做一次。
let themeDefaultMigrated = false

// 数据根：永远是应用自己的目录。不再回退到原装安装目录 —— 那是「独立」的红线。
function defaultBaseDir() {
  return appOwnDir
}

// 从任意来源目录（含打包后的 asar 内虚拟路径）把文件拷到真实磁盘。
//
// 为什么不用 fs.cp：Electron 只为一部分 fs 调用打了 asar 补丁，
// fs.promises.cp 不在其中 —— 传 asar 里的路径它会当成不存在的真实路径而失败。
// readdirSync / readFileSync 是被补丁覆盖的，所以走「自己遍历 + 读 + 写」。
async function copyDirToDisk(sourceDir, destDir) {
  await mkdir(destDir, { recursive: true })
  let copied = 0
  for (const entry of readdirSync(sourceDir, { withFileTypes: true })) {
    const from = path.join(sourceDir, entry.name)
    const to = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      copied += await copyDirToDisk(from, to)
      continue
    }
    await writeFile(to, readFileSync(from))
    copied += 1
  }
  return copied
}

// 首次运行播种：把随包预设与（开发时的）原装配置一次性拷进自己的数据根，
// 之后运行期只认自己的目录，原装目录再也不会被读写。
async function ensureOwnDataRoot() {
  const base = defaultBaseDir()
  await mkdir(base, { recursive: true })
  const ownConfigPath = path.join(base, 'config.toml')
  const ownPresetDir = path.join(base, 'configs')

  if (legacyBaseDir && !existsSync(ownConfigPath) && existsSync(path.join(legacyBaseDir, 'config.toml'))) {
    await cp(path.join(legacyBaseDir, 'config.toml'), ownConfigPath)
    addLog('desktop', '首次运行：已导入默认配置')
  }
  // 判定条件是「不存在**或为空**」，而不是只看不存在。
  // 踩过的坑：原先先 mkdir 再拷贝，一旦拷贝失败（asar 路径就是这样），
  // 目录虽然空着却已经存在，下次启动直接跳过播种 —— 用户永久没有预设。
  const presetDirEmpty = !existsSync(ownPresetDir) || readdirSync(ownPresetDir).length === 0
  if (presetDirEmpty) {
    // 随包预设的来源。desktop/configs 是**精选内容**：发布版只放一个与硬件无关的
    // 示例预设（空路径 = 参数模板，套用时沿用用户自己的配置）。
    // 作者自用的那批预设已移到 dev/presets/（不在打包白名单里），不会再发给用户。
    //
    // 踩过的坑：做发布清洁化时把这一条来源整个删掉了，结果 desktop/configs 虽然打进包，
    // 却再也不会被播种 —— 示例预设根本没送到用户手里。
    const sources = [
      path.join(rootDir, 'desktop', 'configs'),
      legacyBaseDir ? path.join(legacyBaseDir, 'configs') : '',
    ].filter(Boolean)
    const source = sources.find(candidate => existsSync(candidate))
    if (source) {
      const copied = await copyDirToDisk(source, ownPresetDir)
      addLog('desktop', '首次运行：已导入默认预设')
    }
  }
}

function defaultConfigPath() {
  return path.join(defaultBaseDir(), 'config.toml')
}

function defaultLauncherPath() {
  return path.join(defaultBaseDir(), 'llama-server-launcher.exe')
}

function defaultStatePath() {
  return path.join(app.getPath('userData'), 'desktop-state.json')
}

function defaultConfig() {
  const quality = chatQualityDefaults('quality')
  return {
    launch_mode: 'direct',
    launcher_path: defaultLauncherPath(),
    config_path: defaultConfigPath(),
    llama_bin_dir: authoredServerDir,
    llama_server_path: authoredServerPath,
    model: '',
    mmproj: '',
    host: DEFAULT_HOST,
    port: 8080,
    ctx_size: 32768,
    n_predict: -1,
    n_gpu_layers: 99,
    chat_quality_mode: quality.chat_quality_mode,
    chat_template_kwargs: quality.chat_template_kwargs,
    request_timeout_ms: 600000,
    temp: quality.temp,
    top_k: quality.top_k,
    top_p: quality.top_p,
    min_p: quality.min_p,
    presence_penalty: quality.presence_penalty,
    repeat_penalty: quality.repeat_penalty,
    threads: '',
    threads_batch: '',
    batch_size: '',
    ubatch_size: '',
    // 原型「显存 & KV」「高级」两段的参数。
    // 每个 flag 都已用真实 --help 逐条核对
    // （llama.cpp build 10816 / KVMem 91 行 / PrismML 711 行）；
    // 引擎不认的由 ENGINE_DEFINITIONS.incompatibleParams + supportsFlag 拦掉。
    // 默认留空 = 不拼该 flag。这样既不改动既有命令行，
    // 也不会和用户在 extra_args 里手写的 -ctk/-ctv 重复（extra_args 拼在最后，本就该由它覆盖）。
    type_k: '',
    type_v: '',
    kv_out_size: '',
    rope_freq_base: '',
    mirostat: '',
    num_lora: '',
    lora_paths: '',
    // 原型「显存 & KV」「高级」两段的开关（均为布尔，sanitize 会按引擎置 false）。
    // 注意：原型的 logits_all 未实现 —— --logits-all 在 llama.cpp / KVMem / PrismML
    // 三个 build 的 --help 里都不存在（它本是 libllama 的 context 参数，不是 server flag）。
    flash_attn: false,
    no_perf: false,
    mlock: false,
    no_map: false,
    use_mmap: false,
    cpu_moe: false,
    n_cpu_moe: '',
    device: '',
    split_mode: 'layer',
    tensor_split: '',
    main_gpu: '',
    extra_args: '',
    show_thinking: true,
    expand_thinking: quality.expand_thinking,
    show_raw_output: false,
    theme_mode: 'light',
    chat_font: 'default',
    verbose: false,
    log_verbosity: '',
    webui: true,
    embeddings: false,
    continuous_batching: true,
  }
}

function parseQuantization(fileName) {
  const text = String(fileName || '')
  const match = text.match(/\.(q\d[^.]*)\.gguf$/i) || text.match(/\.(iq\d[^.]*)\.gguf$/i)
  return match?.[1]?.toUpperCase() || '未标注'
}

function parseParameterScale(fileName) {
  const match = String(fileName || '').match(/(\d+(?:\.\d+)?)B/i)
  return match ? `${match[1]}B` : '未标注'
}

function parseFamily(fileName) {
  return String(fileName || '')
    .replace(/\.gguf$/i, '')
    .replace(/\.(q\d[^.]*)$/i, '')
    .replace(/\.(iq\d[^.]*)$/i, '')
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(2800) })
    if (!response.ok) return null
    return await response.json()
  } catch {
    return null
  }
}

function humanParams(value) {
  const number = Number(value || 0)
  if (!Number.isFinite(number) || number <= 0) return ''
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(2)}B`
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(2)}M`
  return String(number)
}

function sendEvent(payload) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return
  }
  mainWindow.webContents.send('llama:event', payload)
}

function setStatus(next) {
  runtimeStatus = { ...runtimeStatus, ...next }
  sendEvent({ type: 'status', status: runtimeStatus })
  updateTrayMenu()
}

function logStats() {
  const { filtered, truncated, dropped } = logs
  return { filtered, truncated, dropped }
}

function addLog(source, chunk) {
  appendLogResult(processLogChunk(source, chunk))
}

function addBufferedLog(source, chunk) {
  appendLogResult(processBufferedLogChunk(serverLogChunkBuffers, source, chunk))
}

function flushServerLogBuffers() {
  for (const source of ['stdout', 'stderr']) {
    appendLogResult(flushLogChunkBuffer(serverLogChunkBuffers, source))
  }
}

function appendLogResult(result) {
  const entries = result.entries.map(entry => ({ ...entry, at: new Date().toISOString() }))
  logs = appendVisibleLogs({
    ...logs,
    filtered: logs.filtered + result.filtered,
    truncated: logs.truncated + result.truncated,
  }, entries, STORED_LOG_LIMIT)

  for (const entry of entries) {
    if (entry.line.includes('server is listening')) {
      setStatus({ state: 'running', message: '服务正在监听', pid: serverChild?.pid || null })
    }
    if (entry.line.toLowerCase().includes('error')) {
      setStatus({ message: entry.line })
    }
  }
  sendEvent({ type: 'logs', logs: logs.entries, logStats: logStats() })
}

function stripTomlComment(line) {
  let inString = false
  let escaped = false
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\') {
      escaped = true
      continue
    }
    if (char === '"') {
      inString = !inString
      continue
    }
    if (char === '#' && !inString) {
      return line.slice(0, index)
    }
  }
  return line
}

function parseTomlValue(value) {
  const text = value.trim()
  if (!text) {
    return ''
  }
  if (text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text)
    } catch {
      return text.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
  }
  if (text === 'true') {
    return true
  }
  if (text === 'false') {
    return false
  }
  if (/^[+-]?\d+$/.test(text)) {
    return Number.parseInt(text, 10)
  }
  if (/^[+-]?\d+\.\d+$/.test(text)) {
    return Number.parseFloat(text)
  }
  return text
}

function parseToml(raw) {
  const result = {}
  for (const originalLine of raw.split(/\r?\n/)) {
    const line = stripTomlComment(originalLine).trim()
    if (!line || line.startsWith('[')) {
      continue
    }
    const equalIndex = line.indexOf('=')
    if (equalIndex < 0) {
      continue
    }
    const key = line.slice(0, equalIndex).trim()
    const value = line.slice(equalIndex + 1)
    result[key] = parseTomlValue(value)
  }
  return result
}

function toNumber(value, fallback = '') {
  if (value === '' || value === null || value === undefined) {
    return fallback
  }
  const next = Number(value)
  return Number.isFinite(next) ? next : fallback
}

function normalizeConfig(values, state = {}) {
  const base = defaultConfig()
  const merged = { ...base, ...state, ...values }
  const launchMode = merged.launch_mode === 'launcher' ? 'launcher' : 'direct'
  // 引擎二进制目录：显式输入优先于继承值，避免预设声明的 KVMem 路径被默认 llama.cpp 目录覆盖。
  const llamaBinDir = resolveEngineBinDir({
    incomingServerPath: values.llama_server_path,
    incomingBinDir: values.llama_bin_dir,
    inheritedBinDir: merged.llama_bin_dir,
    inheritedServerPath: merged.llama_server_path,
    fallbackServerPath: base.llama_server_path,
  })
  // 文件名不能写死 'llama-server.exe'：KVMem 正牌引擎叫 llama-kvmem-server.exe，
  // 写死会把预设声明的可执行文件改写成一个不存在的路径（点启动就报找不到文件）。
  // 先沿用声明名，再拿目录真实清单校正，最后才退回通用默认名。
  let serverFileNames = []
  try {
    serverFileNames = readdirSync(llamaBinDir)
  } catch {
    // 目录不存在或无权限时留空数组：pickServerExecutable 会退回声明名。
  }
  const serverFileName = pickServerExecutable({
    declaredName: merged.llama_server_path,
    fileNames: serverFileNames,
  })
  return {
    ...merged,
    launch_mode: launchMode,
    llama_bin_dir: llamaBinDir,
    llama_server_path: path.join(llamaBinDir, serverFileName),
    port: toNumber(merged.port, base.port),
    ctx_size: toNumber(merged.ctx_size, base.ctx_size),
    n_predict: toNumber(merged.n_predict, base.n_predict),
    n_gpu_layers: toNumber(merged.n_gpu_layers, base.n_gpu_layers),
    chat_quality_mode: merged.chat_quality_mode === 'fast' ? 'fast' : 'quality',
    request_timeout_ms: toNumber(merged.request_timeout_ms, base.request_timeout_ms),
    temp: toNumber(merged.temp, base.temp),
    top_k: toNumber(merged.top_k, base.top_k),
    top_p: toNumber(merged.top_p, base.top_p),
    min_p: toNumber(merged.min_p, base.min_p),
    presence_penalty: toNumber(merged.presence_penalty, base.presence_penalty),
    log_verbosity: toNumber(merged.log_verbosity, base.log_verbosity),
    extra_args: String(merged.extra_args || ''),
    show_thinking: merged.show_thinking !== false,
    expand_thinking: Boolean(merged.expand_thinking),
    show_raw_output: Boolean(merged.show_raw_output),
    theme_mode: ['light', 'dark', 'system'].includes(merged.theme_mode) ? merged.theme_mode : 'light',
    chat_font: ['default', 'sans', 'system', 'readable'].includes(merged.chat_font) ? merged.chat_font : 'default',
    verbose: Boolean(merged.verbose),
    webui: Boolean(merged.webui),
    embeddings: Boolean(merged.embeddings),
    continuous_batching: Boolean(merged.continuous_batching),
    cpu_moe: Boolean(merged.cpu_moe),
  }
}

function tomlString(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

function optionalNumberLine(key, value) {
  if (value === '' || value === null || value === undefined) {
    return null
  }
  return `${key} = ${value}`
}

function buildToml(config, options = {}) {
  // 外观键属于用户偏好，不属于预设。
  // 原先这两行是无条件写的 —— 结果是 stripUiPreferences() 白做，
  // 每个预设文件里都带着作者的主题与字体。
  // 现在由调用方决定：写 config.toml 要包含，写预设不包含。
  const includeUiPreferences = options.includeUiPreferences !== false
  // 预设文件与 config.toml 是两种东西，表头不能共用：
  // 预设是用户会打开看的文件，写「# config.toml」会让人以为是程序主配置。
  const lines = options.presetHeader
    ? [
        '# Llama Rig 预设文件',
        '#',
        '# 这里只放参数。模型与引擎路径留空表示「沿用当前配置」，不会覆盖你已经选好的。',
        '',
      ]
    : [
        '# config.toml',
        '# Generated by Llama Rig.',
        '',
      ]
  lines.push(
    '# desktop launch mode: direct or launcher',
    `launch_mode = ${tomlString(config.launch_mode || 'direct')}`,
    '',
    '# llama-server.exe 的绝对路径',
    `llama_server_path = ${tomlString(config.llama_server_path)}`,
    '',
    '# 模型路径',
    `model = ${tomlString(config.model)}`,
  )

  if (config.mmproj) {
    lines.push('', '# 多模态投影文件', `mmproj = ${tomlString(config.mmproj)}`)
  } else {
    lines.push('', '# mmproj = "G:\\\\llama.cpp\\\\models\\\\your-model\\\\mmproj.gguf"')
  }

  lines.push(
    '',
    '# 服务器设置',
    `host = ${tomlString(config.host)}`,
    `port = ${config.port}`,
    '',
    '# 常用参数',
    `ctx_size = ${config.ctx_size}`,
    `n_predict = ${config.n_predict}`,
    `n_gpu_layers = ${config.n_gpu_layers}`,
    `request_timeout_ms = ${config.request_timeout_ms}`,
    '',
    '# 对话模板参数',
    `chat_quality_mode = ${tomlString(config.chat_quality_mode || 'quality')}`,
    `chat_template_kwargs = ${tomlString(config.chat_template_kwargs)}`,
    '',
    '# 采样设置',
    `temp = ${config.temp}`,
    `top_k = ${config.top_k}`,
    `top_p = ${config.top_p}`,
    `min_p = ${config.min_p}`,
    `presence_penalty = ${config.presence_penalty}`,
  )

  const repeatPenalty = optionalNumberLine('repeat_penalty', config.repeat_penalty)
  if (repeatPenalty) {
    lines.push(repeatPenalty)
  }

  lines.push('', '# 系统设置')
  for (const [key, value] of [
    ['threads', config.threads],
    ['threads_batch', config.threads_batch],
    ['batch_size', config.batch_size],
    ['ubatch_size', config.ubatch_size],
  ]) {
    const line = optionalNumberLine(key, value)
    lines.push(line || `# ${key} = `)
  }

  lines.push('', '# 混合专家模型设置')
  if (config.cpu_moe) {
    lines.push('cpu_moe = true')
  } else {
    lines.push('# cpu_moe = true')
  }
  const nCpuMoe = optionalNumberLine('n_cpu_moe', config.n_cpu_moe)
  lines.push(nCpuMoe || '# n_cpu_moe = 15')

  lines.push('', '# GPU 设置')
  if (config.device) {
    lines.push(`device = ${tomlString(config.device)}`)
  } else {
    lines.push('# device = ""')
  }
  if (config.split_mode) {
    lines.push(`split_mode = ${tomlString(config.split_mode)}`)
  }
  if (config.tensor_split) {
    lines.push(`tensor_split = ${tomlString(config.tensor_split)}`)
  } else {
    lines.push('# tensor_split = "3,1"')
  }
  const mainGpu = optionalNumberLine('main_gpu', config.main_gpu)
  lines.push(mainGpu || '# main_gpu = 0')

  lines.push('', '# KV 缓存与采样扩展（原型「显存 & KV」「高级」两段）')
  if (config.type_k) lines.push(`type_k = ${tomlString(config.type_k)}`)
  if (config.type_v) lines.push(`type_v = ${tomlString(config.type_v)}`)
  lines.push(optionalNumberLine('kv_out_size', config.kv_out_size) || '# kv_out_size = 4096')
  lines.push(optionalNumberLine('rope_freq_base', config.rope_freq_base) || '# rope_freq_base = 10000')
  lines.push(hasValue(config.mirostat) ? `mirostat = ${tomlString(config.mirostat)}` : '# mirostat = 0')
  lines.push(optionalNumberLine('num_lora', config.num_lora) || '# num_lora = 0')
  if (config.lora_paths) lines.push(`lora_paths = ${tomlString(config.lora_paths)}`)
  lines.push('', '# 开关（原型「显存 & KV」「高级」两段）')
  for (const key of ['flash_attn', 'no_perf', 'mlock', 'no_map', 'use_mmap']) {
    lines.push(`${key} = ${config[key] ? 'true' : 'false'}`)
  }

  lines.push(
    '',
    '# 日志与功能',
    `verbose = ${config.verbose ? 'true' : 'false'}`,
    optionalNumberLine('log_verbosity', config.log_verbosity) || '# log_verbosity = ',
    `webui = ${config.webui ? 'true' : 'false'}`,
    `embeddings = ${config.embeddings ? 'true' : 'false'}`,
    `continuous_batching = ${config.continuous_batching ? 'true' : 'false'}`,
    '',
    '# 额外 llama-server 参数，会追加到最终启动命令末尾',
    `extra_args = ${tomlString(config.extra_args)}`,
    `show_thinking = ${config.show_thinking ? 'true' : 'false'}`,
    `expand_thinking = ${config.expand_thinking ? 'true' : 'false'}`,
    `show_raw_output = ${config.show_raw_output ? 'true' : 'false'}`,
    ...(includeUiPreferences ? [
      `theme_mode = ${tomlString(config.theme_mode || 'light')}`,
      `chat_font = ${tomlString(config.chat_font || 'default')}`,
    ] : []),
    '',
  )

  return lines.join('\n')
}

async function readJson(filePath, fallback) {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw.replace(/^\uFEFF/, ''))
  } catch {
    return fallback
  }
}

async function writeDesktopState(config) {
  // 保留既有的迁移标记：已经迁过就一直是 true，否则本次加载若判定需要迁移就落盘。
  const existing = themeDefaultMigrated ? true : (await readJson(defaultStatePath(), {})).theme_default_migrated === true
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(
    defaultStatePath(),
    JSON.stringify(
      {
        config_path: config.config_path,
        launch_mode: config.launch_mode,
        launcher_path: config.launcher_path,
        theme_default_migrated: existing || themeDefaultMigrated,
        config,
      },
      null,
      2,
    ),
    'utf8',
  )
}

async function loadConfig() {
  const state = await readJson(defaultStatePath(), {})
  const configPath = state.config_path || defaultConfigPath()
  let parsed = {}
  if (existsSync(configPath)) {
    try {
    parsed = parseToml(await readFile(configPath, 'utf8'))
    } catch (error) {
      addLog('desktop', `读取配置失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // 一次性把旧的默认「跟随系统」迁到「浅色」。
  // 旧版本默认值是 system，在深色 Windows 上首次打开就是深色，而深色此前
  // 问题最多。只在没迁过、且当前值恰好是旧默认 system 时改一次；
  // 用户之后主动选「跟随系统」会被 theme_default_migrated 记住，不再被改回去。
  const rawTheme = { ...parsed, ...(state.config || {}) }.theme_mode
  const needsThemeMigration = !state.theme_default_migrated && (rawTheme === undefined || rawTheme === 'system')
  const config = normalizeConfig({ ...parsed, ...(state.config || {}) }, {
    config_path: configPath,
    launch_mode: state.launch_mode || state.config?.launch_mode || parsed.launch_mode || 'direct',
    launcher_path: state.launcher_path || defaultLauncherPath(),
  })
  runtimeStatus.url = localUrl(config)
  if (needsThemeMigration) {
    config.theme_mode = 'light'
    themeDefaultMigrated = true
    addLog('desktop', '外观：默认主题已从「跟随系统」改为「浅色」（一次性迁移，可在设置→外观里改回）')
  }
  return config
}

async function saveConfig(config) {
  const normalized = sanitizeEngineParams(normalizeConfig(config))
  if (normalized.launch_mode === 'launcher') {
    await mkdir(path.dirname(normalized.config_path), { recursive: true })
    await writeFile(normalized.config_path, buildToml(normalized), 'utf8')
  }
  await writeDesktopState(normalized)
  runtimeStatus.url = localUrl(normalized)
  return normalized
}


// ============================================================
// P0-1: 预设管理 & P0-2: 引擎切换 & P1-2: 显存守卫 & P2-2: 元信息
// ============================================================

const PRESET_DIR_NAME = 'configs'

function presetBaseDir() {
  return path.join(defaultBaseDir(), PRESET_DIR_NAME)
}

function presetFilePath(name) {
  return path.join(presetBaseDir(), presetFileName(name))
}

function listPresets() {
  const presetDir = presetBaseDir()
  if (!existsSync(presetDir)) return []
  return listPresetNamesFromFiles(readdirSync(presetDir))
}

async function readPreset(name) {
  const filePath = presetFilePath(name)
  if (!existsSync(filePath)) return null
  const raw = await readFile(filePath, 'utf8')
  const parsed = parseToml(raw)
  // 三件事，顺序不能乱：
  //   1. normalizeConfig 按「完整配置」补齐各项（含**非空**的默认路径）
  //   2. sanitizeEngineParams / stripUiPreferences 兜底引擎开关、剔除外观键
  //   3. restoreEmptyPathFields 把「文件里留空」的路径还原为空
  // 少了第 3 步，「预设里留空 = 沿用当前」就会失效：第 1 步补出来的默认
  // 路径会让 applyPresetOverCurrent 以为预设声明了路径，从而覆盖用户的引擎。
  return restoreEmptyPathFields(
    stripUiPreferences(sanitizeEngineParams(normalizeConfig(parsed))),
    parsed,
  )
}

async function writePreset(name, config) {
  await mkdir(presetBaseDir(), { recursive: true })
  // 唯一落盘入口，在此兜底：预设文件永远不含外观键。
  await writeFile(presetFilePath(name), buildToml(stripUiPreferences(config), { includeUiPreferences: false, presetHeader: true }), 'utf8')
  return { success: true, path: presetFilePath(name) }
}

async function deletePreset(name) {
  const filePath = presetFilePath(name)
  if (!existsSync(filePath)) return { success: false, error: '预设文件不存在' }
  const { unlink } = await import('node:fs/promises')
  await unlink(filePath)
  return { success: true, path: filePath }
}

// 引擎二进制所在根目录。启动器目录与它不同层，因此单独解析并允许布局变化。
function modelsBaseDir() {
  // 后两条是**相对约定**（在应用自己目录、或其上一级找 00_models_Base），不是开发机绝对路径：
  // 用户按便携版布局把引擎包放在 exe 旁边时就能找到。新用户没有这个目录只是不匹配，
  // 不会指向任何不存在的位置。
  // 过滤空串：path.join('') 会退化成相对路径，拿去做 existsSync 是假阳性来源。
  return pickExistingDir([
    authoredModelsBaseDir,
    path.join(defaultBaseDir(), '00_models_Base'),
    path.join(defaultBaseDir(), '..', '00_models_Base'),
  ].filter(Boolean), candidate => existsSync(candidate))
}

// 引擎定义与规则判断在 lib/preset-engine.mjs，这里只负责把它拼成磁盘上的真实路径。
function resolveEnginePaths() {
  const modelsBase = modelsBaseDir()
  const defined = ENGINE_DEFINITIONS.map(engine => {
    const candidate = path.join(modelsBase, ...engine.binary)
    return { ...engine, path: existsSync(candidate) ? candidate : '' }
  })
  // 固定位置没找到的引擎，用扫描结果补上。
  // 扫描出错（权限、盘符消失等）不能拖垮这里，最差退回原来的固定布局行为。
  try {
    return mergeDiscoveredEngines(defined, discoverEngines())
  } catch {
    return defined
  }
}

// ---------- 引擎发现 ----------
//
// 引擎原先只认 modelsBaseDir 下的固定相对位置（llama.cpp\bin\、kvmem-gui\、prism-llama\），
// 放到别处就显示「未安装」并禁用 —— 用户明明有引擎，却因为摆放位置不同而选不了。
// 这里照模型的思路改成**扫出来**：找到就填进列表，用户还能手动指定。
//
// 深度与目录数都设上限：引擎常散落在几个盘上，扫全盘会卡住启动。
const ENGINE_SCAN_MAX_DEPTH = 3
const ENGINE_SCAN_MAX_DIRS = 600

// 磁盘根目录的兜底扫描深度。
// 比精确根浅一档：盘符下面什么都可能有，扫深了又慢又没意义，
// 但 3 层足够覆盖 D:llama.cppinllama-server.exe 这种常见摆法。
const ENGINE_DRIVE_SCAN_MAX_DEPTH = 2
// 每个盘符**独立**的目录预算。
// 实测结论：原本所有盘共用一个 600 的预算，结果全被 C:/D: 的大目录树吃光，
// 引擎所在的盘一个目录都没轮到 —— 扫描「成功」却找到 0 个。
// 每个盘各给一份，才能保证每个盘都被看一眼。
const ENGINE_DRIVE_SCAN_MAX_DIRS = 250

function scanEngineFiles(
  root,
  depth = 0,
  out = [],
  budget = { dirs: 0, limit: ENGINE_SCAN_MAX_DIRS },
  maxDepth = ENGINE_SCAN_MAX_DEPTH,
) {
  if (!root || depth > maxDepth) return out
  if (budget.dirs >= budget.limit) return out
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  budget.dirs += 1
  for (const entry of entries) {
    if (budget.dirs >= budget.limit) break
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      const name = entry.name.toLowerCase()
      // 同样的跳过表：引擎不会正经放在 Users / Downloads / node_modules 里。
      if (entry.name.startsWith('.') || name === 'node_modules' || SCAN_STOP_DIRS.has(name)) continue
      scanEngineFiles(full, depth + 1, out, budget, maxDepth)
    } else if (isEngineServerFile(entry.name)) {
      out.push(full)
    }
  }
  return out
}

// 扫描结果缓存：engine-list 在每次渲染时都可能被调用，不能每次都遍历磁盘。
// 用户点「重新扫描」时清掉。
let engineScanCache = null

// 从**磁盘上的配置**里取「引擎基目录」，用作扫描根。
//
// 为什么要它：引擎通常是并排放在同一个基目录下的 ——
//   00_models_Base\
//     llama.cpp\bin\llama-server.exe
//     kvmem-gui\llama-server.exe
//     prism-llama\llama-server.exe
// 所以「用户正在用的那个引擎」的上一级，是最可能找齐其他引擎的地方。
// 程序目录附近未必有引擎：用户完全可以把它放在另一个盘上。
function engineBaseDirFromConfig() {
  const serverPath = String(currentConfigFromDisk().llama_server_path || '').trim()
  if (!serverPath) return ''
  // …\00_models_Base\kvmem-gui\llama-server.exe → …\00_models_Base
  return path.dirname(path.dirname(serverPath))
}

// 读磁盘上的当前配置：扫描根与引擎推荐都要用它。
// 渲染进程里还没保存的改动这里拿不到，但不影响 —— 配置一保存就同步了。
function currentConfigFromDisk() {
  try {
    const statePath = defaultStatePath()
    if (!existsSync(statePath)) return {}
    const desktopState = JSON.parse(readFileSync(statePath, 'utf8').replace(/^\uFEFF/, ''))
    const configPath = desktopState.config_path || defaultConfigPath()
    if (!existsSync(configPath)) return {}
    return parseToml(readFileSync(configPath, 'utf8'))
  } catch {
    return {}
  }
}

// 按模型推荐引擎 —— 让普通用户不必先懂引擎。
//
// 规则本身在 lib/preset-engine.mjs（和引擎定义放在一起，是纯函数、有测试）。
// 这里只负责把磁盘上的模型路径喂进去。
function recommendedEngineId() {
  const modelPath = String(currentConfigFromDisk().model || '')
  // classifyModelType 只看文件名，所以先取 basename。
  return recommendEngineIdForModel(path.basename(modelPath))
}

// 落地的推荐：只返回**真的扫到了**的那个。
// 扫不到就返回 null —— 让界面继续提示「手动指定」，
// 而不是推荐一个不存在的路径（那会让用户点了启动才发现跑不起来）。
function recommendEnginePath(discovered = []) {
  return pickRecommendedEngine(recommendedEngineId(), discovered)
}

// 从**用户自己的预设文件**里收集引擎基目录。
//
// 这是最贴近实际的一条线索：用户可能一次都没点过「保存」，所以没有 config.toml，
// 但预设文件一定是他自己存下来的，里面就写着用过的引擎路径。
// 引擎通常并排放在同一个基目录下（llama.cpp\、kvmem-gui\、prism-llama\），
// 所以拿到任意一个，就能把其余的找齐。
function engineBaseDirsFromPresets(limit = 5) {
  const roots = []
  try {
    for (const name of listPresets().slice(0, limit)) {
      const filePath = presetFilePath(name)
      if (!existsSync(filePath)) continue
      const serverPath = String(parseToml(readFileSync(filePath, 'utf8')).llama_server_path || '').trim()
      if (!serverPath) continue
      // …\00_models_Base\kvmem-gui\llama-server.exe → …\00_models_Base
      roots.push(path.dirname(path.dirname(serverPath)))
    }
  } catch {
    // 预设读不动不影响扫描：其余扫描根照常用。
  }
  return roots
}

// 本机的固定磁盘。用于「新用户会把引擎放在哪」这类零配置猜测：
// 很多人就是把 llama.cpp 解压在 D:\ 或 E:\ 下面，程序目录和预设里都没有线索。
// 逐个探测盘符比调用 WMI 便宜得多，26 次 existsSync 可以忽略。
function listFixedDrives() {
  const drives = []
  for (let code = 67; code <= 90; code += 1) { // C..Z，跳过 A/B 软驱
    const root = `${String.fromCharCode(code)}:\\`
    if (existsSync(root)) drives.push(root)
  }
  return drives
}

function discoverEngines({ force = false, currentServerPath = '', searchDir = '' } = {}) {
  if (!force && engineScanCache) return engineScanCache
  const base = defaultBaseDir()
  // 界面上还没保存的路径也算一个根：用户刚选完一个引擎、还没点保存时，
  // 就该能扫到它的兄弟引擎。
  const hint = String(currentServerPath || '').trim()
  const hintBase = hint ? path.dirname(path.dirname(hint)) : ''
  // 用户亲手指过的那一级 —— 优先，且给它更深的深度。
  const pointed = String(searchDir || '').trim() || String(currentConfigFromDisk().engine_search_dir || '').trim()

  // 1) 精确根：深扫（这些位置一定是用户放东西的地方）
  const deepRoots = [...new Set([
    base,
    path.join(base, '..'),
    modelsBaseDir(),
    authoredModelsBaseDir,
    engineBaseDirFromConfig(),
    ...engineBaseDirsFromPresets(),
    hintBase,
    pointed,
    pointed ? path.dirname(pointed) : '',
  ].filter(Boolean))]

  const files = []
  // 深层扫描共用一个预算：这些是「一定值得细看」的位置，让先来的先扫。
  const budget = { dirs: 0, limit: ENGINE_SCAN_MAX_DIRS }
  for (const root of deepRoots) {
    if (budget.dirs >= budget.limit) break
    scanEngineFiles(root, 0, files, budget)
  }

  // 2) 兜底：各磁盘根目录，只扫浅层。
  // 新用户没有任何历史线索时，这是唯一能「零配置找到」的机会：
  // D:\llama.cpp\bin\llama-server.exe 这种摆法很常见。
  // 只有前面的精确根一个都没找到时才走这里 —— 否则白扫一遍盘。
  if (!files.length) {
    // 程序所在盘优先：引擎放在程序附近的概率最高，先看它。
    const appDrive = path.parse(base).root
    const drives = [...new Set([appDrive, ...listFixedDrives()].filter(Boolean))].slice(0, 5)
    for (const drive of drives) {
      // 每个盘一份**新**预算。共用一份会被 C:/D: 的大目录树吃光，
      // 引擎所在的盘一个目录都轮不到（实测过：600 个预算全花在别的盘上，找到 0 个）。
      scanEngineFiles(
        drive,
        0,
        files,
        { dirs: 0, limit: ENGINE_DRIVE_SCAN_MAX_DIRS },
        ENGINE_DRIVE_SCAN_MAX_DEPTH,
      )
    }
  }

  engineScanCache = rankEngineCandidates(
    files.map(filePath => engineCandidateFromFile({ filePath })).filter(Boolean),
  )
  return engineScanCache
}

// 本地模型清单：给顶栏「模型」折叠菜单用。
// 以前的顶栏放的是「硬件推荐」，它只是把 CPU/内存复述一遍，点开也没有任何可执行动作，
// 属于占位控件。换成真正有信息量的东西：当前预设对应的模型文件 + 本机全部本地模型。
// 扫描范围按「谁最可能有 gguf」排序，深度与数量都设上限，避免扫全盘卡住启动。
const MODEL_SCAN_MAX_DEPTH = 4
const MODEL_SCAN_MAX_FILES = 400

// 从模型目录往上找扫描根时，遇到这些目录就停。
// 扫 C:\Users 或 Downloads 这种地方既慢又没意义（模型不会正经存在那儿）。
const SCAN_STOP_DIRS = new Set([
  'users', 'windows', 'program files', 'program files (x86)',
  'programdata', 'appdata', 'downloads', 'desktop', 'documents', 'onedrive',
])

function scanGgufFiles(root, depth = 0, out = []) {
  if (!root || depth > MODEL_SCAN_MAX_DEPTH || out.length >= MODEL_SCAN_MAX_FILES) return out
  let entries = []
  try {
    entries = readdirSync(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (out.length >= MODEL_SCAN_MAX_FILES) break
    const full = path.join(root, entry.name)
    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      scanGgufFiles(full, depth + 1, out)
    } else if (/\.gguf$/i.test(entry.name)) {
      // mmproj 是视觉投影文件，不是可独立加载的对话模型，列出来只会让人误选。
      if (/^mmproj/i.test(entry.name)) continue
      out.push(full)
    }
  }
  return out
}

// 扫描 + 组装（需要当前配置里的模型路径，所以是异步的）。
async function collectLocalModels() {
  const config = await loadConfig()
  const roots = []
  const addRoot = dir => {
    if (dir && existsSync(dir) && !roots.includes(dir)) roots.push(dir)
  }
  // 扫描根按「最可能有 gguf」排序。
  // 关键一条：从当前模型目录往上的若干层。
  // 用户通常按家族分目录存模型（…/01_models/qwen3.5/xxx.gguf），
  // 只看模型自己那一层，切到别的家族就找不到模型了；往上走三层才够到模型总库。
  //
  // 但「往上三层」不能无脑走：模型放在 C:\Users\me\Downloads 时，
  // 再往上就是 C:\Users —— 扫那里既慢又没意义。所以遇到
  // 盘符根与常见系统目录就停。深度(4 层)与文件数(400)在 scanGgufFiles 里另有上限。
  if (config.model) {
    let dir = path.dirname(config.model)
    for (let up = 0; up < 3 && dir; up++) {
      addRoot(dir)
      const parent = path.dirname(dir)
      if (!parent || parent === dir) break
      if (/^[a-z]:[\\/]?$/i.test(parent)) break
      if (SCAN_STOP_DIRS.has(path.basename(parent).toLowerCase())) break
      dir = parent
    }
  }
  if (process.env.LLAMA_MODELS_DIR) addRoot(process.env.LLAMA_MODELS_DIR)
  // 开发机便利（只有在显式设了 LLAMA_RIG_DEV_BASE 时才存在）
  if (authoredModelsBaseDir) {
    addRoot(path.join(path.dirname(authoredModelsBaseDir), '01_models'))
    addRoot(authoredModelsBaseDir)
  }

  const seen = new Set()
  const models = []
  for (const root of roots) {
    for (const file of scanGgufFiles(root)) {
      const key = file.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      let sizeBytes = 0
      try {
        sizeBytes = statSync(file).size
      } catch {}
      const base = path.basename(file)
      models.push({
        name: base,
        label: base.replace(/\.gguf$/i, ''),
        path: file,
        dir: path.dirname(file),
        folder: path.basename(path.dirname(file)),
        sizeGB: sizeBytes ? Math.round((sizeBytes / 1024 / 1024 / 1024) * 100) / 100 : 0,
        quant: (base.match(/\.(q\d[^.]*|iq\d[^.]*)\.gguf$/i) || [])[1]?.toUpperCase() || '',
        current: path.resolve(file) === path.resolve(config.model || ''),
      })
    }
  }
  models.sort((a, b) => a.label.localeCompare(b.label, 'zh-Hans-CN'))
  return { models, scannedRoots: roots, currentModel: config.model || '' }
}

// 只读文件开头的若干 MB 来解析 GGUF 元数据。
// 一个 20 GB 的模型不可能整读进来 —— 我们要的键（架构/层数/上下文/KV 头数）
// 都在头部最前面，读 4 MB 足够；读不到就退化成「未知」，由上层降级处理。
const GGUF_HEADER_BYTES = 4 * 1024 * 1024

async function readGgufMetadata(modelPath) {
  const filePath = String(modelPath || '')
  if (!filePath || !existsSync(filePath)) return { ok: false, error: 'file not found' }
  let handle = null
  try {
    const { open, stat } = await import('node:fs/promises')
    const info = await stat(filePath)
    handle = await open(filePath, 'r')
    const length = Math.min(GGUF_HEADER_BYTES, info.size)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, 0)
    const meta = parseGgufMetadata(buffer)
    return { ...meta, fileSizeBytes: info.size }
  } catch (error) {
    return { ok: false, error: error?.message || String(error) }
  } finally {
    if (handle) await handle.close().catch(() => {})
  }
}

async function getVramUsage() {
  if (process.platform !== 'win32') return vramSnapshot({ total: 0, used: 0 })
  // 测试缝：真机显存充足时「显存不足」拦截路径无法自然触发，
  // 用 LLAMA_DESKTOP_FORCE_LOW_VRAM=1 强制返回一份低可用显存的读数，
  // 以便端到端验证验收 #9 的弹窗与「仍然启动/取消」两个分支。
  if (process.env.LLAMA_DESKTOP_FORCE_LOW_VRAM) {
    return vramSnapshot({ total: 8151, used: 7800 })
  }
  // 直接调用 nvidia-smi —— 不再套一层 PowerShell 单行脚本。
  // 旧实现在 PowerShell 里做 split/Trim/JSON，任何一处（引号转义、`$_ .Trim()`
  // 里多出来的空格、非英文区域设置）出错都会静默返回 {total:0,used:0}，
  // 底部状态栏于是只剩 RAM、永远看不到显存。改成读原始 stdout 自己解析 CSV：
  //   8151, 7842
  // nvidia-smi 装在默认位置时可能不在 PATH，因此按常见路径逐个回退。
  const candidates = [
    'nvidia-smi',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe'),
    path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'nvidia-smi.exe'),
  ]
  let lastError = ''
  for (const exe of candidates) {
    try {
      const { stdout } = await execFileAsync(
        exe,
        ['--query-gpu=memory.total,memory.used', '--format=csv,noheader,nounits'],
        { windowsHide: true, timeout: 5000 },
      )
      // 多卡时一行一张卡，这里取第一张（与 llama.cpp 默认 cuda0 对齐）。
      const line = String(stdout || '').split(/\r?\n/).map(s => s.trim()).find(Boolean)
      if (!line) continue
      const [totalRaw, usedRaw] = line.split(',').map(s => s.trim())
      const total = Number.parseInt(totalRaw, 10)
      const used = Number.parseInt(usedRaw, 10)
      if (!Number.isFinite(total) || total <= 0) continue
      return vramSnapshot({ total, used: Number.isFinite(used) ? used : 0 })
    } catch (error) {
      lastError = error?.message || String(error)
    }
  }
  return { ...vramSnapshot({ total: 0, used: 0 }), error: lastError || 'nvidia-smi unavailable' }
}





function localUrl(config) {
  return serviceUrls(config).localBaseUrl
}

async function runPowerShellJson(script, fallback) {
  if (process.platform !== 'win32') return fallback
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
    ], { windowsHide: true, timeout: 5000 })
    const text = String(stdout || '').trim()
    return text ? JSON.parse(text) : fallback
  } catch {
    return fallback
  }
}

async function getGpuInfo() {
  const script = [
    '$items = Get-CimInstance Win32_VideoController | Select-Object Name, AdapterRAM',
    '$items | ConvertTo-Json -Compress',
  ].join('; ')
  const raw = await runPowerShellJson(script, [])
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  return list.map(item => ({
    name: String(item.Name || 'GPU'),
    adapterRAMGB: item.AdapterRAM ? Math.round((Number(item.AdapterRAM) / 1024 / 1024 / 1024) * 10) / 10 : 0,
  }))
}

function canBindPort(port) {
  return new Promise(resolve => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

async function suggestedPort(startPort) {
  for (let port = startPort + 1; port < startPort + 40; port += 1) {
    if (await canBindPort(port)) return port
  }
  return startPort + 1
}

async function inspectPort(port) {
  const targetPort = Number(port) || 8080
  const script = [
    `$connections = Get-NetTCPConnection -LocalPort ${targetPort} -ErrorAction SilentlyContinue`,
    '$items = foreach ($connection in $connections) {',
    '  $process = Get-Process -Id $connection.OwningProcess -ErrorAction SilentlyContinue',
    '  [pscustomobject]@{ pid = $connection.OwningProcess; name = $process.ProcessName; state = $connection.State; localAddress = $connection.LocalAddress }',
    '}',
    '$items | ConvertTo-Json -Compress',
  ].join('; ')
  const raw = await runPowerShellJson(script, [])
  const processes = (Array.isArray(raw) ? raw : raw ? [raw] : [])
    .filter(item => item?.pid)
    .map(item => ({
      pid: Number(item.pid),
      name: String(item.name || 'unknown'),
      state: String(item.state || ''),
      localAddress: String(item.localAddress || ''),
    }))
  const occupied = processes.length > 0 || !(await canBindPort(targetPort))
  return {
    checked: true,
    port: targetPort,
    occupied,
    processes,
    suggestedPort: occupied ? await suggestedPort(targetPort) : targetPort,
  }
}

function hasValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== ''
}

function pushArg(args, flag, value) {
  if (hasValue(value)) {
    args.push(flag, String(value))
  }
}

// 0 / 空 都算「没设」——用于 kv_out_size、rope_freq_base 这类 0 = 不设 的数值参数。
function positiveNumber(value) {
  const n = Number(value)
  return Number.isFinite(n) && n > 0 ? String(n) : ''
}

// num_lora 决定加载几个 LoRA：从 lora_paths（逗号或换行分隔）按顺序取前 N 个。
function loraPathsForConfig(config) {
  const count = Number(config.num_lora)
  if (!Number.isFinite(count) || count <= 0) return []
  return String(config.lora_paths || '')
    .split(/[,\n]/)
    .map(item => item.trim())
    .filter(Boolean)
    .slice(0, count)
}

function buildServerArgs(config) {
  assertNoCoreArgConflicts(config.extra_args)

  // 修 #1：引擎兼容性检查 —— 把引擎不支持的开关直接拦在预览阶段，
  // 而不是等到启动时才崩。这样 preview error 能提前告诉用户。
  const engineId = detectEngineByPath(config.llama_server_path)
  assertEngineCompatible(engineId, config)

  // 每个可选开关都必须先问引擎认不认 —— 不认的直接不拼。
  const supportsFlag = flag => engineSupportsFlag(engineId, flag)
  const args = []
  pushArg(args, '--model', config.model)
  pushArg(args, '--mmproj', config.mmproj)
  pushArg(args, '--host', config.host)
  pushArg(args, '--port', config.port)
  pushArg(args, '--ctx-size', config.ctx_size)
  pushArg(args, '--n-predict', config.n_predict)
  pushArg(args, '--n-gpu-layers', config.n_gpu_layers)
  pushArg(args, '--chat-template-kwargs', normalizeChatTemplateKwargsText(config.chat_template_kwargs))
  pushArg(args, '--temp', config.temp)
  pushArg(args, '--top-k', config.top_k)
  pushArg(args, '--top-p', config.top_p)
  pushArg(args, '--min-p', config.min_p)
  pushArg(args, '--presence-penalty', config.presence_penalty)
  pushArg(args, '--repeat-penalty', config.repeat_penalty)
  pushArg(args, '--threads', config.threads)
  pushArg(args, '--threads-batch', config.threads_batch)
  pushArg(args, '--batch-size', config.batch_size)
  pushArg(args, '--ubatch-size', config.ubatch_size)
  pushArg(args, '--device', config.device)
  pushArg(args, '--split-mode', config.split_mode)
  pushArg(args, '--tensor-split', config.tensor_split)
  pushArg(args, '--main-gpu', config.main_gpu)

  // 原型「显存 & KV」「高级」两段的参数：每个都必须先问引擎认不认。
  if (supportsFlag('--cache-type-k')) pushArg(args, '--cache-type-k', config.type_k)
  if (supportsFlag('--cache-type-v')) pushArg(args, '--cache-type-v', config.type_v)
  if (supportsFlag('--kv-unified-per-slot')) pushArg(args, '--kv-unified-per-slot', positiveNumber(config.kv_out_size))
  if (supportsFlag('--rope-freq-base')) pushArg(args, '--rope-freq-base', positiveNumber(config.rope_freq_base))
  if (supportsFlag('--mirostat')) pushArg(args, '--mirostat', config.mirostat)
  if (supportsFlag('--lora')) {
    // num_lora = 从 lora_paths 按顺序取前 N 个；0 或空 = 不加载。
    const loras = loraPathsForConfig(config)
    if (loras.length) args.push('--lora', loras.join(','))
  }
  // flash-attn 是带值开关（on|off|auto）：开 = 强制 on；关 = 不传，交给引擎 auto。
  // 这样默认不改变既有命令行行为。
  if (config.flash_attn && supportsFlag('--flash-attn')) args.push('--flash-attn', 'on')
  if (config.no_perf && supportsFlag('--no-perf')) args.push('--no-perf')
  // mlock / mmap 在本 build 已标 DEPRECATED（推荐 --load-mode），但仍可用。
  // no_map 与 use_mmap 互为反义，必须互斥，否则会同时拼出 --mmap 与 --no-mmap。
  if (config.no_map && supportsFlag('--no-mmap')) args.push('--no-mmap')
  else if (config.use_mmap && supportsFlag('--mmap')) args.push('--mmap')
  if (config.mlock && supportsFlag('--mlock')) args.push('--mlock')
  if (supportsFlag('--n-cpu-moe')) {
    pushArg(args, '--n-cpu-moe', config.n_cpu_moe)
    if (config.cpu_moe) args.push('--cpu-moe')
  }
  pushArg(args, '--log-verbosity', config.log_verbosity)

  if (supportsFlag('--verbose') && config.verbose) args.push('--verbose')
  args.push(config.webui ? '--webui' : '--no-webui')
  if (supportsFlag('--embeddings') && config.embeddings) args.push('--embeddings')
  // 取反形式同样要按引擎能力判断：KVMem 连 --no-cont-batching 都不认，
  // 而改造版恰好用「关掉 continuous_batching」来表达 KVMem 不支持它 —— 于是必崩。
  if (supportsFlag('--cont-batching')) {
    args.push(config.continuous_batching ? '--cont-batching' : '--no-cont-batching')
  }
  args.push(...splitExtraArgs(config.extra_args))

  return args
}

// 引擎 help 文本按可执行文件路径缓存一次；启动前校验和界面预览共用。
const engineHelpCache = new Map()

async function engineHelpText(enginePath) {
  const key = String(enginePath || '')
  if (!key) return ''
  if (engineHelpCache.has(key)) return engineHelpCache.get(key)
  let text = ''
  try {
    const { stdout, stderr } = await execFileAsync(key, ['--help'], {
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 8 * 1024 * 1024,
    })
    text = `${stdout || ''}\n${stderr || ''}`
  } catch (error) {
    // 不少引擎把 help 打到 stderr 并以非 0 退出，内容仍然可用。
    text = `${error?.stdout || ''}\n${error?.stderr || ''}`
  }
  engineHelpCache.set(key, text)
  return text
}

// 启动前的附加参数校验：拿 extra_args 里的每个开关去问引擎自己的 --help。
// 目标是把「点了没反应、日志一片空白」变成「明确告诉你是哪个参数不被认识」。
async function assertExtraArgsSupported(config) {
  const tokens = splitExtraArgs(config.extra_args)
  if (!tokens.length) return
  const helpText = await engineHelpText(config.llama_server_path)
  if (!helpText) return
  const unknown = unknownExtraFlags(tokens, helpText)
  if (unknown.length) {
    throw new Error(describeUnknownFlags(unknown))
  }
}

function quoteCommandPart(value) {
  const text = String(value || '')
  if (!text) {
    return '""'
  }
  return /[\s"]/u.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text
}

function buildLaunchDetails(config) {
  const directMode = config.launch_mode !== 'launcher'
  const command = directMode ? config.llama_server_path : config.launcher_path
  try {
    const args = directMode ? buildServerArgs(config) : []
    return {
      mode: directMode ? 'direct' : 'launcher',
      command,
      args,
      cwd: directMode ? path.dirname(config.llama_server_path) : path.dirname(config.config_path),
      preview: [command, ...args].map(quoteCommandPart).join(' '),
      error: '',
    }
  } catch (error) {
    return {
      mode: directMode ? 'direct' : 'launcher',
      command,
      args: [],
      cwd: directMode ? path.dirname(config.llama_server_path) : path.dirname(config.config_path),
      preview: quoteCommandPart(command),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function stripWrappingQuotes(text) {
  const value = String(text || '').trim()
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).trim()
    }
  }
  return value
}

function normalizeChatTemplateKwargsText(raw) {
  let text = stripWrappingQuotes(raw)
  if (!text) {
    return ''
  }
  text = text.replace(/^--chat-template-kwargs\s+/i, '').trim()
  text = stripWrappingQuotes(text)
  if (text.includes('\\"')) {
    text = text.replace(/\\"/g, '"')
  }
  return text
}

function prepareChatMessages(rawMessages) {
  const messages = []

  for (const message of Array.isArray(rawMessages) ? rawMessages : []) {
    if (!message || message.localOnly) continue
    if (!['user', 'assistant', 'system'].includes(message.role)) continue

    const text = String(message.content || '')
    const attachments = Array.isArray(message.attachments) ? message.attachments : []
    const textBlocks = attachments
      .filter(item => item.kind === 'text' && item.text)
      .map(item => `\n\n--- Attachment: ${item.name} ---\n${item.text}`)
    const fileBlocks = attachments
      .filter(item => item.kind !== 'text' && item.kind !== 'image')
      .map(item => `\n\n[Attachment: ${item.name}; ${item.mime || 'file'}; ${item.path ? `path: ${item.path}` : 'embedded drag-and-drop file'}]`)
    const imageAttachments = attachments.filter(item => item.kind === 'image' && item.dataUrl)
    const mergedText = `${text}${textBlocks.join('')}${fileBlocks.join('')}`.trim()

    let next
    if (imageAttachments.length > 0) {
      next = {
        role: message.role,
        content: [
          {
            type: 'text',
            text: mergedText || 'Please analyze these images.',
          },
          ...imageAttachments.map(item => ({
            type: 'image_url',
            image_url: { url: item.dataUrl },
          })),
        ],
      }
    } else {
      next = {
        role: message.role,
        content: mergedText,
      }
    }

    if (!Array.isArray(next.content) && !String(next.content || '').trim()) continue
    messages.push(next)
  }

  return messages
}

function runtimePackageInfo(config) {
  const serverDir = path.dirname(String(config.llama_server_path || ''))
  const info = {
    serverDir,
    serverDirExists: existsSync(serverDir),
    runtimePackageKind: 'unknown',
    runtimeFiles: [],
    runtimeIssues: [],
    runtimeCapabilities: {
      hasServer: false,
      hasCudaRuntime: false,
      hasLlamaDll: false,
    },
  }

  if (!info.serverDirExists) {
    return info
  }

  try {
    const filesAll = readdirSync(serverDir, { withFileTypes: true })
      .filter(entry => entry.isFile())
      .map(entry => entry.name)
    const lower = filesAll.map(file => file.toLowerCase())
    const files = filesAll.slice(0, 80)
    const hasConfiguredServer = existsSync(String(config.llama_server_path || ''))
    const hasServer = hasConfiguredServer || lower.includes('llama-server.exe')
    const hasCudaRuntime = lower.some(file => /^cudart.*\.dll$/.test(file) || /^cublas.*\.dll$/.test(file))
    const hasLlamaDll = lower.some(file => /^llama.*\.dll$/.test(file) || /^ggml.*\.dll$/.test(file))
    info.runtimeCapabilities = { hasServer, hasCudaRuntime, hasLlamaDll }
    info.runtimeFiles = files
    info.runtimePackageKind = hasServer
      ? 'llama-server-package'
      : hasCudaRuntime && !hasLlamaDll
        ? 'cuda-runtime-only'
        : hasCudaRuntime || hasLlamaDll
          ? 'runtime-missing-server'
          : 'missing-server'
    if (!hasServer) {
      info.runtimeIssues.push({
        id: 'missing-server',
        level: 'blocked',
        message: '运行目录里没有 llama-server.exe。',
        action: '重新选择完整 llama.cpp Windows 包目录。',
      })
    }
    if (hasServer && hasCudaRuntime && !lower.some(file => /^ggml-cuda.*\.dll$/.test(file))) {
      info.runtimeIssues.push({
        id: 'cuda-dll-hint-missing',
        level: 'warning',
        message: '看到 CUDA 运行库，但没有看到 ggml-cuda*.dll；如果 GPU 启动失败，请换完整 CUDA 版包。',
        action: '这不是启动阻塞项，先启动；失败时按日志补齐 CUDA 版 DLL。',
      })
    }
  } catch {
    info.runtimePackageKind = 'unreadable'
    info.runtimeIssues.push({
      id: 'runtime-dir-unreadable',
      level: 'warning',
      message: '运行目录无法读取，无法提前检查 DLL。',
      action: '如果启动失败，请确认目录权限和完整解压状态。',
    })
  }

  return info
}

function validation(config) {
  const runtimeInfo = runtimePackageInfo(config)
  return {
    configExists: config.launch_mode !== 'launcher' || existsSync(config.config_path),
    launcherExists: config.launch_mode !== 'launcher' || existsSync(config.launcher_path),
    serverExists: existsSync(config.llama_server_path),
    modelExists: existsSync(config.model),
    mmprojExists: !config.mmproj || existsSync(config.mmproj),
    ...runtimeInfo,
  }
}

function mimeForFile(filePath) {
  const ext = path.extname(filePath).toLowerCase()
  return {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif',
    '.bmp': 'image/bmp',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.m4a': 'audio/mp4',
    '.ogg': 'audio/ogg',
    '.pdf': 'application/pdf',
    '.txt': 'text/plain',
    '.md': 'text/markdown',
    '.json': 'application/json',
    '.toml': 'text/plain',
    '.yaml': 'text/yaml',
    '.yml': 'text/yaml',
    '.csv': 'text/csv',
    '.log': 'text/plain',
    '.py': 'text/x-python',
    '.js': 'text/javascript',
    '.ts': 'text/typescript',
    '.tsx': 'text/typescript',
    '.html': 'text/html',
    '.css': 'text/css',
  }[ext] || 'application/octet-stream'
}

function isTextLike(filePath) {
  return [
    '.txt',
    '.md',
    '.json',
    '.toml',
    '.yaml',
    '.yml',
    '.csv',
    '.log',
    '.py',
    '.js',
    '.ts',
    '.tsx',
    '.html',
    '.css',
    '.c',
    '.cpp',
    '.h',
    '.hpp',
  ].includes(path.extname(filePath).toLowerCase())
}

function isImageLike(filePath) {
  return ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(path.extname(filePath).toLowerCase())
}

function isAudioLike(filePath) {
  return ['.mp3', '.wav', '.flac', '.m4a', '.ogg'].includes(path.extname(filePath).toLowerCase())
}

function isPdfLike(filePath) {
  return path.extname(filePath).toLowerCase() === '.pdf'
}

async function buildAttachment(filePath) {
  const stat = await import('node:fs/promises').then(fs => fs.stat(filePath))
  const attachment = {
    path: filePath,
    name: path.basename(filePath),
    size: stat.size,
    mime: mimeForFile(filePath),
    kind: isImageLike(filePath) ? 'image' : isAudioLike(filePath) ? 'audio' : isPdfLike(filePath) ? 'pdf' : isTextLike(filePath) ? 'text' : 'file',
  }

  if (attachment.kind === 'image' && stat.size <= 10 * 1024 * 1024) {
    const raw = await readFile(filePath)
    attachment.dataUrl = `data:${attachment.mime};base64,${raw.toString('base64')}`
  }

  if (attachment.kind === 'text' && stat.size <= 256 * 1024) {
    attachment.text = await readFile(filePath, 'utf8')
  }

  return attachment
}

async function buildAttachmentsFromPaths(filePaths) {
  const paths = Array.from(new Set((Array.isArray(filePaths) ? filePaths : [])
    .map(filePath => String(filePath || '').trim())
    .filter(Boolean)))
    .slice(0, 64)

  const attachments = []
  for (const filePath of paths) {
    try {
      attachments.push(await buildAttachment(filePath))
    } catch (error) {
      attachments.push({
        path: filePath,
        name: path.basename(filePath),
        size: 0,
        mime: mimeForFile(filePath),
        kind: 'file',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return attachments
}

async function appState() {
  const config = await loadConfig()
  return {
    config,
    configWarnings: runtimeWarnings(config),
    ...serviceUrls(config),
    status: runtimeStatus,
    logs: logs.entries,
    logStats: logStats(),
    validation: validation(config),
    launch: buildLaunchDetails(config),
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow()
    return
  }
  mainWindow.setSkipTaskbar(false)
  if (mainWindow.isMinimized()) {
    mainWindow.restore()
  }
  mainWindow.show()
  mainWindow.focus()
}

function statusLabel() {
  return {
    stopped: '未启动',
    starting: '启动中',
    running: '运行中',
    stopping: '停止中',
    error: '需要处理',
  }[runtimeStatus.state] || runtimeStatus.state
}

function updateTrayMenu() {
  if (!tray) {
    return
  }

  tray.setToolTip(`Llama Rig - ${statusLabel()} - ${runtimeStatus.url}`)
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '打开 Llama Rig',
      click: showMainWindow,
    },
    {
      label: `${statusLabel()}  ${runtimeStatus.url}`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: '打开 OpenAI Base URL',
      click: () => shell.openExternal(`${runtimeStatus.url}/v1`),
    },
    {
      label: '停止服务',
      enabled: Boolean(serverChild && serverChild.exitCode === null),
      click: async () => {
        if (serverChild && serverChild.exitCode === null) {
          stoppingServer = true
          setStatus({ state: 'stopping', message: '正在停止服务' })
          await taskkill(serverChild.pid)
        }
      },
    },
    { type: 'separator' },
    {
      label: '退出并停止服务',
      click: () => {
        appIsQuitting = true
        app.quit()
      },
    },
  ]))
}

function createTray() {
  if (tray) {
    return
  }

  const image = nativeImage.createFromPath(trayIconPath)
  tray = new Tray(image.isEmpty() ? nativeImage.createFromPath(iconPath) : image)
  tray.on('click', showMainWindow)
  tray.on('double-click', showMainWindow)
  updateTrayMenu()
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 900,
    minWidth: 760,
    minHeight: 640,
    title: 'Llama Rig',
    backgroundColor: '#F7F7F4',
    icon: iconPath,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#F4F3EC',
      symbolColor: '#2B2922',
      height: 36,
    },
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    show: false,
  })

  mainWindow.once('ready-to-show', () => {
    mainWindow?.show()
  })

  mainWindow.on('close', event => {
    if (appIsQuitting) {
      return
    }

    event.preventDefault()
    mainWindow.hide()
    mainWindow.setSkipTaskbar(true)
    if (!firstHideNoticeShown) {
      firstHideNoticeShown = true
      tray?.displayBalloon?.({
        title: 'Llama Rig 仍在运行',
        content: '窗口已隐藏到系统托盘，本地服务会继续监听。',
      })
    }
  })

  mainWindow.loadFile(rendererPath)
  Menu.setApplicationMenu(null)
}

async function taskkill(pid) {
  await new Promise(resolve => {
    const child = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
    child.once('exit', resolve)
    child.once('error', resolve)
  })
}

function registerIpc() {
  ipcMain.handle('llama:get-state', async () => appState())

  ipcMain.handle('llama:save-config', async (_event, payload) => {
    const config = await saveConfig(payload.config)
    addLog('desktop', '配置已保存')
    return appState()
  })

  ipcMain.handle('llama:start-server', async (_event, payload) => {
    if (serverChild && serverChild.exitCode === null) {
      return appState()
    }

    const config = normalizeConfig(payload.config)
    // 修 #4：先清理引擎不兼容参数，再校验/生成命令/起服 —— 保证 buildLaunchDetails 和实际启动用同一份配置
    const sanitized = sanitizeEngineParams(config)
    assertStartableServerConfig(sanitized, existsSync)
    // 先把不该有的参数拦下来，再落盘/起服 —— 否则会存下一份启动必死的配置。
    await assertExtraArgsSupported(sanitized)
    await saveConfig(sanitized)
    const directMode = sanitized.launch_mode !== 'launcher'
    const launch = buildLaunchDetails(sanitized)
    if (launch.error) {
      throw new Error(launch.error)
    }

    logs = { entries: [], filtered: 0, truncated: 0, dropped: 0 }
    serverLogChunkBuffers = createLogChunkBuffers()
    stoppingServer = false
    setStatus({
      state: 'starting',
      message: '正在启动服务',
      pid: null,
      url: localUrl(config),
      startedAt: new Date().toISOString(),
    })
    const serverDir = path.dirname(config.llama_server_path)
    const command = launch.command
    const args = launch.args
    const cwd = launch.cwd
    addLog('desktop', `启动方式：${directMode ? '直接启动' : '启动器'}`)
    addLog('desktop', `服务程序：${path.basename(config.llama_server_path) || 'llama-server'}`)
    if (directMode) {
      addLog('desktop', `完整命令：${launch.preview}`)
      // 字段名保留（对应命令行开关，便于对照），只把取值读法改成人话
      addLog('desktop', `关键参数：ctx_size=${config.ctx_size} · n_gpu_layers=${config.n_gpu_layers} · batch_size=${config.batch_size || 'auto'} · ubatch_size=${config.ubatch_size || 'auto'} · threads=${config.threads || 'auto'}`)
    } else {
      addLog('desktop', `启动器：${path.basename(config.launcher_path) || 'launcher'}`)
    }

    serverChild = spawn(command, args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        NO_COLOR: '1',
        Path: `${serverDir};${process.env.Path || process.env.PATH || ''}`,
      },
    })

    setStatus({ pid: serverChild.pid })
    serverChild.stdout?.on('data', chunk => addBufferedLog('stdout', chunk))
    serverChild.stderr?.on('data', chunk => addBufferedLog('stderr', chunk))
    serverChild.once('error', error => {
      flushServerLogBuffers()
      addLog('desktop', `启动失败：${error.message}`)
      setStatus({ state: 'error', message: error.message, pid: null })
    })
    serverChild.once('exit', code => {
      flushServerLogBuffers()
      const message = stoppingServer ? '服务已停止' : `服务进程已退出：${code ?? 'unknown'}`
      addLog('desktop', message)
      serverChild = null
      setStatus({
        state: stoppingServer ? 'stopped' : 'error',
        message,
        pid: null,
      })
      stoppingServer = false
    })

    return appState()
  })

  ipcMain.handle('llama:stop-server', async () => {
    if (serverChild && serverChild.exitCode === null) {
      stoppingServer = true
      setStatus({ state: 'stopping', message: '正在停止服务' })
      await taskkill(serverChild.pid)
      flushServerLogBuffers()
    }
    return appState()
  })

  ipcMain.handle('llama:test-health', async (_event, payload) => {
    const config = normalizeConfig(payload.config)
    const url = localUrl(config)
    const endpointBase = `${url.replace(/\/+$/, '')}/v1`
    const chatCompletionsUrl = `${url.replace(/\/+$/, '')}/v1/chat/completions`
    const startedAt = Date.now()
    const checks = []
    async function checkEndpoint(id, targetUrl, options = {}) {
      try {
        const response = await fetch(targetUrl, {
          method: options.method || 'GET',
          signal: AbortSignal.timeout(options.timeout || 3500),
          headers: options.headers || undefined,
        })
        const ok = options.acceptStatus ? options.acceptStatus(response.status) : response.ok
        checks.push({ id, ok, status: response.status, url: targetUrl })
        return { ok, status: response.status, response }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        checks.push({ id, ok: false, status: 0, url: targetUrl, message })
        return { ok: false, status: 0, error, message }
      }
    }

    const base = await checkEndpoint('base', url)
    if (!base.ok) {
      return {
        ok: false,
        status: base.status,
        url,
        endpointBase,
        kind: base.status === 0 ? 'network-error' : 'http-error',
        checks,
        message: base.message || `HTTP ${base.status}`,
        nextAction: '先确认服务已启动；如果端口被占用，换成 8081 后重试。',
        latencyMs: Date.now() - startedAt,
      }
    }

    const models = await checkEndpoint('models', `${endpointBase}/models`)
    if (!models.ok) {
      return {
        ok: false,
        status: models.status,
        url,
        endpointBase,
        kind: 'not-openai-compatible',
        checks,
        message: `/v1/models unavailable: HTTP ${models.status}`,
        nextAction: '端口有响应但不是 OpenAI 兼容接口；确认 Base URL 指向当前 llama.cpp server。',
        latencyMs: Date.now() - startedAt,
      }
    }

    const chat = await checkEndpoint('chat', chatCompletionsUrl, {
      method: 'OPTIONS',
      acceptStatus: status => [200, 204, 400, 405].includes(status),
      timeout: 2500,
    })
    if (!chat.ok) {
      return {
        ok: false,
        status: chat.status,
        url,
        endpointBase,
        kind: 'not-openai-compatible',
        checks,
        message: `/v1/chat/completions unavailable: HTTP ${chat.status}`,
        nextAction: '端口能响应，但 Chat Completions 路由不可用；确认第三方客户端没有连到旧服务或错误进程。',
        latencyMs: Date.now() - startedAt,
      }
    }

    try {
      return {
        ok: true,
        status: models.status,
        url,
        endpointBase,
        kind: 'openai-compatible',
        checks,
        nextAction: '复制 OpenAI Base URL 到第三方客户端。',
        latencyMs: Date.now() - startedAt,
      }
    } catch (error) {
      return {
        ok: false,
        status: 0,
        url,
        endpointBase,
        kind: 'network-error',
        checks,
        message: error instanceof Error ? error.message : String(error),
        nextAction: '检查端口占用或重新启动服务。',
        latencyMs: Date.now() - startedAt,
      }
    }
  })

  ipcMain.handle('llama:get-system-info', async () => ({
    platform: process.platform,
    arch: process.arch,
    cpuModel: os.cpus()?.[0]?.model || '',
    cpuThreads: os.cpus()?.length || 0,
    totalMemoryGB: Math.round((os.totalmem() / 1024 / 1024 / 1024) * 10) / 10,
    freeMemoryGB: Math.round((os.freemem() / 1024 / 1024 / 1024) * 10) / 10,
    gpus: await getGpuInfo(),
    vram: await getVramUsage(),
  }))

  // 顶栏「模型」折叠菜单的数据源：本机全部本地 gguf。
  ipcMain.handle('llama:list-models', async () => collectLocalModels())

  // 按本机硬件为「当前模型」算一份稳定预设。
  // 目标不是最优，而是**一定能起来**：宁可上下文小一点、层数少一点。
  ipcMain.handle('llama:stable-preset', async (_event, payload) => {
    const config = normalizeConfig(payload?.config || {})
    const modelPath = String(config.model || '')
    if (!modelPath) {
      return { ok: false, error: '还没选模型文件，先在顶栏选一个 gguf。' }
    }
    // 引擎可执行文件还没定下来时，这份预设存下来其实起不来（llama_server_path 会是个
    // 悬空的相对文件名）。必须提前说清楚，否则用户以为「生成完就能跑」。
    const engineReady = Boolean(config.llama_server_path) && existsSync(config.llama_server_path)
    const gguf = await readGgufMetadata(modelPath)
    const vram = await getVramUsage()
    const proposal = computeStablePreset({
      modelMeta: gguf,
      fileSizeBytes: gguf.fileSizeBytes || 0,
      vramTotalMiB: vram.total || 0,
      vramUsedMiB: vram.used || 0,
      ramTotalGB: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10,
      logicalThreads: os.cpus()?.length || 0,
      engineId: detectEngineByPath(config.llama_server_path),
    })
    if (!engineReady) {
      proposal.warnings.unshift(
        `还没指定可用的 llama.cpp 目录（当前记录的是「${path.basename(config.llama_server_path) || '空'}」），` +
        '这份预设存下来也起不来。先去「设置 → 概述」选好 llama.cpp 原始目录，再回来生成。',
      )
    }
    return {
      ok: true,
      engineReady,
      modelPath,
      modelName: path.basename(modelPath),
      suggestedName: suggestPresetName(modelPath),
      engineId: detectEngineByPath(config.llama_server_path),
      engineLabel: getEngineLabel(detectEngineByPath(config.llama_server_path)),
      gguf: {
        ok: Boolean(gguf.ok),
        architecture: gguf.architecture || '',
        blockCount: gguf.blockCount || 0,
        contextLength: gguf.contextLength || 0,
        headCountKv: gguf.headCountKv || 0,
        keyLength: gguf.keyLength || 0,
        truncated: Boolean(gguf.truncated),
        error: gguf.error || '',
      },
      hardware: {
        vramTotalMiB: vram.total || 0,
        vramUsedMiB: vram.used || 0,
        ramTotalGB: Math.round(os.totalmem() / 1024 / 1024 / 1024 * 10) / 10,
        logicalThreads: os.cpus()?.length || 0,
      },
      proposal,
    }
  })

  ipcMain.handle('llama:inspect-port', async (_event, payload) => {
    const config = normalizeConfig(payload?.config || {})
    return inspectPort(config.port)
  })

  ipcMain.handle('llama:client-smoke-test', async (_event, payload) => {
    const config = normalizeConfig(payload?.config || {})
    const url = serviceUrls(config).chatCompletionsUrl
    const startedAt = Date.now()
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...buildChatRequestBody(config, [{ role: 'user', content: 'ping' }], false),
          max_tokens: 8,
          stream: false,
        }),
        signal: AbortSignal.timeout(12000),
      })
      const text = await response.text().catch(() => '')
      return {
        ok: response.ok,
        status: response.status,
        url,
        latencyMs: Date.now() - startedAt,
        message: response.ok ? 'OpenAI-compatible chat smoke test passed.' : text.slice(0, 500) || `HTTP ${response.status}`,
      }
    } catch (error) {
      return {
        ok: false,
        status: 0,
        url,
        latencyMs: Date.now() - startedAt,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  })

  ipcMain.handle('llama:get-model-info', async (_event, payload) => {
    const config = normalizeConfig(payload?.config || {})
    const serverUrl = localUrl(config)
    const modelPath = config.model || ''
    const fileName = path.basename(modelPath || 'local-model')
    let fileSize = 0
    if (modelPath && existsSync(modelPath)) {
      try {
        fileSize = (await stat(modelPath)).size
      } catch {
        fileSize = 0
      }
    }

    const [modelsPayload, propsPayload] = await Promise.all([
      fetchJson(`${serverUrl}/v1/models`),
      fetchJson(`${serverUrl}/props`),
    ])

    const apiModel = modelsPayload?.data?.[0] || {}
    const apiMeta = apiModel?.meta || {}
    const listedModel = modelsPayload?.models?.[0] || {}

    return {
      name: listedModel?.name || apiModel?.id || propsPayload?.model_alias || fileName,
      filePath: propsPayload?.model_path || modelPath,
      fileSize: Number(apiMeta?.size || fileSize || 0),
      family: listedModel?.details?.family || parseFamily(fileName),
      quantization: listedModel?.details?.quantization_level || parseQuantization(fileName),
      parameterScale: listedModel?.details?.parameter_size || parseParameterScale(fileName),
      nParams: Number(apiMeta?.n_params || 0),
      ctxSize: toNumber(propsPayload?.default_generation_settings?.n_ctx, toNumber(config.ctx_size, '')),
      trainingContext: toNumber(apiMeta?.n_ctx_train, ''),
      embeddingSize: toNumber(apiMeta?.n_embd, ''),
      vocabSize: toNumber(apiMeta?.n_vocab, ''),
      vocabType: toNumber(apiMeta?.vocab_type, ''),
      parallelSlots: toNumber(propsPayload?.total_slots, ''),
      nPredict: toNumber(config.n_predict, ''),
      gpuLayers: toNumber(config.n_gpu_layers, ''),
      temperature: toNumber(config.temp, ''),
      topP: toNumber(config.top_p, ''),
      topK: toNumber(config.top_k, ''),
      minP: toNumber(config.min_p, ''),
      presencePenalty: toNumber(config.presence_penalty, ''),
      repeatPenalty: toNumber(config.repeat_penalty, ''),
      serverUrl,
      build: propsPayload?.build_info || path.basename(config.llama_server_path || 'llama-server.exe'),
      chatTemplateText: String(propsPayload?.chat_template || config.chat_template_kwargs || '').trim(),
      propsSource: Boolean(propsPayload),
      modelSource: Boolean(modelsPayload),
      parameterLabel: humanParams(apiMeta?.n_params),
    }
  })

  ipcMain.handle('llama:chat-completion', async (_event, payload) => {
    const config = normalizeConfig(payload.config)
    const requestId = String(payload.requestId || `chat-${Date.now()}`)
    const url = serviceUrls(config).chatCompletionsUrl
    const messages = buildRequestMessages(prepareChatMessages(payload.messages))

    if (messages.length === 0) {
      throw new Error('没有可发送的消息')
    }

    const signal = requestRegistry.start(requestId, Math.max(30000, toNumber(config.request_timeout_ms, 600000)))
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildChatRequestBody(config, messages, false)),
        signal,
      })

      if (!response.ok) {
        const text = await response.text().catch(() => '')
        throw new Error(`模型接口返回 ${response.status}${text ? `：${text.slice(0, 500)}` : ''}`)
      }

      const data = await response.json()
      const { content, thinking } = extractStreamDelta(data)
      return { ok: true, content, thinking, raw: data }
    } finally {
      requestRegistry.finish(requestId, signal)
    }
  })

  ipcMain.handle('llama:chat-stream', async (_event, payload) => {
    const config = normalizeConfig(payload.config)
    const requestId = String(payload.requestId || `chat-${Date.now()}`)
    const url = serviceUrls(config).chatCompletionsUrl
    const startedAt = Date.now()
    const messages = buildRequestMessages(prepareChatMessages(payload.messages))

    if (messages.length === 0) {
      throw new Error('没有可发送的消息')
    }

    // 字段（请求号 / 条数 / 目标地址）全部保留，只把外层措辞改中文。
    // 改动这里必须同步 desktop/lib/log-pipeline.mjs 的 isImportantRuntimeLine 正则，
    // 否则这条会从「输出日志」视图里消失。
    addLog('chat', `请求 ${requestId}：${messages.length} 条消息 → ${url}`)

    const signal = requestRegistry.start(requestId, Math.max(30000, toNumber(config.request_timeout_ms, 600000)))
    try {
      let response
      try {
        response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildChatRequestBody(config, messages, true)),
          signal,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        addLog('chat', `请求失败：${message}`)
        throw error
      }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      const message = `模型接口返回 ${response.status}${text ? `：${text.slice(0, 500)}` : ''}`
      addLog('chat', `请求失败：${message}`)
      throw new Error(message)
    }

    const reader = response.body?.getReader()
    if (!reader) {
      addLog('chat', '请求失败：响应体不可读')
      throw new Error('模型接口没有返回可读取的流')
    }

    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let content = ''
    let thinking = ''
    let raw = null
    let streamAnnounced = false

    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split(/\r?\n\r?\n/)
      buffer = parts.pop() || ''

      for (const part of parts) {
        const lines = part
          .split(/\r?\n/)
          .map(line => line.trim())
          .filter(line => line.startsWith('data:'))
          .map(line => line.slice(5).trim())

        for (const line of lines) {
          if (!line || line === '[DONE]') continue
          try {
            const data = JSON.parse(line)
            raw = data
            const delta = extractStreamDelta(data)
            if (delta.content || delta.thinking) {
              if (!streamAnnounced) {
                addLog('chat', `流式响应中：${requestId}`)
                streamAnnounced = true
              }
              content += delta.content
              thinking += delta.thinking
              sendEvent({ type: 'chat-stream', requestId, delta: delta.content, thinkingDelta: delta.thinking })
            }
          } catch {
            // Ignore malformed stream fragments; llama.cpp can occasionally split aggressively.
          }
        }
      }
    }

    const elapsed = Math.max(0.1, (Date.now() - startedAt) / 1000)
    const approxTokens = Math.max(1, Math.round(String(content || '').length / 3))
    // tokens / 秒数保留：既是排障依据，也是用户看得懂的通用术语
    addLog('chat', `响应结束：约 ${approxTokens} tokens，${elapsed.toFixed(1)}s`)
    sendEvent({ type: 'chat-stream', requestId, done: true, content, thinking })
      return { ok: true, content, thinking, raw }
    } finally {
      requestRegistry.finish(requestId, signal)
    }
  })

  ipcMain.handle('llama:cancel-chat', async (_event, payload) => ({
    ok: requestRegistry.cancel(String(payload?.requestId || '')),
  }))

  ipcMain.handle('llama:pick-file', async (_event, payload) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: payload?.properties || ['openFile'],
      filters: payload?.filters || [{ name: 'All Files', extensions: ['*'] }],
    })
    return result.canceled ? null : result.filePaths[0]
  })

  ipcMain.handle('llama:pick-attachments', async (_event, payload) => {
    const kind = payload?.kind || 'file'
    const filterMap = {
      image: [
        { name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      audio: [
        { name: 'Audio', extensions: ['mp3', 'wav', 'flac', 'm4a', 'ogg'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      text: [
        { name: 'Text and Code', extensions: ['txt', 'md', 'json', 'toml', 'yaml', 'yml', 'csv', 'log', 'py', 'js', 'ts', 'tsx', 'html', 'css', 'c', 'cpp', 'h', 'hpp'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      pdf: [
        { name: 'PDF', extensions: ['pdf'] },
        { name: 'All Files', extensions: ['*'] },
      ],
      file: [
        { name: 'Documents and Images', extensions: ['txt', 'md', 'json', 'toml', 'yaml', 'yml', 'csv', 'log', 'py', 'js', 'ts', 'tsx', 'html', 'css', 'pdf', 'mp3', 'wav', 'flac', 'm4a', 'ogg', 'png', 'jpg', 'jpeg', 'webp'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    }
    const filters = filterMap[kind] || filterMap.file

    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile', 'multiSelections'],
      filters,
    })

    if (result.canceled) {
      return []
    }

    return buildAttachmentsFromPaths(result.filePaths)
  })

  ipcMain.handle('llama:import-attachments', async (_event, payload) => {
    return buildAttachmentsFromPaths(payload?.paths || [])
  })

  ipcMain.handle('llama:reveal-path', async (_event, payload) => {
    if (payload?.filePath) {
      shell.showItemInFolder(payload.filePath)
    }
    return { ok: true }
  })

  ipcMain.handle('llama:open-url', async (_event, payload) => {
    if (payload?.url) {
      await shell.openExternal(payload.url)
    }
    return { ok: true }
  })

  // P0-1: Preset IPC handlers
  ipcMain.handle('llama:preset-list', () => listPresets())
  ipcMain.handle('llama:preset-read', async (_event, name) => name ? readPreset(name) : null)
  ipcMain.handle('llama:preset-write', async (_event, { name, config }) => name && config ? writePreset(name, config) : { success: false, error: '缺少参数' })
  ipcMain.handle('llama:preset-delete', async (_event, name) => name ? deletePreset(name) : { success: false, error: '缺少预设名' })

  // P0-2: Engine switching
  ipcMain.handle('llama:engine-list', () => resolveEnginePaths())
  // 显式重新扫描：用户把引擎挪了位置、或新解压了一份之后点一下。
  // 清缓存再扫，返回完整候选列表（界面用它展示「扫到了哪些」）。
  ipcMain.handle('llama:engine-rescan', (_event, payload) => {
    engineScanCache = null
    // 界面把两个「还没保存到磁盘」的线索带下来：
    //   currentServerPath —— 当前配的引擎路径（它的基目录最该扫）
    //   searchDir         —— 用户亲手指过的文件夹（「我放 llama.cpp 的地方」）
    // 只靠磁盘上的 config.toml 不够：用户可能刚选完还没点保存。
    const candidates = discoverEngines({
      force: true,
      currentServerPath: payload?.currentServerPath,
      searchDir: payload?.searchDir,
    })
    return { engines: resolveEnginePaths(), candidates, recommended: recommendEnginePath(candidates) }
  })
  ipcMain.handle('llama:engine-detect', async (_event, serverPath) => ({ engineId: detectEngineByPath(serverPath || ''), engines: resolveEnginePaths() }))

  // P1-2: VRAM guard
  ipcMain.handle('llama:vram-check', async () => getVramUsage())

  // P2-2: Preset metadata
  ipcMain.handle('llama:preset-metadata', async (_event, { name, config }) => {
    if (!config) { const p = await readPreset(name); config = p }
    return extractPresetMetadata(name, config)
  })

  // 全部预设的摘要（名字 + 模型文件名 + 上下文 + 引擎）。
  // 顶栏需要它来回答一个此前答不上来的问题：「当前配置对应的是哪个预设」。
  // 以前没加载预设时那个胶囊永远写着「选择预设」，可模型明明已经配好了。
  ipcMain.handle('llama:preset-summaries', async () => {
    const names = await listPresets()
    const out = []
    for (const name of names || []) {
      try {
        const config = await readPreset(name)
        const meta = extractPresetMetadata(name, config)
        if (meta) out.push({ ...meta, modelPath: config?.model || '' })
      } catch {}
    }
    return out
  })

  // Branding
  ipcMain.handle('app:version', () => app.getVersion())

  // 系统窗口控件配色跟随主题：titleBarOverlay 是独立图层，页面改 CSS 影响不到它。
  ipcMain.handle('app:set-titlebar-theme', (_event, payload) => {
    if (!mainWindow || mainWindow.isDestroyed()) return { success: false }
    const want = payload?.dark ? payload.darkColors : payload.light
    if (!want?.color || !want?.symbolColor) return { success: false }
    try {
      mainWindow.setTitleBarOverlay({
        color: String(want.color),
        symbolColor: String(want.symbolColor),
        height: 36,
      })
      return { success: true }
    } catch (error) {
      return { success: false, error: error?.message || String(error) }
    }
  })
  ipcMain.handle('app:name', () => app.name)
  ipcMain.handle('app:productName', () => app.name)
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.whenReady().then(async () => {
    // 播种失败必须留下痕迹。
    // 踩过的坑：copyDirToDisk 里漏了一个未导入的 readFileSync，抛出的
    // ReferenceError 被当成未处理的 Promise 拒绝吞掉 —— 界面照常启动，
    // 只是用户永远拿不到随包预设，而且没有任何提示。
    try {
      await ensureOwnDataRoot()
    } catch (error) {
      addLog('desktop', `首次运行导入默认文件失败：${error instanceof Error ? error.message : String(error)}`)
    }
    registerIpc()
    createTray()
    createMainWindow()
  })

  app.on('second-instance', () => {
    if (mainWindow) {
      showMainWindow()
    }
  })

  app.on('before-quit', async event => {
    appIsQuitting = true
    if (serverChild && serverChild.exitCode === null && !stoppingServer) {
      event.preventDefault()
      stoppingServer = true
      await taskkill(serverChild.pid)
      app.quit()
    }
  })

  app.on('window-all-closed', () => {
    // Keep the local server alive in the system tray.
  })
}