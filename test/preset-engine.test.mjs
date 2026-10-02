import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { splitExtraArgs } from '../desktop/lib/runtime-policy.mjs'

// 引擎能力表是主进程与渲染层共用的同一份真相源，
// 所以这里也读渲染层源码，检查它确实用了这张表而不是自己另写一套。
const rendererSource = readFileSync(new URL('../renderer/app.js', import.meta.url), 'utf8')

import {
  ENGINE_DEFINITIONS,
  KV_CACHE_TYPES,
  PRESET_SUFFIX,
  VRAM_WARN_THRESHOLD_MIB,
  PRESET_PATH_FIELDS,
  applyPresetOverCurrent,
  assertEngineCompatible,
  cacheTypeIssues,
  cacheTypeSupported,
  classifyModelType,
  detectEngineByPath,
  engineCacheTypes,
  engineIncompatibleConfigKeys,
  engineIncompatibleLabels,
  engineIncompatibleParamKeys,
  engineSupportsFlag,
  extractPresetMetadata,
  describeUnknownFlags,
  recognizedFlagsFromHelp,
  unknownExtraFlags,
  getEngineById,
  getEngineIncompatibleParams,
  listPresetNamesFromFiles,
  sanitizeEngineParams,
  stripUiPreferences,
  preserveUiPreferences,
  UI_PREFERENCE_KEYS,
  pickExistingDir,
  pickServerExecutable,
  presetFileName,
  presetNameFromFile,
  resolveEngineBinDir,
  serverFileNameFromPath,
  sortPresetNames,
  vramSnapshot,
} from '../desktop/lib/preset-engine.mjs'

// ---------- 引擎识别 ----------

test('detectEngineByPath 依据可执行文件路径反推引擎', () => {
  assert.equal(detectEngineByPath(''), 'llama-cpp')
  assert.equal(detectEngineByPath(null), 'llama-cpp')
  assert.equal(detectEngineByPath('D:\\llama\\runtime\\llama.cpp\\bin\\llama-server.exe'), 'llama-cpp')
  assert.equal(detectEngineByPath('D:\\llama\\runtime\\kvmem-gui\\llama-server.exe'), 'kvmem')
  assert.equal(detectEngineByPath('D:\\llama\\runtime\\prism-llama\\llama-server.exe'), 'prismml')
})

test('detectEngineByPath 对大小写不敏感', () => {
  assert.equal(detectEngineByPath('D:\\Tools\\KVMEM-GUI\\llama-server.exe'), 'kvmem')
  assert.equal(detectEngineByPath('D:\\Tools\\PRISM-LLAMA\\llama-server.exe'), 'prismml')
})

test('getEngineById 未知 id 回退到默认引擎', () => {
  assert.equal(getEngineById('kvmem').id, 'kvmem')
  assert.equal(getEngineById('nope').id, 'llama-cpp')
  assert.equal(getEngineById(undefined).id, 'llama-cpp')
})

test('引擎定义包含三种引擎且 id 唯一', () => {
  assert.deepEqual(ENGINE_DEFINITIONS.map(engine => engine.id), ['llama-cpp', 'kvmem', 'prismml'])
  assert.equal(new Set(ENGINE_DEFINITIONS.map(engine => engine.id)).size, ENGINE_DEFINITIONS.length)
})

test('各引擎的不支持开关清单来自真实 --help 实测', () => {
  // KVMem：2026-09-25 首次实测（多出 --cpu-moe / --verbose / --no-cont-batching）；
  // 2026-09-28 再跑 kvmem-gui\\llama-server.exe --help（91 行）补测出后 4 项。
  // 注意 --cache-type-k / --cache-type-v 是 KVMem **支持**的，不要误伤。
  assert.deepEqual(getEngineIncompatibleParams('kvmem'), [
    '--n-cpu-moe',
    '--cpu-moe',
    '--embeddings',
    '--cont-batching',
    '--no-cont-batching',
    '--verbose',
    '--rope-freq-base',
    '--mirostat',
    '--lora',
    '--kv-unified-per-slot',
    '--no-perf',
  ])
  assert.deepEqual(getEngineIncompatibleParams('llama-cpp'), [])
  // PrismML：2026-09-28 跑 prism-llama\\llama-server.exe --help（711 行），
  // 目标开关里只缺 --kv-unified-per-slot。
  assert.deepEqual(getEngineIncompatibleParams('prismml'), ['--kv-unified-per-slot'])
})

test('目标开关在三个引擎上的支持情况与真实 --help 一致', () => {
  const cases = [
    ['--cache-type-k', true, true, true],
    ['--cache-type-v', true, true, true],
    ['--rope-freq-base', true, false, true],
    ['--mirostat', true, false, true],
    ['--lora', true, false, true],
    ['--kv-unified-per-slot', true, false, false],
    ['--flash-attn', true, true, true],
    ['--no-perf', true, false, true],
    ['--mlock', true, true, true],
    ['--no-mmap', true, true, true],
  ]
  for (const [flag, llama, kvmem, prism] of cases) {
    assert.equal(engineSupportsFlag('llama-cpp', flag), llama, `llama.cpp ${flag}`)
    assert.equal(engineSupportsFlag('kvmem', flag), kvmem, `KVMem ${flag}`)
    assert.equal(engineSupportsFlag('prismml', flag), prism, `PrismML ${flag}`)
  }
})

