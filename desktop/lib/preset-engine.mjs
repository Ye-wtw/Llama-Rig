// 预设管理 / 引擎切换 / 显存守卫的纯逻辑层。
// 只做数据判断，不碰文件系统与 Electron，因此可以直接被 node --test 覆盖。
// 参照 desktop/lib/runtime-policy.mjs 的既有模式：主进程负责 IO，本模块负责规则。

// ---------- 引擎定义 ----------

// binary 是相对引擎根的路径片段，由主进程拼接出绝对路径。
export const ENGINE_DEFINITIONS = [
  {
    id: 'llama-cpp',
    label: 'llama.cpp (默认)',
    desc: '原版 llama.cpp，跑普通 GGUF',
    binary: ['llama.cpp', 'bin', 'llama-server.exe'],
    incompatibleParams: [],
  },
  {
    id: 'kvmem',
    label: 'KVMem (三元 Bonsai)',
    desc: 'KVMem 引擎，跑三元 Bonsai',
    binary: ['kvmem-gui', 'llama-server.exe'],
    // KVMem 不接受的开关。2026-09-25 逐条跑过 kvmem-gui\llama-server.exe --help 比对，
    // 比需求书原本写的多出三项，而且【取反形式同样不认】：
    //   --cpu-moe / --n-cpu-moe / --embeddings / --verbose / --cont-batching / --no-cont-batching
    // 其中 --no-cont-batching 最阴：改造版当初用「关掉 continuous_batching」来表达
    // 「KVMem 不支持它」，结果拼命令行时又输出了 --no-cont-batching，引擎照样
    // "unknown flag" 当场退出（llama.cpp 支持取反形式，所以只有 KVMem 会踩）。
    incompatibleParams: [
      '--n-cpu-moe',
      '--cpu-moe',
      '--embeddings',
      '--cont-batching',
      '--no-cont-batching',
      '--verbose',
      // 以下 4 项 2026-09-28 逐条跑 kvmem-gui\llama-server.exe --help(91 行) 比对：
      // KVMem 认得 --cache-type-k/--cache-type-v，但不认这 4 个。
      '--rope-freq-base',
      '--mirostat',
      '--lora',
      '--kv-unified-per-slot',
      '--no-perf',
    ],
  },
  {
    id: 'prismml',
    label: 'PrismML fork',
    desc: 'PrismML fork，跑三元 Bonsai',
    binary: ['prism-llama', 'llama-server.exe'],
    // PrismML 711 行 help 实测：cache-type-k/v、rope-freq-base、mirostat、lora 都在，
    // 唯独没有 --kv-unified-per-slot。
    incompatibleParams: ['--kv-unified-per-slot'],
  },
]

// 参数开关 -> 配置字段名 / 中文名。用于把「不支持的开关」翻译成人能读的报错。
// 只登记「开关 ↔ 布尔配置字段」的映射（供 sanitizeEngineParams 强制关掉）。
// --no-cont-batching 是取反形式，不对应任何需要写的字段，因此不在这里。
const FLAG_TO_CONFIG_KEY = {
  '--n-cpu-moe': 'cpu_moe',
  '--cpu-moe': 'cpu_moe',
  '--embeddings': 'embeddings',
  '--cont-batching': 'continuous_batching',
  '--verbose': 'verbose',
  '--flash-attn': 'flash_attn',
  '--no-perf': 'no_perf',
  '--mlock': 'mlock',
  '--no-mmap': 'no_map',
  '--mmap': 'use_mmap',
}

