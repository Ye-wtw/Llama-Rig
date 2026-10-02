import assert from 'node:assert/strict'
import test from 'node:test'

import {
  bytesPerElement,
  classifyModelKind,
  computeStablePreset,
  estimateKvBytes,
  parseGgufMetadata,
  suggestPresetName,
} from '../desktop/lib/stable-preset.mjs'

// ---------- 构造一个最小可用的 GGUF 头部 ----------
// 格式：magic(4) version(4) tensor_count(8) kv_count(8) 然后 kv 对。
function buildGguf(kvPairs, { version = 3, magic = 0x46554747 } = {}) {
  const parts = []
  const u32 = v => { const b = Buffer.alloc(4); b.writeUInt32LE(v); return b }
  const u64 = v => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); return b }
  const str = s => { const b = Buffer.from(s, 'utf8'); return Buffer.concat([u64(b.length), b]) }
  const T_UINT32 = 4
  const T_STRING = 8
  const T_FLOAT32 = 6

  parts.push(u32(magic), u32(version), u64(0), u64(kvPairs.length))
  for (const [key, value] of kvPairs) {
    parts.push(str(key))
    if (typeof value === 'string') parts.push(u32(T_STRING), str(value))
    else if (Number.isInteger(value)) parts.push(u32(T_UINT32), u32(value))
    else { const b = Buffer.alloc(4); b.writeFloatLE(value); parts.push(u32(T_FLOAT32), b) }
  }
  return Buffer.concat(parts)
}

const QWEN_KV = [
  ['general.architecture', 'qwen3'],
  ['general.file_type', 15],
  ['qwen3.block_count', 48],
  ['qwen3.context_length', 262144],
  ['qwen3.embedding_length', 5120],
  ['qwen3.attention.head_count', 40],
  ['qwen3.attention.head_count_kv', 8],
]

test('GGUF 头部能读出层数/上下文/KV 头数/架构', () => {
  const meta = parseGgufMetadata(buildGguf(QWEN_KV))
  assert.equal(meta.ok, true)
  assert.equal(meta.architecture, 'qwen3')
  assert.equal(meta.blockCount, 48)
  assert.equal(meta.contextLength, 262144)
  assert.equal(meta.embeddingLength, 5120)
  assert.equal(meta.headCount, 40)
  assert.equal(meta.headCountKv, 8)
  // 没声明 key_length 时用 embedding_length / head_count 推：5120 / 40 = 128
  assert.equal(meta.keyLength, 128)
  assert.equal(meta.fileType, 15)
})

test('不是 GGUF 的文件要明确报错，而不是给出半个结果', () => {
  const meta = parseGgufMetadata(buildGguf(QWEN_KV, { magic: 0x12345678 }))
  assert.equal(meta.ok, false)
  assert.equal(meta.error, 'not a gguf file')
})

test('头部被截断时用已读到的部分并标记 truncated', () => {
  const full = buildGguf(QWEN_KV)
  const cut = full.subarray(0, full.length - 12) // 砍掉最后两个键的尾部
  const meta = parseGgufMetadata(cut)
  assert.equal(meta.truncated, true)
  // 前面的键仍然拿到了，足以判断层数
  assert.equal(meta.blockCount, 48)
})

test('没声明 KV 头数时按 MHA 处理（最坏情况，偏保守）', () => {
  const kv = QWEN_KV.filter(([k]) => k !== 'qwen3.attention.head_count_kv')
  const meta = parseGgufMetadata(buildGguf(kv))
  assert.equal(meta.headCountKv, 40, '未声明时应退化为 head_count')
})

test('KV 缓存体积随上下文与档位缩放', () => {
  const base = { blockCount: 48, headCountKv: 8, headDim: 128 }
  const f16_8k = estimateKvBytes({ ...base, ctx: 8192, kvType: 'f16' })
  const f16_16k = estimateKvBytes({ ...base, ctx: 16384, kvType: 'f16' })
  assert.equal(f16_16k, f16_8k * 2, '上下文翻倍，KV 翻倍')
  const q8_8k = estimateKvBytes({ ...base, ctx: 8192, kvType: 'q8_0' })
  assert.ok(q8_8k < f16_8k, 'q8_0 必须比 f16 小')
  assert.ok(Math.abs(q8_8k / f16_8k - 0.53125) < 0.001, 'q8_0 约为 f16 的 53%')
  assert.equal(estimateKvBytes({ ...base, ctx: 0, kvType: 'f16' }), 0, '上下文为 0 时不应报错')
})

test('每元素字节数：认识常见量化档，不认识时按 f16 保守估', () => {
  assert.equal(bytesPerElement('f16'), 2)
  assert.equal(bytesPerElement('f32'), 4)
  assert.equal(bytesPerElement('q8_0'), 1.0625)
  assert.equal(bytesPerElement('q4_0'), 0.5625)
  assert.equal(bytesPerElement('不认识的档'), 2)
})

// ---------- 稳定预设 ----------