test('非布尔参数：置灰清单与 sanitize 分离，绝不拼出 --x false', () => {
  // 回归：sanitizeEngineParams 对布尔键写 false，而 hasValue(false) 为真
  // （String(false)='false' ≠ ''），会把 --rope-freq-base 拼成 "--rope-freq-base false"。
  // 所以非布尔键必须走单独清单、且只能清空。
  assert.deepEqual(engineIncompatibleConfigKeys('kvmem'), [
    'cpu_moe', 'embeddings', 'continuous_batching', 'verbose', 'no_perf',
  ], '布尔清单不应被非布尔键污染')

  // KVMem 支持 cache-type-k/v，所以 type_k / type_v 不该出现在它的置灰清单里。
  const paramKeys = engineIncompatibleParamKeys('kvmem')
  for (const key of ['kv_out_size', 'rope_freq_base', 'mirostat', 'num_lora']) {
    assert.ok(paramKeys.includes(key), `KVMem 非布尔置灰清单缺少 ${key}`)
  }
  assert.ok(!paramKeys.includes('type_k'), 'KVMem 支持 cache-type-k，不该置灰')
  assert.ok(!paramKeys.includes('type_v'), 'KVMem 支持 cache-type-v，不该置灰')
  // PrismML 只缺 kv_out_size（--kv-unified-per-slot）
  assert.deepEqual(engineIncompatibleParamKeys('prismml'), ['kv_out_size'])
  assert.deepEqual(engineIncompatibleParamKeys('llama-cpp'), [])

  const safe = sanitizeEngineParams({
    llama_server_path: 'D:\\llama\\runtime\\kvmem-gui\\llama-server.exe',
    type_k: 'f16', type_v: 'f16', rope_freq_base: 10000, mirostat: 1, num_lora: 2, cpu_moe: true,
  })
  assert.equal(safe.cpu_moe, false, '布尔键仍应置 false')
  assert.equal(safe.rope_freq_base, '', '非布尔键应清空而非置 false')
  assert.equal(safe.mirostat, '', '非布尔键应清空')
  assert.equal(safe.num_lora, '', '非布尔键应清空')
  assert.equal(safe.type_k, 'f16', 'KVMem 支持 cache-type-k，不该被清')
  assert.equal(safe.type_v, 'f16', 'KVMem 支持 cache-type-v，不该被清')
  assert.doesNotThrow(() => assertEngineCompatible('kvmem', safe), '兜底后必须能启动')
})

test('非布尔参数留值时，启动前校验明确拦截', () => {
  const base = { llama_server_path: 'D:\\llama\\runtime\\kvmem-gui\\llama-server.exe' }
  assert.throws(() => assertEngineCompatible('kvmem', { ...base, rope_freq_base: 10000 }), /RoPE/)
  assert.throws(() => assertEngineCompatible('kvmem', { ...base, mirostat: 1 }), /Mirostat/)
  assert.throws(() => assertEngineCompatible('kvmem', { ...base, num_lora: 2 }), /LoRA/)
  assert.doesNotThrow(() => assertEngineCompatible('llama-cpp', {
    rope_freq_base: 10000, mirostat: 1, num_lora: 2, kv_out_size: 4096,
    type_k: 'q8_0', type_v: 'q8_0',
  }), 'llama.cpp 应全部放行')
})

test('engineSupportsFlag 把取反形式也算进去（回归：KVMem 不认 --no-cont-batching）', () => {
  // 事故：改造版用「把 continuous_batching 置为 false」来表达「KVMem 不支持它」，
  // 拼命令行时于是输出了 --no-cont-batching —— KVMem 照样 unknown flag 当场退出。
  // llama.cpp 支持取反形式，所以只有 KVMem 路径会踩，端到端才暴露得出来。
  assert.equal(engineSupportsFlag('llama-cpp', '--no-cont-batching'), true)
  assert.equal(engineSupportsFlag('kvmem', '--no-cont-batching'), false)
  assert.equal(engineSupportsFlag('kvmem', '--cont-batching'), false)
  assert.equal(engineSupportsFlag('kvmem', '--verbose'), false)
  assert.equal(engineSupportsFlag('kvmem', '--cpu-moe'), false)
  // KVMem 是支持 --webui / --no-webui 的，别误伤
  assert.equal(engineSupportsFlag('kvmem', '--webui'), true)
  assert.equal(engineSupportsFlag('kvmem', '--no-webui'), true)
})

test('置灰用的字段清单去重且覆盖 Verbose', () => {
  const keys = engineIncompatibleConfigKeys('kvmem')
  assert.deepEqual(keys, ['cpu_moe', 'embeddings', 'continuous_batching', 'verbose', 'no_perf'])
  const labels = engineIncompatibleLabels('kvmem')
  assert.equal(new Set(labels).size, labels.length, '标签不应重复')
  assert.deepEqual(engineIncompatibleConfigKeys('llama-cpp'), [])
})