// 非布尔参数（字符串/数值）开关 -> 配置字段名。
// 与 FLAG_TO_CONFIG_KEY 分离的原因：sanitizeEngineParams 对布尔键写 false，
// 而 false 会被 hasValue() 判为「有值」(String(false)='false')，拼出 `--x false`。
// 所以非布尔键只能清空，绝不能置 false。
// 数组首项是「触发键」：只有它非空才会真的拼出该 flag
// （--lora 由 num_lora 触发，lora_paths 单独有值不会触发）。
// 其余项只用于界面置灰，避免留下「能改但不生效」的控件。
const FLAG_TO_PARAM_KEY = {
  '--cache-type-k': ['type_k'],
  '--cache-type-v': ['type_v'],
  '--kv-unified-per-slot': ['kv_out_size'],
  '--rope-freq-base': ['rope_freq_base'],
  '--mirostat': ['mirostat'],
  '--lora': ['num_lora', 'lora_paths'],
}

// 触发键（数组首项）—— 启动前校验与 sanitize 只认它，
// 这样清空不会误删用户的 lora_paths。
function paramTriggerKeys(engine) {
  return engine.incompatibleParams
    .map(flag => (FLAG_TO_PARAM_KEY[flag] || [])[0])
    .filter(Boolean)
}

const FLAG_LABELS = {
  '--n-cpu-moe': 'MoE 卸载',
  '--cpu-moe': 'MoE 卸载',
  '--embeddings': 'embeddings',
  '--cont-batching': 'continuous batching',
  '--no-cont-batching': 'continuous batching',
  '--verbose': 'Verbose',
  '--cache-type-k': 'KV 缓存 K 类型',
  '--cache-type-v': 'KV 缓存 V 类型',
  '--kv-unified-per-slot': 'KV 上限',
  '--rope-freq-base': 'RoPE 频率基数',
  '--mirostat': 'Mirostat',
  '--lora': 'LoRA 适配器',
  '--flash-attn': 'Flash Attention',
  '--no-perf': '性能计时',
  '--mlock': '锁定内存',
  '--no-mmap': '禁用 mmap',
  '--mmap': '启用 mmap',
}

const DEFAULT_ENGINE_ID = 'llama-cpp'

export function getEngineById(id) {
  return ENGINE_DEFINITIONS.find(engine => engine.id === id) || ENGINE_DEFINITIONS[0]
}

export function getEngineIncompatibleParams(id) {
  return getEngineById(id).incompatibleParams
}

// 该引擎是否接受某个命令行开关。拼参数前必须过这一关 ——
// 不支持的开关（含取反形式）拼进去就是 "unknown flag" 直接退出。
export function engineSupportsFlag(id, flag) {
  return !getEngineById(id).incompatibleParams.includes(flag)
}

// ---------- KV 缓存量化类型 ----------
// 下面每一档都来自在各引擎 exe 上实跑 `--help` 读回的 allowed values，
// 不是照文档抄的。实测（2026-09-29）：
//   llama.cpp\bin\llama-server.exe
//     -ctk/-ctv  allowed values: f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1  (default f16)
//   prism-llama 同 llama.cpp（同一份 help 文本）
//   kvmem-gui\llama-server.exe 与 kvmem\bin\llama-kvmem-server.exe
//     -ctk  "GPU K cache type (llama.cpp name; default q8_0)"
//     -ctv  "GPU V cache type (quantized: independently q8_0 | q5_0 | q4_0)"
// 即：KVMem 的 V 缓存只认那三档，且它的默认值是 q8_0 而不是 f16。
export const KV_CACHE_TYPES = ['f32', 'f16', 'bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0', 'iq4_nl']

const ENGINE_CACHE_TYPES = {
  'llama-cpp': { k: KV_CACHE_TYPES, v: KV_CACHE_TYPES, defaultK: 'f16', defaultV: 'f16' },
  prismml: { k: KV_CACHE_TYPES, v: KV_CACHE_TYPES, defaultK: 'f16', defaultV: 'f16' },
  kvmem: { k: KV_CACHE_TYPES, v: ['q8_0', 'q5_0', 'q4_0'], defaultK: 'q8_0', defaultV: 'q8_0' },
}

export function engineCacheTypes(engineId) {
  return ENGINE_CACHE_TYPES[engineId] || ENGINE_CACHE_TYPES['llama-cpp']
}