const MODERN = { blockCount: 48, contextLength: 262144, headCountKv: 8, keyLength: 128, architecture: 'qwen3' }

test('显存充裕：整模上卡，上下文取能放下的最大候选', () => {
  const r = computeStablePreset({
    modelMeta: MODERN,
    fileSizeBytes: 4 * 1024 ** 3, // 4 GB
    vramTotalMiB: 24576, // 24 GB
    ramTotalGB: 64,
    logicalThreads: 32,
    engineId: 'llama-cpp',
  })
  assert.equal(r.confidence, 'high')
  assert.equal(r.patch.n_gpu_layers, 48, '应整模上卡')
  assert.ok(r.patch.ctx_size >= 16384, '显存充裕时应给出较大的上下文，实际 ' + r.patch.ctx_size)
  assert.ok(r.patch.ctx_size <= MODERN.contextLength, '不应超过模型训练上下文')
  assert.equal(r.patch.threads, 16, '线程取逻辑核心的一半')
  assert.equal(r.warnings.length, 0, '不该有告警')
  assert.ok(r.steps.length >= 3, '必须给出依据')
})

test('显存放不下整模：部分卸载 + 明确告警，绝不给出会 OOM 的层数', () => {
  const r = computeStablePreset({
    modelMeta: MODERN,
    fileSizeBytes: 16 * 1024 ** 3, // 16 GB，明显大于 8 GB 显存
    vramTotalMiB: 8151,
    ramTotalGB: 32,
    logicalThreads: 24,
    engineId: 'llama-cpp',
  })
  assert.ok(r.patch.n_gpu_layers < 48, '不能整模上卡')
  assert.ok(r.patch.n_gpu_layers >= 0)
  assert.ok(r.warnings.some(w => /显存放不下整模|放不进显存/.test(w)), '必须给出可读的告警')
  // 层数 × 每层成本 不得超过可用显存
  const budgetMiB = 8151 - 1024
  const weightsPerLayerMiB = (16 * 1024) / 48
  const kvPerLayerMiB = estimateKvBytes({ ...MODERN, ctx: r.patch.ctx_size, kvType: 'f16' }) / 1024 / 1024 / 48
  assert.ok(r.patch.n_gpu_layers * (weightsPerLayerMiB + kvPerLayerMiB) <= budgetMiB + 1, '算出的层数不能超出显存')
})

test('模型连一层都放不下：GPU 层数为 0 并说清后果', () => {
  const r = computeStablePreset({
    modelMeta: MODERN,
    // 每层 8.5 GB > 可用显存 7 GB：这才真的「一层都放不下」
    fileSizeBytes: 410 * 1024 ** 3,
    vramTotalMiB: 8151,
    ramTotalGB: 512,
    logicalThreads: 32,
    engineId: 'llama-cpp',
  })
  assert.equal(r.patch.n_gpu_layers, 0)
  assert.ok(r.warnings.some(w => /全部用 CPU|放不进显存/.test(w)))
})

test('换 KV 档位能同时做到「整模上卡 + 8K 上下文」时才换档', () => {
  const model = { blockCount: 32, contextLength: 32768, headCountKv: 8, keyLength: 128, architecture: 'x' }
  const kv = (ctx, type) => estimateKvBytes({ ...model, ctx, headDim: model.keyLength, kvType: type }) / 1024 / 1024
  const weightsMiB = 6000
  // 预算刚好让 q8@8192 放得下、f16@8192 放不下
  const budget = Math.ceil(weightsMiB + kv(8192, 'q8_0'))
  assert.ok(weightsMiB + kv(8192, 'f16') > budget, '前提：f16 在 8K 下放不下')
  assert.ok(weightsMiB + kv(4096, 'f16') <= budget, '前提：f16 在 4K 下放得下')

  const r = computeStablePreset({
    modelMeta: model,
    fileSizeBytes: weightsMiB * 1024 * 1024,
    vramTotalMiB: budget + 1024,
    ramTotalGB: 64,
    logicalThreads: 16,
    engineId: 'llama-cpp',
  })
  assert.equal(r.patch.type_v, 'q8_0', '换档能同时拿到整模上卡与 8K 上下文，应该换')
  assert.equal(r.patch.ctx_size, 8192)
  assert.equal(r.patch.n_gpu_layers, 32, '换档后应整模上卡')
  assert.ok(r.steps.some(st => /q8_0/.test(st)), '必须把换档这件事写进依据')
})

