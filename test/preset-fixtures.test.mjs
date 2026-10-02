import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  assertEngineCompatible,
  detectEngineByPath,
  listPresetNamesFromFiles,
  sanitizeEngineParams,
} from '../desktop/lib/preset-engine.mjs'

// 真实预设的固定数据校验。
//
// 层次很重要：KVMem 不支持 embeddings / continuous_batching / MoE 卸载，
// 但**预设文件是用户资产，不该指望它写死这些开关**（上一轮曾直接改用户数据，
// 结果污染了原装目录）。正确的守门位置是代码层 sanitizeEngineParams()，
// 所以这里断言的是「兜底之后一定可启动」，而不是「文件里一定写了 false」。
//
// 数据根已独立到应用自己的目录。
//
// 公开仓库注意：这里**不能**出现开发机的绝对路径。真实预设分两种，对应两个目录：
//   configs/          —— 作者本机运行期的预设（个人资产，不进仓库，clone 后不存在）
//   desktop/configs/  —— 随包分发的示例预设（进仓库，任何 clone 都有）
// 依赖前者的断言在公开仓库里应当**跳过**，而不是失败 —— 否则别人 clone 完 npm test 一片红。
const DEV_PRESET_DIR = path.resolve(import.meta.dirname, '..', 'configs')
const SEED_PRESET_DIR = path.resolve(import.meta.dirname, '..', 'desktop', 'configs')
const PRESET_DIR =
  process.env.DSH_PRESET_DIR ||
  (existsSync(DEV_PRESET_DIR) ? DEV_PRESET_DIR : SEED_PRESET_DIR)

const presetAvailable = existsSync(PRESET_DIR)
// 只有真的在作者那批预设上跑时，才断言「10 个」「5 个 Bonsai」这类清单事实。
const devPresetsAvailable = presetAvailable && path.resolve(PRESET_DIR) === path.resolve(DEV_PRESET_DIR)
const DEV_ONLY_SKIP = '没有作者自用的预设集（公开仓库克隆后的正常情况）'

// 与主进程 parseTomlValue 相同的取值方式（含 JSON.parse 失败后的兜底）。
function tomlValue(text) {
  const value = String(text).trim()
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    }
  }
  if (value === 'true') return true
  if (value === 'false') return false
  return value
}