// 某一档是否被该引擎接受（空值 = 不指定 = 永远接受）。
export function cacheTypeSupported(engineId, which, value) {
  if (!value) return true
  const table = engineCacheTypes(engineId)
  const list = which === 'v' ? table.v : table.k
  return list.includes(String(value))
}

// 配置里选了当前引擎不认的 KV 量化档 -> 返回可显示的提示。
// 这类错误原本要等启动失败才暴露（引擎报 invalid argument 后直接退出），
// 现在提前在参数页说清楚。
export function cacheTypeIssues(config = {}) {
  const engineId = detectEngineByPath(config.llama_server_path)
  const table = engineCacheTypes(engineId)
  const issues = []
  const describe = value => String(value || '').trim()
  const typeK = describe(config.type_k)
  const typeV = describe(config.type_v)
  if (!cacheTypeSupported(engineId, 'k', typeK)) {
    issues.push({
      id: 'cache-type-k-unsupported',
      level: 'warning',
      message: `当前引擎不认识 K 缓存类型「${typeK}」，可用的有：${table.k.join(' / ')}。`,
    })
  }
  if (!cacheTypeSupported(engineId, 'v', typeV)) {
    issues.push({
      id: 'cache-type-v-unsupported',
      level: 'warning',
      message: `当前引擎的 V 缓存只支持 ${table.v.join(' / ')}，「${typeV}」会在启动时被拒绝。`,
    })
  }
  // 量化 V 缓存需要 Flash Attention；开关关掉时引擎走 auto，这里只提示代价。
  if (typeV && !['f32', 'f16', 'bf16'].includes(typeV)) {
    issues.push({
      id: 'cache-type-v-quantized',
      level: 'info',
      message: `V 缓存用了量化档「${typeV}」：省显存，但长上下文下的回答质量通常比 K 缓存量化掉得更多，显存够就保持 f16。`,
    })
  }
  return issues
}

// 引擎不支持的开关 -> 去重后的配置字段名（UI 置灰用）。
export function engineIncompatibleConfigKeys(id) {
  return [...new Set(
    getEngineById(id).incompatibleParams.map(flag => FLAG_TO_CONFIG_KEY[flag]).filter(Boolean),
  )]
}

// 引擎不支持的开关 -> 去重后的中文名（界面提示用）。
// 非布尔参数里当前引擎不支持的字段（UI 置灰用，与布尔清单分开，避免污染 sanitize 语义）。
export function engineIncompatibleParamKeys(id) {
  return [...new Set(
    getEngineById(id).incompatibleParams.flatMap(flag => FLAG_TO_PARAM_KEY[flag] || []),
  )]
}

export function engineIncompatibleLabels(id) {
  return [...new Set(
    getEngineById(id).incompatibleParams.map(flag => FLAG_LABELS[flag] || flag),
  )]
}

export function getEngineLabel(id) {
  return getEngineById(id).label
}

// 依据 llama-server 可执行文件路径反推引擎。
export function detectEngineByPath(serverPath) {
  const text = String(serverPath || '').toLowerCase()
  if (!text) return DEFAULT_ENGINE_ID
  if (text.includes('kvmem')) return 'kvmem'
  if (text.includes('prism')) return 'prismml'
  return DEFAULT_ENGINE_ID
}

// 启动前校验：引擎不支持的开关若被打开，抛错并说明是哪个开关。
// 「这个字段算不算留了值」——与主进程 hasValue() 同语义。
export function hasMeaningfulValue(value) {
  return value !== undefined && value !== null && String(value).trim() !== ''
}