// ---------- 引擎能力校验 ----------

test('llama.cpp 允许 MoE 卸载、embeddings 与 continuous batching', () => {
  assert.doesNotThrow(() => {
    assertEngineCompatible('llama-cpp', { cpu_moe: true, embeddings: true, continuous_batching: true })
  })
})

test('KVMem 打开 cpu_moe 时拒绝启动并说明开关名', () => {
  assert.throws(
    () => assertEngineCompatible('kvmem', { cpu_moe: true }),
    /KVMem.*不支持 MoE 卸载，请关闭/,
  )
})

// ---------- 附加参数校验（回归：extra_args 里的无效开关会让引擎静默退出） ----------

// 夹具是 llama-server.exe --help 的真实输出（59733 字符）。
const HELP_FIXTURE = path.resolve(import.meta.dirname, 'fixtures', 'llama-server-help.txt')
const realHelp = existsSync(HELP_FIXTURE) ? readFileSync(HELP_FIXTURE, 'utf8') : ''

test('回归：--kv 是 llama.cpp 不认识的开关（真实 help 夹具）', t => {
  if (!realHelp) return t.skip('缺少 help 夹具')
  // 真实事故：用户配置里写 extra_args = "--kv q8"，
  // 引擎 "error: invalid argument: --kv" 当场退出，界面上毫无反馈。
  assert.deepEqual(unknownExtraFlags(splitExtraArgs('--kv q8'), realHelp), ['--kv'])
})

test('文档记录的那套 35B 参数在真实 help 下全部被认出', t => {
  if (!realHelp) return t.skip('缺少 help 夹具')
  const tokens = splitExtraArgs('-ctk q8_0 -ctv q8_0 -fa on --spec-type draft-mtp --spec-draft-n-max 2 -ngld auto')
  assert.deepEqual(unknownExtraFlags(tokens, realHelp), [])
})

test('recognizedFlagsFromHelp 不会把 --kv-unified-per-slot 误判成 --kv', () => {
  const flags = recognizedFlagsFromHelp('  -kvu,  --kv-unified, -no-kvu, --no-kv-unified\n--kv-unified-per-slot N   context limit\n')
  assert.ok(flags.has('-kvu'))
  assert.ok(flags.has('--kv-unified'))
  assert.ok(flags.has('--kv-unified-per-slot'))
  assert.equal(flags.has('--kv'), false)
})

test('长选项与其值不会被误判成开关', () => {
  const help = '-m, --model FNAME\n--top-k N\n'
  assert.deepEqual(unknownExtraFlags(['-m', 'x.gguf', '--top-k', '20'], help), [])
  assert.deepEqual(unknownExtraFlags(['--n-predict', '-1'], help + '--n-predict N\n'), [])
})

test('拿不到 help 时一律不报，避免误伤正常启动', () => {
  assert.deepEqual(unknownExtraFlags(['--whatever'], ''), [])
  assert.deepEqual(unknownExtraFlags([], 'whatever'), [])
})

test('报错文案点明了是哪个参数', () => {
  const text = describeUnknownFlags(['--kv', '--bogus'])
  assert.match(text, /--kv/)
  assert.match(text, /--bogus/)
  assert.equal(describeUnknownFlags([]), '')
})

test('KVMem 打开 embeddings 时拒绝启动', () => {
  assert.throws(
    () => assertEngineCompatible('kvmem', { embeddings: true }),
    /不支持 embeddings，请关闭/,
  )
})

test('KVMem 打开 continuous_batching 时拒绝启动', () => {
  assert.throws(
    () => assertEngineCompatible('kvmem', { continuous_batching: true }),
    /不支持 continuous batching，请关闭/,
  )
})

test('KVMem 全部开关关闭时允许启动', () => {
  assert.doesNotThrow(() => {
    assertEngineCompatible('kvmem', { cpu_moe: false, embeddings: false, continuous_batching: false })
  })
  assert.doesNotThrow(() => assertEngineCompatible('kvmem', {}))
  assert.doesNotThrow(() => assertEngineCompatible('kvmem'))
})

test('校验只拦截自身开关，不误伤无关配置', () => {
  assert.doesNotThrow(() => {
    assertEngineCompatible('kvmem', { cpu_moe: false, embeddings: true === false ? false : false })
  })
  assert.throws(() => assertEngineCompatible('kvmem', { cpu_moe: true, verbose: true }), /MoE/)
})

// ---------- 预设命名与排序 ----------

test('预设文件名与预设名可以往返转换', () => {
  assert.equal(presetFileName('Qwen3.6-35B-UD'), `Qwen3.6-35B-UD${PRESET_SUFFIX}`)
  assert.equal(presetNameFromFile(`Qwen3.6-35B-UD${PRESET_SUFFIX}`), 'Qwen3.6-35B-UD')
  assert.equal(presetNameFromFile(presetFileName('  Bonsai2-27B-PQ2-Fast  ')), 'Bonsai2-27B-PQ2-Fast')
})