function readPresetFile(fileName) {
  const result = {}
  const raw = readFileSync(path.join(PRESET_DIR, fileName), 'utf8')
  for (const originalLine of raw.split(/\r?\n/)) {
    const line = originalLine.replace(/#.*$/, '').trim()
    if (!line || line.startsWith('[')) continue
    const equalIndex = line.indexOf('=')
    if (equalIndex < 0) continue
    result[line.slice(0, equalIndex).trim()] = tomlValue(line.slice(equalIndex + 1))
  }
  return result
}

function presetFiles(prefix) {
  return readdirSync(PRESET_DIR)
    .filter(name => name.endsWith('.config.toml'))
    .filter(name => (prefix ? name.startsWith(prefix) : true))
}

test('真实预设目录能列出 10 个预设', t => {
  if (!devPresetsAvailable) return t.skip(DEV_ONLY_SKIP)
  const names = listPresetNamesFromFiles(readdirSync(PRESET_DIR))
  assert.equal(names.length, 10, `实际列出 ${names.length} 个：${names.join(', ')}`)
  assert.equal(names.filter(name => name.startsWith('Bonsai')).length, 5)
  assert.equal(names.filter(name => name.startsWith('Qwen')).length, 5)
})

test('每个真实预设经 sanitizeEngineParams 兜底后都可启动', t => {
  if (!devPresetsAvailable) return t.skip(DEV_ONLY_SKIP)
  const files = presetFiles()
  assert.ok(files.length > 0)
  for (const file of files) {
    // 先铺上 defaultConfig 的默认值，再叠加文件内容——与主进程 normalizeConfig 一致。
    const config = {
      cpu_moe: false,
      embeddings: false,
      continuous_batching: true,
      ...readPresetFile(file),
    }
    const engineId = detectEngineByPath(config.llama_server_path)
    assert.doesNotThrow(
      () => assertEngineCompatible(engineId, sanitizeEngineParams(config)),
      `${file} 在引擎 ${engineId} 下兜底后仍不可启动`,
    )
  }
})

test('sanitizeEngineParams 关掉当前引擎不支持的开关，且不就地改写入参', () => {
  const kvmem = {
    llama_server_path: 'D:\\llama\\runtime\\kvmem-gui\\llama-server.exe',
    cpu_moe: true,
    embeddings: true,
    continuous_batching: true,
  }
  const safe = sanitizeEngineParams(kvmem)
  assert.equal(safe.cpu_moe, false)
  assert.equal(safe.embeddings, false)
  assert.equal(safe.continuous_batching, false)
  assert.equal(kvmem.continuous_batching, true, '入参不应被就地改写')
  assert.doesNotThrow(() => assertEngineCompatible('kvmem', safe))

  const llama = {
    llama_server_path: 'D:\\llama\\runtime\\llama.cpp\\bin\\llama-server.exe',
    continuous_batching: true,
  }
  assert.equal(sanitizeEngineParams(llama).continuous_batching, true, 'llama.cpp 不应被波及')
})

test('Bonsai 预设全部指向 KVMem，不兼容开关由代码兜底', t => {
  if (!devPresetsAvailable) return t.skip(DEV_ONLY_SKIP)
  const files = presetFiles('Bonsai')
  assert.equal(files.length, 5)
  for (const file of files) {
    const config = readPresetFile(file)
    assert.match(String(config.llama_server_path || ''), /kvmem/i, `${file} 未指向 kvmem 引擎`)
    assert.equal(detectEngineByPath(config.llama_server_path), 'kvmem', `${file} 引擎识别错误`)
    // 文件里可以没有这两个开关（用户资产不写死），但兜底后必须是关的。
    const safe = sanitizeEngineParams({ ...config, continuous_batching: true, embeddings: true })
    assert.equal(safe.continuous_batching, false, `${file} 兜底后仍开着 continuous_batching`)
    assert.equal(safe.embeddings, false, `${file} 兜底后仍开着 embeddings`)
  }
})

test('Qwen 预设指向 llama.cpp 且端口与引擎吻合', t => {
  if (!devPresetsAvailable) return t.skip(DEV_ONLY_SKIP)
  const files = presetFiles('Qwen')
  assert.equal(files.length, 5)
  for (const file of files) {
    const config = readPresetFile(file)
    assert.equal(detectEngineByPath(config.llama_server_path), 'llama-cpp', `${file} 引擎识别错误`)
    assert.equal(Number(config.port), 8080, `${file} 端口应为 8080`)
  }
})

test('KVMem 预设端口为 18200，避免与 llama.cpp 抢占', t => {
  if (!devPresetsAvailable) return t.skip(DEV_ONLY_SKIP)
  for (const file of presetFiles('Bonsai')) {
    assert.equal(Number(readPresetFile(file).port), 18200, `${file} 端口应为 18200`)
  }
})

test('每个预设都声明了模型与引擎二进制路径', t => {
  if (!devPresetsAvailable) return t.skip(DEV_ONLY_SKIP)
  for (const file of presetFiles()) {
    const config = readPresetFile(file)
    assert.ok(String(config.llama_server_path || '').trim(), `${file} 缺少 llama_server_path`)
    assert.ok(String(config.model || '').trim(), `${file} 缺少 model`)
  }
})

// ---------- 随包分发的预设（会被播种给每个新用户）----------

const SEED_DIR = path.resolve(import.meta.dirname, '..', 'desktop', 'configs')


// 随包目录的读取：readPresetFile 是绑定 PRESET_DIR 的，这里需要一个独立的，
// 否则会拼出「configs<绝对路径>」这种荒谬路径。
function readSeedPreset(fileName) {
  const result = {}
  const raw = readFileSync(path.join(SEED_DIR, fileName), 'utf8')
  for (const originalLine of raw.split(/\r?\n/)) {
    const line = originalLine.replace(/#.*$/, '').trim()
    if (!line || line.startsWith('[')) continue
    const equalIndex = line.indexOf('=')
    if (equalIndex < 0) continue
    const key = line.slice(0, equalIndex).trim()
    let value = line.slice(equalIndex + 1).trim()
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1)
    if (/^-?\d+$/.test(value)) value = Number(value)
    else if (value === 'true' || value === 'false') value = value === 'true'
    result[key] = value
  }
  return result
}

test('随包预设要么完整声明路径，要么是完全不含路径的参数模板 —— 不允许半套', t => {
  if (!existsSync(SEED_DIR)) return t.skip('随包预设目录不存在')
  const files = readdirSync(SEED_DIR).filter(name => name.endsWith('.config.toml'))
  assert.ok(files.length >= 1, '发布版应至少带一个示例预设（用户第一次打开时不至于是空的）')
  for (const file of files) {
    const config = readSeedPreset(file)
    const server = String(config.llama_server_path || '').trim()
    const model = String(config.model || '').trim()
    const bothEmpty = !server && !model
    const bothSet = Boolean(server) && Boolean(model)
    assert.ok(
      bothEmpty || bothSet,
      `${file} 是「半套」预设：llama_server_path=${server ? '有' : '空'} / model=${model ? '有' : '空'}。` +
      '要么两个都写（自包含预设），要么两个都空（参数模板，套用时沿用当前配置）——' +
      '半套会在用户机器上指向一个不存在的位置。',
    )
  }
})

test('随包预设不得含作者机器上的路径', t => {
  if (!existsSync(SEED_DIR)) return t.skip('随包预设目录不存在')
  for (const file of readdirSync(SEED_DIR).filter(name => name.endsWith('.config.toml'))) {
    const raw = readFileSync(path.join(SEED_DIR, file), 'utf8')
    // 只看生效行：注释里的示例占位（# mmproj = "G:\\..."）是合法文档
    const active = raw.split(/\r?\n/).filter(l => !l.trim().startsWith("#")).join(String.fromCharCode(10))
    assert.doesNotMatch(active, /[A-Za-z]:\\/, `${file} 的生效配置里出现了盘符路径，会把作者的目录布局带给每个用户`)
  }
})

test('随包预设不得残留其他引擎的专属参数', t => {
  if (!existsSync(SEED_DIR)) return t.skip('随包预设目录不存在')
  for (const file of readdirSync(SEED_DIR).filter(name => name.endsWith('.config.toml'))) {
    const config = readSeedPreset(file)
    const extra = String(config.extra_args || '')
    // 事故：示例预设曾是从 KVMem 预设复制来的，extra_args 里带着 --kvmem-* 与
    // 写死的 --alias。发给用 llama.cpp 的用户会直接 unknown flag 启动失败。
    assert.doesNotMatch(extra, /--kvmem-/, `${file} 的 extra_args 里有 KVMem 专属参数`)
    assert.doesNotMatch(extra, /--alias\s/, `${file} 的 extra_args 里写死了 --alias`)
  }
})