test('整模上卡换不来够用上下文时，宁可部分卸载也要保住 8K（Bonsai 形状的真实回归）', () => {
  // 复刻实测：27B 三元模型约 6.7 GB、64 层、KV 头 4、头维 256，跑在 8 GB 卡上。
  // 旧策略会给出「64 层全上卡 + ctx=1024」—— 层数好看，但 1K 上下文几乎没法用。
  const model = { blockCount: 64, contextLength: 262144, headCountKv: 4, keyLength: 256, architecture: 'qwen35' }
  const r = computeStablePreset({
    modelMeta: model,
    fileSizeBytes: Math.round(6.7 * 1024) * 1024 * 1024,
    vramTotalMiB: 8151,
    ramTotalGB: 32,
    logicalThreads: 24,
    engineId: 'llama-cpp',
  })
  assert.equal(r.patch.ctx_size, 8192, '上下文必须保住 8K，实际 ' + r.patch.ctx_size)
  assert.ok(r.patch.n_gpu_layers >= 1 && r.patch.n_gpu_layers <= 64)
  assert.ok(r.warnings.some(w => /显存放不下整模/.test(w)), '部分卸载必须明确告知用户')
  // 关键：不允许出现「上下文小到没法用、却宣称全上卡」这种自欺欺人的结果
  assert.ok(r.patch.ctx_size >= 8192 || r.patch.n_gpu_layers === 64)
})

test('没有显存读数（非 N 卡）时降级但不崩，并说明原因', () => {
  const r = computeStablePreset({
    modelMeta: MODERN,
    fileSizeBytes: 8 * 1024 ** 3,
    vramTotalMiB: 0,
    ramTotalGB: 32,
    logicalThreads: 16,
    engineId: 'llama-cpp',
  })
  assert.equal(r.confidence, 'low')
  assert.equal(r.patch.ctx_size > 0, true)
  assert.ok(r.warnings.some(w => /显存读数/.test(w)))
})

test('GGUF 没读到层数时降级并提示结果偏保守', () => {
  const r = computeStablePreset({
    modelMeta: { ok: false },
    fileSizeBytes: 5 * 1024 ** 3,
    vramTotalMiB: 8151,
    ramTotalGB: 32,
    logicalThreads: 24,
    engineId: 'llama-cpp',
  })
  assert.equal(r.confidence, 'low')
  assert.ok(r.warnings.some(w => /没有读到层数|偏保守/.test(w)))
  assert.ok(r.patch.ctx_size > 0)
})

test('KVMem 引擎不强行写 KV 档位（它默认就是 q8_0）', () => {
  const r = computeStablePreset({
    modelMeta: MODERN,
    fileSizeBytes: 4 * 1024 ** 3,
    vramTotalMiB: 8151,
    ramTotalGB: 32,
    logicalThreads: 24,
    engineId: 'kvmem',
  })
  assert.equal(r.patch.type_k, '')
  assert.equal(r.patch.type_v, '')
})

test('预设名建议：去掉扩展名与非法字符', () => {
  assert.equal(suggestPresetName('E:\\models\\Qwen3.5-9B-UD-Q4_K_XL.gguf'), 'Qwen3.5-9B-UD-Q4_K_XL-稳定')
  assert.equal(suggestPresetName('/home/u/my model.gguf'), 'my-model-稳定')
  assert.equal(suggestPresetName(''), '稳定预设')
})

test('识别 MTP / 草稿模型，不给它当对话模型推荐', () => {
  // 实测来源：本机 mtp-gemma-4-12b-it.gguf 是 4 层 / 0.43 GB / 架构 gemma4-assistant。
  // 旧输出会给出「全部 4 层上卡、上下文 32768」的漂亮建议，但那个文件根本不该单独加载。
  assert.equal(classifyModelKind({ meta: { architecture: 'gemma4-assistant' } }), 'draft')
  assert.equal(classifyModelKind({ meta: {}, fileName: 'mtp-gemma-4-12b-it.gguf' }), 'draft')
  assert.equal(classifyModelKind({ meta: { architecture: 'qwen3', blockCount: 48 } }), 'chat')

  const r = computeStablePreset({
    modelMeta: { architecture: 'gemma4-assistant', blockCount: 4, contextLength: 262144, headCountKv: 4, keyLength: 256 },
    fileName: 'mtp-gemma-4-12b-it.gguf',
    fileSizeBytes: 0.43 * 1024 ** 3,
    vramTotalMiB: 8151,
    ramTotalGB: 32,
    logicalThreads: 24,
    engineId: 'llama-cpp',
  })
  assert.equal(r.modelKind, 'draft')
  assert.equal(r.confidence, 'low', '辅助模型不该给出高置信度')
  assert.ok(r.warnings.some(w => /MTP \/ 草稿模型/.test(w)), '必须明确提示这是草稿模型，并建议改选主模型')
})

test('层数极少但架构无标记时，按辅助模型处理并要求确认', () => {
  assert.equal(classifyModelKind({ meta: { architecture: 'x', blockCount: 4 } }), 'auxiliary')
  const r = computeStablePreset({
    modelMeta: { architecture: 'x', blockCount: 4, contextLength: 8192, headCountKv: 4, keyLength: 128 },
    fileSizeBytes: 0.3 * 1024 ** 3,
    vramTotalMiB: 8151,
    ramTotalGB: 32,
    logicalThreads: 12,
    engineId: 'llama-cpp',
  })
  assert.equal(r.modelKind, 'auxiliary')
  assert.ok(r.warnings.some(w => /可能不是完整的对话模型/.test(w)))
})