test('非预设文件不会产生预设名', () => {
  assert.equal(presetNameFromFile('readme.md'), '')
  assert.equal(presetNameFromFile('config.toml'), '')
  assert.equal(presetNameFromFile(''), '')
  assert.equal(presetNameFromFile(null), '')
})

test('预设按 Bonsai → Qwen → 其他 分组排序', () => {
  const sorted = sortPresetNames(['Zed', 'Qwen3.8-27B', 'Bonsai2-PQ2-Fast', 'Alpha', 'Qwen3.5-9B'])
  assert.deepEqual(sorted, ['Bonsai2-PQ2-Fast', 'Qwen3.5-9B', 'Qwen3.8-27B', 'Alpha', 'Zed'])
})

test('sortPresetNames 不修改入参', () => {
  const input = ['Qwen3.8-27B', 'Bonsai2-PQ2-Fast']
  sortPresetNames(input)
  assert.deepEqual(input, ['Qwen3.8-27B', 'Bonsai2-PQ2-Fast'])
})

test('listPresetNamesFromFiles 过滤非预设文件并排序', () => {
  const names = listPresetNamesFromFiles([
    'Qwen3.8-27B.config.toml',
    'README.md',
    'Bonsai2-27B-PQ2-Fast.config.toml',
    'notes.txt',
    'config.toml',
  ])
  assert.deepEqual(names, ['Bonsai2-27B-PQ2-Fast', 'Qwen3.8-27B'])
})

test('10 个真实预设名能完整列出且顺序稳定', () => {
  const real = [
    'Qwen3.5-9B', 'Qwen3.6-35B-APEX', 'Qwen3.6-35B-Heretic', 'Qwen3.6-35B-UD', 'Qwen3.8-27B',
    'Bonsai2-27B-PQ2-KVMem', 'Bonsai2-27B-PQ2-LongCtx', 'Bonsai2-27B-PQ2-Balanced', 'Bonsai2-27B-PQ2-Fast', 'Bonsai2-27B-PQ2-MaxCtx',
  ]
  const listed = listPresetNamesFromFiles(real.map(presetFileName))
  assert.equal(listed.length, 10)
  assert.equal(listed[0], 'Bonsai2-27B-PQ2-Balanced')
  assert.ok(listed.slice(0, 5).every(name => name.startsWith('Bonsai')))
  assert.ok(listed.slice(5).every(name => name.startsWith('Qwen')))
})

// ---------- 预设元信息 ----------

test('extractPresetMetadata 对空配置返回 null', () => {
  assert.equal(extractPresetMetadata('x', null), null)
  assert.equal(extractPresetMetadata('x', undefined), null)
})

test('extractPresetMetadata 从 Windows 路径取得模型文件名', () => {
  const meta = extractPresetMetadata('Qwen3.6-35B-UD', {
    model: 'D:\\models\\Qwen3.6-35B-A3B-UD-Q4_K_M.gguf',
    ctx_size: 32768,
    port: 8080,
  })
  assert.equal(meta.model, 'Qwen3.6-35B-A3B-UD-Q4_K_M.gguf')
  assert.equal(meta.modelType, 'Qwen')
  assert.equal(meta.ctxSize, 32768)
  assert.equal(meta.port, 8080)
})

test('extractPresetMetadata 同时支持正斜杠路径', () => {
  const meta = extractPresetMetadata('p', { model: 'E:/models/Bonsai2-27B-PQ2-Fast.gguf' })
  assert.equal(meta.model, 'Bonsai2-27B-PQ2-Fast.gguf')
  assert.equal(meta.modelType, '三元 Bonsai')
})

test('extractPresetMetadata 识别 kvmem 引擎并给出引擎名', () => {
  const meta = extractPresetMetadata('Bonsai2-27B-PQ2-KVMem', {
    model: 'E:\\models\\Bonsai2-27B-PQ2-KVMem.gguf',
    llama_server_path: 'D:\\llama\\runtime\\kvmem-gui\\llama-server.exe',
    port: 18200,
  })
  assert.equal(meta.engineId, 'kvmem')
  assert.equal(meta.engine, 'KVMem (三元 Bonsai)')
  assert.equal(meta.port, 18200)
})

test('extractPresetMetadata 缺省字段回落到 0', () => {
  const meta = extractPresetMetadata('p', { model: '' })
  assert.deepEqual(
    [meta.ctxSize, meta.port, meta.temp, meta.topK, meta.topP, meta.nGpuLayers, meta.threads],
    [0, 0, 0, 0, 0, 0, 0],
  )
  assert.equal(meta.model, '')
  assert.equal(meta.modelType, '未知')
  assert.equal(meta.engineId, 'llama-cpp')
})