export function assertEngineCompatible(engineId, config = {}) {
  const engine = getEngineById(engineId)
  for (const flag of engine.incompatibleParams) {
    const boolKey = FLAG_TO_CONFIG_KEY[flag]
    if (boolKey) {
      if (config[boolKey]) {
        throw new Error(`引擎 ${engine.label} 不支持 ${FLAG_LABELS[flag] || flag}，请关闭`)
      }
      continue
    }
    // 非布尔参数：留了值就等于会拼进命令行，同样要拦。
    const trigger = (FLAG_TO_PARAM_KEY[flag] || [])[0]
    if (trigger && hasMeaningfulValue(config[trigger])) {
      throw new Error(`引擎 ${engine.label} 不支持 ${FLAG_LABELS[flag] || flag}，请留空`)
    }
  }
}

// 把当前引擎不支持的开关强制关掉。
// 预设文件是用户资产，不该指望它写死这些开关；能力约束必须由代码兜底，
// 否则一旦从原装目录播种预设、或用户手改预设，KVMem 预设会在启动时被自己的校验拒绝。
export function sanitizeEngineParams(config = {}) {
  const engineId = detectEngineByPath(config.llama_server_path)
  const boolKeys = engineIncompatibleConfigKeys(engineId)
  const paramKeys = paramTriggerKeys(getEngineById(engineId))
  if (!boolKeys.length && !paramKeys.length) return { ...config }
  const next = { ...config }
  for (const key of boolKeys) next[key] = false
  // 非布尔参数清空 —— 置 false 会被 hasValue() 当成有值，拼出 `--x false`。
  for (const key of paramKeys) next[key] = ''
  return next
}

// ---------- 预设 vs 外观：两者必须解耦 ----------
//
// 真实事故(2026-09-28 复现)：预设是「怎么跑模型」，外观是「用户怎么看界面」。
// 但「另存为新预设」提交的是整个 state.config，里面含 theme_mode / chat_font，
// buildToml 又照单全收 —— 于是保存预设时把当时的外观腌进了文件。
// 之后加载该预设，applyPreset 合并配置，render() 开头的 applyAppearancePreferences()
// 立刻把界面翻成预设里那个外观。实测：light -> dark、font default -> readable。
//
// 因此三处设防：写入前剥掉、读取时剔除、应用时保留当前值。
export const UI_PREFERENCE_KEYS = ['theme_mode', 'chat_font']

// 写入预设前剥掉外观键（预设文件里不该有它们）。
export function stripUiPreferences(config = {}) {
  const next = { ...config }
  for (const key of UI_PREFERENCE_KEYS) delete next[key]
  return next
}

// 路径类字段：预设里留空表示「沿用当前配置」，而不是「清空」。
//
// 为什么需要这条：预设文件经过 normalizeConfig 会把所有字段填满（路径填成空串），
// 而套用预设是整份覆盖 —— 于是一个不含模型路径的预设（示例预设、只带参数的共享预设）
// 会把用户已经配好的模型/引擎路径清掉，直接变成起不来的状态。
export const PRESET_PATH_FIELDS = [
  'model', 'mmproj', 'llama_server_path', 'llama_bin_dir', 'launcher_path', 'config_path', 'lora_paths',
]

// 套用预设：参数一律以预设为准，路径类字段则「预设里没写就保持当前」。
export function applyPresetOverCurrent(current = {}, incoming = {}) {
  const next = { ...current, ...incoming }
  for (const field of PRESET_PATH_FIELDS) {
    const hasIncoming = String(incoming[field] ?? '').trim() !== ''
    const hasCurrent = String(current[field] ?? '').trim() !== ''
    if (!hasIncoming && hasCurrent) next[field] = current[field]
  }
  return next
}
// 应用预设时保留当前外观 —— 即使文件里残留了外观键（旧文件）也不会改界面。
export function preserveUiPreferences(current = {}, incoming = {}) {
  const next = { ...incoming }
  for (const key of UI_PREFERENCE_KEYS) {
    if (current[key] !== undefined) next[key] = current[key]
  }
  return next
}


// ---------- 附加参数校验 ----------