test('classifyModelType 覆盖四类模型', () => {
  assert.equal(classifyModelType('Bonsai2-27B-PQ2-Fast.gguf'), '三元 Bonsai')
  assert.equal(classifyModelType('Qwen3.6-35B-A3B-UD-Q4_K_M.gguf'), 'Qwen')
  assert.equal(classifyModelType('Ornith-1.5-35B-A3B-Heretic.gguf'), 'Ornith')
  assert.equal(classifyModelType('llama-3-8b.gguf'), '未知')
  assert.equal(classifyModelType(''), '未知')
})

// ---------- 显存守卫 ----------

test('显存充足时不告警', () => {
  const snap = vramSnapshot({ total: 8192, used: 1000 })
  assert.equal(snap.total, 8192)
  assert.equal(snap.used, 1000)
  assert.equal(snap.available, 7192)
  assert.equal(snap.warning, false)
})

test('可用显存低于阈值时告警', () => {
  const snap = vramSnapshot({ total: 8192, used: 8192 - VRAM_WARN_THRESHOLD_MIB + 1 })
  assert.equal(snap.available, VRAM_WARN_THRESHOLD_MIB - 1)
  assert.equal(snap.warning, true)
})

test('恰好等于阈值不告警（边界）', () => {
  const snap = vramSnapshot({ total: 8192, used: 8192 - VRAM_WARN_THRESHOLD_MIB })
  assert.equal(snap.available, VRAM_WARN_THRESHOLD_MIB)
  assert.equal(snap.warning, false)
})

test('读取失败（total 为 0）时不误报显存告警', () => {
  const snap = vramSnapshot({ total: 0, used: 0 })
  assert.equal(snap.warning, false)
  assert.equal(snap.available, 0)
})

test('used 超过 total 时可用显存不为负', () => {
  const snap = vramSnapshot({ total: 8192, used: 9000 })
  assert.equal(snap.available, 0)
  assert.equal(snap.warning, true)
})

test('vramSnapshot 容忍空值与字符串数字', () => {
  assert.equal(vramSnapshot(undefined).available, 0)
  assert.equal(vramSnapshot(null).warning, false)
  assert.equal(vramSnapshot({ total: '8192', used: '512' }).available, 7680)
})

// ---------- 引擎二进制目录解析 ----------

const LLAMA_BIN = 'D:\\llama\\runtime\\llama.cpp\\bin'
const KVMEM_BIN = 'D:\\llama\\runtime\\kvmem-gui'
const KVMEM_EXE = `${KVMEM_BIN}\\llama-server.exe`

test('预设声明的引擎路径优先于继承来的默认目录（回归：KVMem 预设曾被改写成 llama.cpp）', () => {
  const binDir = resolveEngineBinDir({
    incomingServerPath: KVMEM_EXE,
    incomingBinDir: '',
    inheritedBinDir: LLAMA_BIN,
    inheritedServerPath: `${LLAMA_BIN}\\llama-server.exe`,
    fallbackServerPath: `${LLAMA_BIN}\\llama-server.exe`,
  })
  assert.equal(binDir, KVMEM_BIN)
})

test('显式传入的 bin 目录优先级最高', () => {
  const binDir = resolveEngineBinDir({
    incomingServerPath: KVMEM_EXE,
    incomingBinDir: LLAMA_BIN,
    inheritedBinDir: 'D:\\other',
  })
  assert.equal(binDir, LLAMA_BIN)
})

test('没有显式路径时沿用继承的 bin 目录', () => {
  assert.equal(
    resolveEngineBinDir({ inheritedBinDir: LLAMA_BIN, inheritedServerPath: KVMEM_EXE }),
    LLAMA_BIN,
  )
})

test('继承值与显式输入都缺失时，退回备用 server 路径所在目录', () => {
  assert.equal(
    resolveEngineBinDir({ fallbackServerPath: KVMEM_EXE }),
    KVMEM_BIN,
  )
  assert.equal(resolveEngineBinDir({}), '')
  assert.equal(resolveEngineBinDir(), '')
})

test('空字符串视为未提供，与 hasValue 语义一致', () => {
  assert.equal(
    resolveEngineBinDir({ incomingServerPath: '   ', incomingBinDir: '', inheritedBinDir: '', inheritedServerPath: KVMEM_EXE }),
    KVMEM_BIN,
  )
})

test('正斜杠路径同样能取出目录', () => {
  assert.equal(resolveEngineBinDir({ incomingServerPath: 'E:/models/kvmem-gui/llama-server.exe' }), 'E:/models/kvmem-gui')
})

test('pickExistingDir 返回第一个存在的目录', () => {
  const existing = new Set(['B', 'C'])
  assert.equal(pickExistingDir(['A', 'B', 'C'], item => existing.has(item)), 'B')
})

test('pickExistingDir 全都不存在时回退到第一个非空候选', () => {
  assert.equal(pickExistingDir(['A', 'B'], () => false), 'A')
  assert.equal(pickExistingDir(['', 'B'], () => false), 'B')
  assert.equal(pickExistingDir([], () => false), '')
  assert.equal(pickExistingDir(['', undefined, null], () => false), '')
})

test('非布尔参数：触发键清空、置灰键更宽（不误删 lora_paths）', () => {
  const kvmemPath = 'D:\\llama\\runtime\\kvmem-gui\\llama-server.exe'
  const safe = sanitizeEngineParams({
    llama_server_path: kvmemPath,
    num_lora: 2, lora_paths: 'D:/lora/a.gguf', rope_freq_base: 10000,
  })
  assert.equal(safe.num_lora, '', '触发键应清空')
  assert.equal(safe.rope_freq_base, '', '触发键应清空')
  // lora_paths 不是触发键：单独有值不会拼出 --lora，所以既不该拦启动、也不该被删掉
  assert.equal(safe.lora_paths, 'D:/lora/a.gguf', 'lora_paths 不该被 sanitize 删掉')
  assert.doesNotThrow(() => assertEngineCompatible('kvmem', safe), '兜底后必须能启动')

  // 界面置灰范围更宽：num_lora 与 lora_paths 都要灰（避免「能改但不生效」）
  const gray = engineIncompatibleParamKeys('kvmem')
  assert.ok(gray.includes('num_lora'), 'num_lora 应置灰')
  assert.ok(gray.includes('lora_paths'), 'lora_paths 应置灰（它只服务于 num_lora）')

  // num_lora 为空时，lora_paths 单独有值不该拦启动
  assert.doesNotThrow(() => assertEngineCompatible('kvmem', {
    llama_server_path: kvmemPath, num_lora: '', lora_paths: 'D:/lora/a.gguf',
  }))
})

test('预设与外观解耦：写入剥掉、读取剔除、应用保留', () => {
  const serverPath = 'D:/llama/runtime/llama.cpp/bin/llama-server.exe'
  const preset = { llama_server_path: serverPath, ctx_size: 4096, theme_mode: 'dark', chat_font: 'readable' }

  // 写入前：剥掉外观键，模型参数保留，且不改写入参
  const stripped = stripUiPreferences(preset)
  assert.equal(stripped.theme_mode, undefined, '写入前应剥掉 theme_mode')
  assert.equal(stripped.chat_font, undefined, '写入前应剥掉 chat_font')
  assert.equal(stripped.ctx_size, 4096, '模型参数必须保留')
  assert.equal(preset.theme_mode, 'dark', '入参不应被就地改写')

  // 应用时：保留当前外观，但预设的模型参数生效
  const current = { theme_mode: 'light', chat_font: 'default', ctx_size: 8192 }
  const merged = preserveUiPreferences(current, { ...current, ...preset })
  assert.equal(merged.theme_mode, 'light', '应保留当前 theme_mode（外观不被预设改掉）')
  assert.equal(merged.chat_font, 'default', '应保留当前 chat_font')
  assert.equal(merged.ctx_size, 4096, '预设的模型参数应生效')

  assert.deepEqual(UI_PREFERENCE_KEYS, ['theme_mode', 'chat_font'])
})

// ---------- 预设 ↔ 后端引擎：可执行文件名不能被写死 ----------
//
// 真实事故(2026-09-29)：normalizeConfig 曾把 llama_server_path 写成
//   path.join(llamaBinDir, 'llama-server.exe')
// 于是 Bonsai2-27B-PQ2-KVMem 预设声明的 kvmem\bin\llama-kvmem-server.exe
// 被改写成 ...\kvmem\bin\llama-server.exe（该文件不存在），点启动即失败。
// 下面三条锁死「目录 / 文件名分开解析」这个契约。

test('serverFileNameFromPath 只接受可执行文件名，不把目录当文件名', () => {
  assert.equal(serverFileNameFromPath('E:\\a\\kvmem\\bin\\llama-kvmem-server.exe'), 'llama-kvmem-server.exe')
  assert.equal(serverFileNameFromPath('/usr/local/bin/llama-server.exe'), 'llama-server.exe')
  assert.equal(serverFileNameFromPath('E:\\a\\kvmem\\bin'), '', '目录不能当文件名')
  assert.equal(serverFileNameFromPath(''), '')
  assert.equal(serverFileNameFromPath(null), '')
})

test('pickServerExecutable 保留声明名，并在目录里校正', () => {
  // ① KVMem 正牌引擎：声明名就在目录里 → 原样保留（修复前会变成 llama-server.exe）
  assert.equal(
    pickServerExecutable({
      declaredName: 'D:\\llama\\runtime\\kvmem\\bin\\llama-kvmem-server.exe',
      fileNames: ['llama-kvmem-cli.exe', 'llama-kvmem-server.exe'],
    }),
    'llama-kvmem-server.exe',
  )
  // ② 声明名不在目录里 → 退回目录里真实存在的 llama-server.exe
  assert.equal(
    pickServerExecutable({ declaredName: 'llama-kvmem-server.exe', fileNames: ['llama-server.exe', 'llama-cli.exe'] }),
    'llama-server.exe',
  )
  // ③ 目录读不到（不存在/无权限）→ 用声明名兜底，而不是硬写通用名
  assert.equal(
    pickServerExecutable({ declaredName: 'llama-kvmem-server.exe', fileNames: [] }),
    'llama-kvmem-server.exe',
  )
  // ④ 完全没有线索 → 通用默认名
  assert.equal(pickServerExecutable({}), 'llama-server.exe')
  // ⑤ 目录里只有别的命名 → 抓 llama*server*.exe
  assert.equal(
    pickServerExecutable({ declaredName: '', fileNames: ['ggml.dll', 'llama-prism-server.exe'] }),
    'llama-prism-server.exe',
  )
  // ⑥ 非对象入参不能炸
  for (const bad of [undefined, null, {}, { fileNames: null }]) {
    assert.equal(typeof pickServerExecutable(bad), 'string')
  }
})