// 从引擎自己的 --help 文本里收集它承认的所有开关。
// 不维护硬编码清单：引擎升个版本就可能加/删开关，问它自己是唯一不会过期的办法。
// 已踩过的坑：extra_args 里写 "--kv q8"（llama.cpp 并没有 --kv），
// 引擎 "error: invalid argument: --kv" 当场退出，而界面上一点反馈都没有。
export function recognizedFlagsFromHelp(helpText) {
  const flags = new Set()
  const pattern = /(?:^|[\s,(])(-{1,2}[A-Za-z][A-Za-z0-9-]*)(?=[\s,=)\]:"']|$)/gm
  for (const match of String(helpText || '').matchAll(pattern)) {
    flags.add(match[1])
  }
  return flags
}

// 找出 tokens 里引擎不认识的开关。
// 拿不到 help 时一律不报（宁可漏报也不能误伤正常启动）。
export function unknownExtraFlags(tokens = [], helpText = '') {
  const known = recognizedFlagsFromHelp(helpText)
  if (!known.size) return []
  const unknown = new Set()
  for (const token of tokens) {
    if (typeof token !== 'string' || !token.startsWith('-')) continue
    if (/^-\d/.test(token)) continue // 负数（如 --main-gpu -1 的值）不是开关
    const flag = token.split('=')[0]
    if (!known.has(flag)) unknown.add(flag)
  }
  return [...unknown]
}

// 把不认识的开关拼成一句能直接照着改的报错。
export function describeUnknownFlags(flags = []) {
  if (!flags.length) return ''
  return `引擎不认识这些附加参数：${flags.join('、')}。请检查「追加参数」，或先用 llama-server --help 确认写法。`
}

// ---------- 预设命名 ----------

export const PRESET_SUFFIX = '.config.toml'

export function presetFileName(name) {
  return `${String(name || '').trim()}${PRESET_SUFFIX}`
}

export function presetNameFromFile(fileName) {
  const text = String(fileName || '')
  return text.endsWith(PRESET_SUFFIX) ? text.slice(0, -PRESET_SUFFIX.length) : ''
}

// 列出预设名：过滤非预设文件，并按「Bonsai → Qwen → 其他」分组，组内按本地化字典序。
export function sortPresetNames(names = []) {
  const rank = name => {
    if (name.startsWith('Bonsai')) return 0
    if (name.startsWith('Qwen')) return 1
    return 2
  }
  return [...names].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
}

export function listPresetNamesFromFiles(fileNames = []) {
  return sortPresetNames(
    fileNames
      .map(presetNameFromFile)
      .filter(name => name.length > 0),
  )
}

// ---------- 预设元信息 ----------

function fileNameOf(value) {
  // Windows 与 POSIX 分隔符都要处理，否则 "E:\\models\\a.gguf" 会整串当成文件名。
  return String(value || '').split(/[\\/]/).filter(Boolean).pop() || ''
}

export function classifyModelType(fileName) {
  const text = String(fileName || '')
  if (text.includes('Bonsai')) return '三元 Bonsai'
  if (text.includes('Qwen')) return 'Qwen'
  if (text.includes('Ornith')) return 'Ornith'
  return '未知'
}

export function extractPresetMetadata(name, config) {
  if (!config) return null
  const engineId = detectEngineByPath(config.llama_server_path)
  const engine = getEngineById(engineId)
  const modelName = fileNameOf(config.model)
  return {
    name,
    engine: engine.label,
    engineId,
    ctxSize: config.ctx_size || 0,
    model: modelName,
    modelType: classifyModelType(modelName),
    port: config.port || 0,
    temp: config.temp || 0,
    topK: config.top_k || 0,
    topP: config.top_p || 0,
    nGpuLayers: config.n_gpu_layers || 0,
    threads: config.threads || 0,
  }
}

// ---------- 路径解析 ----------

// path.dirname 的纯字符串版本（避免为可测逻辑引入 node:path）。
function parentDir(value) {
  const text = String(value || '')
  const index = Math.max(text.lastIndexOf('\\'), text.lastIndexOf('/'))
  return index > 0 ? text.slice(0, index) : ''
}

// 决定 llama-server 所在目录。
// 关键优先级：**本次输入显式给出的路径** 必须高于从默认配置继承来的目录，
// 否则 KVMem/PrismML 预设会被统一改写成默认的 llama.cpp 目录，引擎切换形同失效。
export function resolveEngineBinDir({
  incomingServerPath,
  incomingBinDir,
  inheritedBinDir,
  inheritedServerPath,
  fallbackServerPath,
} = {}) {
  const explicitBinDir = String(incomingBinDir || '').trim()
  if (explicitBinDir) return explicitBinDir
  const explicitServerPath = String(incomingServerPath || '').trim()
  if (explicitServerPath) return parentDir(explicitServerPath)
  const inherited = String(inheritedBinDir || '').trim()
  if (inherited) return inherited
  return parentDir(String(inheritedServerPath || fallbackServerPath || ''))
}

// 在候选目录里挑第一个真实存在的；用于「工作区实际布局」这类允许变化的位置。
export function pickExistingDir(candidates = [], exists = () => false) {
  for (const candidate of candidates) {
    if (candidate && exists(candidate)) return candidate
  }
  return candidates.find(Boolean) || ''
}

// ---------- 服务端可执行文件名：别把引擎改写成同一个名字 ----------
//
// 真实事故(2026-09-29)：normalizeConfig 把 llama_server_path 写死成
//   path.join(llamaBinDir, 'llama-server.exe')
// 于是 Bonsai2-27B-PQ2-KVMem 预设声明的
//   00_models_Base\kvmem\bin\llama-kvmem-server.exe
// 被改写成 ...\kvmem\bin\llama-server.exe —— 那个文件**根本不存在**
// （该目录只有 llama-kvmem-server.exe / llama-kvmem-cli.exe）。
// 表现：加载预设一切正常，点「启动」报找不到可执行文件。
// 这就是「模型预设没有正确匹配对应后端引擎」。
//
// 正确做法：目录与文件名分开解析 —— 目录按 resolveEngineBinDir 的优先级，
// 文件名优先沿用调用方声明的那个（且必须像 exe），再拿目录真实清单校正。

// 从路径里取文件名（Windows / POSIX 分隔符都要处理）。
export function serverFileNameFromPath(value) {
  const name = String(value || '').split(/[\\/]/).filter(Boolean).pop() || ''
  return /\.exe$/i.test(name) ? name : ''
}

// 目录里挑服务端：优先调用方声明名，其次两种常见命名，最后任何 llama*server*.exe。
// fileNames 由调用方（主进程）传真实目录清单，本函数保持纯逻辑、可单测。
export function pickServerExecutable(payload = {}) {
  const declared = serverFileNameFromPath(payload?.declaredName || payload?.declaredPath || '')
  const list = Array.isArray(payload?.fileNames)
    ? payload.fileNames.map(name => String(name)).filter(name => /\.exe$/i.test(name))
    : []
  if (declared && list.includes(declared)) return declared
  for (const name of ['llama-server.exe', 'llama-kvmem-server.exe']) {
    if (list.includes(name)) return name
  }
  const loose = list.find(name => /^llama.*server.*\.exe$/i.test(name))
    || list.find(name => /server.*\.exe$/i.test(name))
  // 目录读不到（不存在/无权限）时退回声明名，最后才是通用默认名。
  return loose || declared || 'llama-server.exe'
}

// ---------- 显存守卫 ----------

export const VRAM_WARN_THRESHOLD_MIB = 1000

// 采样结果来自 nvidia-smi：total/used 为 MiB。
export function vramSnapshot(raw) {
  const total = Number(raw?.total) || 0
  const used = Number(raw?.used) || 0
  const available = Math.max(0, total - used)
  return {
    total,
    used,
    available,
    warning: total > 0 && available < VRAM_WARN_THRESHOLD_MIB,
  }
}