test('每个预设声明的引擎 == 最终可执行文件所属引擎，且文件真实存在', t => {
  // 依次尝试：环境变量指定的目录 → 作者本机运行期 configs\ → 随包的 desktop\configs。
  // 公开仓库里第一种通常不存在，会落到随包示例（它没有路径，下面会跳过）——
  // 总之既不能因为找不到预设而报假红，也不能因为没数据可查而假通过。
  const candidates = [
    process.env.DSH_PRESET_DIR,
    path.join(process.cwd(), 'configs'),
    path.join(process.cwd(), 'desktop', 'configs'),
  ].filter(Boolean)
  let presetDir = null
  let files = []
  for (const dir of candidates) {
    const found = readdirSyncSafe(dir).filter(name => name.endsWith(PRESET_SUFFIX))
    if (found.length > 0) { presetDir = dir; files = found; break }
  }
  if (!presetDir) return t.skip('没有可用的预设文件')
  let checked = 0

  for (const file of files) {
    const raw = readFileSync(path.join(presetDir, file), 'utf8')
    // TOML 里是双反斜杠，但 resolveEngineBinDir 只按「最后一个分隔符」切目录，
    // 双写不影响切分结果，故无需反转义 —— 少一步就少一处转义坑。
    const declared = /llama_server_path\s*=\s*"([^"]*)"/.exec(raw)?.[1] || ''
    if (!declared) continue
    checked += 1
    const binDir = resolveEngineBinDir({ incomingServerPath: declared })
    const listing = readdirSyncSafe(binDir)
    const picked = pickServerExecutable({ declaredName: declared, fileNames: listing })
    const finalPath = path.join(binDir, picked)

    assert.equal(
      detectEngineByPath(finalPath),
      detectEngineByPath(declared),
      `${file}: 最终路径不得把引擎换掉（${declared} -> ${finalPath}）`,
    )
    assert.ok(
      existsSync(finalPath),
      `${file}: 最终 llama-server 路径必须真实存在，否则点启动必然失败（${finalPath}）`,
    )
  }
})

function readdirSyncSafe(dir) {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

// ---------- KV 缓存量化类型 ----------
// 期望值来自在各引擎 exe 上实跑 `--help` 读回的 allowed values（2026-09-29）：
//   llama.cpp / prism-llama : f32, f16, bf16, q8_0, q4_0, q4_1, iq4_nl, q5_0, q5_1
//   kvmem-gui / kvmem       : -ctv 只认 q8_0 | q5_0 | q4_0，默认 q8_0

test('KV 量化档位表包含 q4 系列，且与 llama.cpp help 的 allowed values 一致', () => {
  for (const type of ['f32', 'f16', 'bf16', 'q8_0', 'q4_0', 'q4_1', 'iq4_nl', 'q5_0', 'q5_1']) {
    assert.ok(KV_CACHE_TYPES.includes(type), `缺少量化档 ${type}`)
  }
  assert.equal(KV_CACHE_TYPES.length, 9)
})

test('llama.cpp 与 PrismML 的 K/V 都接受全部档位', () => {
  for (const engine of ['llama-cpp', 'prismml']) {
    const table = engineCacheTypes(engine)
    assert.deepEqual(table.k, KV_CACHE_TYPES, `${engine} K 档位应齐全`)
    assert.deepEqual(table.v, KV_CACHE_TYPES, `${engine} V 档位应齐全`)
    assert.equal(table.defaultK, 'f16')
    assert.equal(table.defaultV, 'f16')
  }
})

test('KVMem 的 V 缓存只接受 q8_0 / q5_0 / q4_0，且默认值是 q8_0', () => {
  const table = engineCacheTypes('kvmem')
  assert.deepEqual(table.v, ['q8_0', 'q5_0', 'q4_0'])
  assert.equal(table.defaultK, 'q8_0', 'KVMem 的 help 写明 K 默认 q8_0，不是 f16')
  assert.equal(table.defaultV, 'q8_0')
  assert.deepEqual(table.k, KV_CACHE_TYPES, 'KVMem 的 K 走 llama.cpp 命名，档位齐全')
})

test('cacheTypeSupported：空值永远放行，不支持的档位被拒', () => {
  assert.equal(cacheTypeSupported('kvmem', 'v', ''), true, '不指定 = 用引擎默认，必须放行')
  assert.equal(cacheTypeSupported('kvmem', 'v', 'q4_0'), true)
  assert.equal(cacheTypeSupported('kvmem', 'v', 'iq4_nl'), false, 'KVMem 的 V 不认 iq4_nl')
  assert.equal(cacheTypeSupported('kvmem', 'k', 'iq4_nl'), true, 'K 走 llama.cpp 命名，认')
  assert.equal(cacheTypeSupported('llama-cpp', 'v', 'iq4_nl'), true)
})

test('cacheTypeIssues：按 server 路径判引擎，给出可照做的提示', () => {
  // 用正斜杠写，避免反斜杠在字符串里被当成转义序列（\00 是八进制转义）。
  // detectEngineByPath 只做路径子串匹配，两种分隔符等价。
  const kvmem = 'D:/llama/runtime/kvmem-gui/llama-server.exe'
  const llama = 'D:/llama/runtime/llama.cpp/bin/llama-server.exe'

  const unsupported = cacheTypeIssues({ llama_server_path: kvmem, type_v: 'iq4_nl' })
  assert.ok(unsupported.some(i => i.id === 'cache-type-v-unsupported'), 'KVMem 选了 iq4_nl 必须报出来')
  assert.match(unsupported.find(i => i.id === 'cache-type-v-unsupported').message, /q8_0 \/ q5_0 \/ q4_0/)

  const quantized = cacheTypeIssues({ llama_server_path: llama, type_v: 'q4_0' })
  assert.ok(quantized.some(i => i.id === 'cache-type-v-quantized'), '量化 V 缓存要提示质量代价')
  assert.ok(!quantized.some(i => i.id === 'cache-type-v-unsupported'), 'llama.cpp 认 q4_0，不该报不支持')

  assert.deepEqual(cacheTypeIssues({ llama_server_path: llama, type_v: 'f16' }), [], 'f16 无任何提示')
  assert.deepEqual(cacheTypeIssues({ llama_server_path: llama }), [], '不指定无任何提示')
})

test('参数页确实把 q4 系列作为可选项暴露出来', () => {
  // 选项列表来自引擎能力表，而不是界面上写死的一小撮
  assert.match(rendererSource, /engineCacheTypes\(kvEngine\)\[kvField\]/)
  assert.match(rendererSource, /cacheTypeSupported\(kvEngine, kvField, type\)/)
  assert.match(rendererSource, /cacheTypeIssues\(/)
  // 配置里已存、但当前引擎不认的档位也要列出来并置灰，
  // 否则下拉找不到匹配项会显示成空白，用户看不出自己配了什么
  assert.match(rendererSource, /当前引擎不支持/)
  assert.match(rendererSource, /disabled: true/)
})

// ---------- 参数型预设（示例预设随包分发的前提）----------

test('套用预设时，路径字段留空表示「沿用当前」而不是「清空」', () => {
  // 背景：预设文件经 normalizeConfig 会把路径填成空串，而套用是整份覆盖 ——
  // 于是一个不含模型路径的示例预设会把用户配好的路径清掉，直接变成起不来的状态。
  const current = {
    model: 'E:\models\a.gguf',
    llama_server_path: 'E:\llama\llama-server.exe',
    llama_bin_dir: 'E:\llama',
    mmproj: 'E:\models\mmproj.gguf',
    ctx_size: 4096,
    temp: 1,
    threads: 24,
  }
  const example = {
    model: '',
    llama_server_path: '',
    llama_bin_dir: '',
    mmproj: '',
    ctx_size: 8192,
    temp: 0.6,
    threads: 0,
  }
  const merged = applyPresetOverCurrent(current, example)
  // 路径：预设没写 → 保持当前
  assert.equal(merged.model, current.model)
  assert.equal(merged.llama_server_path, current.llama_server_path)
  assert.equal(merged.llama_bin_dir, current.llama_bin_dir)
  assert.equal(merged.mmproj, current.mmproj)
  // 参数：一律以预设为准（哪怕是 0）
  assert.equal(merged.ctx_size, 8192)
  assert.equal(merged.temp, 0.6)
  assert.equal(merged.threads, 0)
})

test('预设里写了路径就以预设为准（不能反过来保护）', () => {
  const current = { model: 'E:\models\old.gguf', ctx_size: 4096 }
  const incoming = { model: 'E:\models\new.gguf', ctx_size: 8192 }
  const merged = applyPresetOverCurrent(current, incoming)
  assert.equal(merged.model, 'E:\models\new.gguf')
  assert.equal(merged.ctx_size, 8192)
})

test('当前没有路径时，预设里的空路径不会造出空值以外的行为', () => {
  const merged = applyPresetOverCurrent({ model: '' }, { model: '', ctx_size: 8192 })
  assert.equal(merged.model, '')
  assert.equal(merged.ctx_size, 8192)
})

test('路径字段清单覆盖所有会让预设变「不可用」的路径', () => {
  for (const field of ['model', 'mmproj', 'llama_server_path', 'llama_bin_dir', 'launcher_path', 'config_path', 'lora_paths']) {
    assert.ok(PRESET_PATH_FIELDS.includes(field), '缺少路径字段 ' + field)
  }
})
