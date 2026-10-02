// 按硬件生成「稳定预设」的纯逻辑层。
//
// 背景：给一个陌生模型配预设，原先只能从**文件名**里抠参数规模
// （见 feedback-repair.js 的 parameterScale：正则匹配 "27B"），
// 文件名里没有尺寸就完全靠猜，而且完全不看显存实况。
//
// 这里换成两条硬事实：
//   1. GGUF 头部（层数 / 训练上下文 / KV 头数 / 量化类型）—— 模型自己声明的
//   2. 真实硬件读数（显存总量、内存、逻辑核心数）
// 目标不是「最优」，而是「一定能起来」：宁可上下文小一点、层数少一点，
// 也不要用户点启动就 OOM 或报错。
//
// 本模块不碰文件系统与 Electron，纯数据进出，因此可被 node --test 直接覆盖。

// ---------- GGUF 头部解析 ----------

const GGUF_MAGIC = 0x46554747 // 'GGUF' 小端读作 uint32

// GGUF 元数据类型编号
const T_UINT8 = 0
const T_INT8 = 1
const T_UINT16 = 2
const T_INT16 = 3
const T_UINT32 = 4
const T_INT32 = 5
const T_FLOAT32 = 6
const T_BOOL = 7
const T_STRING = 8
const T_ARRAY = 9
const T_UINT64 = 10
const T_INT64 = 11
const T_FLOAT64 = 12

// 我们真正需要的键。其余一律跳过（tokenizer 词表可能有上百万条，必须能跳过去）。
const WANTED_SUFFIXES = [
  ['block_count', 'blockCount'],
  ['context_length', 'contextLength'],
  ['embedding_length', 'embeddingLength'],
  ['attention.head_count', 'headCount'],
  ['attention.head_count_kv', 'headCountKv'],
  ['attention.key_length', 'keyLength'],
  ['attention.value_length', 'valueLength'],
]

class Reader {
  constructor(buffer) {
    this.buf = buffer
    this.off = 0
  }
  get remaining() {
    return this.buf.length - this.off
  }
  u32() {
    if (this.remaining < 4) throw new RangeError('out of bounds')
    const v = this.buf.readUInt32LE(this.off)
    this.off += 4
    return v
  }
  i32() {
    if (this.remaining < 4) throw new RangeError('out of bounds')
    const v = this.buf.readInt32LE(this.off)
    this.off += 4
    return v
  }
  // GGUF 的 uint64 用 BigInt 读，再降到 Number（我们的用途不会接近 2^53）
  u64() {
    if (this.remaining < 8) throw new RangeError('out of bounds')
    const v = this.buf.readBigUInt64LE(this.off)
    this.off += 8
    return Number(v)
  }
  i64() {
    if (this.remaining < 8) throw new RangeError('out of bounds')
    const v = this.buf.readBigInt64LE(this.off)
    this.off += 8
    return Number(v)
  }
  f32() {
    if (this.remaining < 4) throw new RangeError('out of bounds')
    const v = this.buf.readFloatLE(this.off)
    this.off += 4
    return v
  }
  f64() {
    if (this.remaining < 8) throw new RangeError('out of bounds')
    const v = this.buf.readDoubleLE(this.off)
    this.off += 8
    return v
  }
  str() {
    const len = this.u64()
    if (len < 0 || len > this.remaining) throw new RangeError('bad string length')
    const v = this.buf.toString('utf8', this.off, this.off + len)
    this.off += len
    return v
  }
  skip(n) {
    if (n < 0 || n > this.remaining) throw new RangeError('skip out of bounds')
    this.off += n
  }
}

function fixedSizeOf(type) {
  switch (type) {
    case T_UINT8:
    case T_INT8:
    case T_BOOL: return 1
    case T_UINT16:
    case T_INT16: return 2
    case T_UINT32:
    case T_INT32:
    case T_FLOAT32: return 4
    case T_UINT64:
    case T_INT64:
    case T_FLOAT64: return 8
    default: return 0
  }
}

function readValue(reader, type) {
  switch (type) {
    case T_UINT8: return reader.buf[reader.off], reader.skip(1), reader.buf[reader.off - 1]
    case T_INT8: { const v = reader.buf.readInt8(reader.off); reader.skip(1); return v }
    case T_UINT16: { const v = reader.buf.readUInt16LE(reader.off); reader.skip(2); return v }
    case T_INT16: { const v = reader.buf.readInt16LE(reader.off); reader.skip(2); return v }
    case T_UINT32: return reader.u32()
    case T_INT32: return reader.i32()
    case T_FLOAT32: return reader.f32()
    case T_BOOL: { const v = reader.buf[reader.off] !== 0; reader.skip(1); return v }
    case T_STRING: return reader.str()
    case T_UINT64: return reader.u64()
    case T_INT64: return reader.i64()
    case T_FLOAT64: return reader.f64()
    default: throw new RangeError('unknown value type ' + type)
  }
}

// 数组：固定宽度元素直接跳过（不逐个读，避免百万级词表把解析拖死）；
// 字符串数组没法算总宽，只能逐个走，因此设上限，超了就放弃剩余元数据。
const MAX_ARRAY_WALK = 200000

function skipValue(reader, type) {
  if (type !== T_ARRAY) {
    const size = fixedSizeOf(type)
    if (type === T_STRING) { reader.str(); return }
    if (!size) throw new RangeError('unknown value type ' + type)
    reader.skip(size)
    return
  }
  const elemType = reader.u32()
  const count = reader.u64()
  if (elemType === T_STRING) {
    if (count > MAX_ARRAY_WALK) throw new RangeError('array too large to walk')
    for (let i = 0; i < count; i++) reader.str()
    return
  }
  const size = fixedSizeOf(elemType)
  if (!size) throw new RangeError('unknown array element type ' + elemType)
  reader.skip(size * count)
}

/**
 * 解析 GGUF 头部元数据。
 * buffer 只需要文件开头的若干 MB —— 我们要的键一般在最前面。
 * 解析不到就返回部分结果并标记 truncated，让上层降级而不是抛错。
 */
export function parseGgufMetadata(buffer) {
  const result = { ok: false, truncated: false, architecture: '', fileType: null, raw: {} }
  if (!buffer || buffer.length < 24) return { ...result, error: 'buffer too small' }
  const reader = new Reader(buffer)
  // collected 必须在 try 之外：头部被截断时会走 catch，
  // 那时要把已经读到的键用上 —— 原先它在循环结束后才赋值，
  // 于是 catch 分支永远拿不到任何东西，截断文件会被误判成「读不出层数」。
  const collected = {}
  result.raw = collected
  try {
    const magic = reader.u32()
    if (magic !== GGUF_MAGIC) return { ...result, error: 'not a gguf file' }
    const version = reader.u32()
    reader.u64() // tensor_count
    const kvCount = reader.u64()
    result.version = version

    // 上限：正常 GGUF 元数据键在几十条量级，给足余量同时防止异常文件拖死
    const limit = Math.min(kvCount, 512)
    for (let i = 0; i < limit; i++) {
      const key = reader.str()
      const type = reader.u32()
      if (type === T_ARRAY) {
        skipValue(reader, type)
        continue
      }
      collected[key] = readValue(reader, type)
    }

    const arch = String(collected['general.architecture'] || '')
    result.architecture = arch
    result.fileType = collected['general.file_type'] ?? null

    const apply = (suffix, field) => {
      const value = collected[arch ? `${arch}.${suffix}` : suffix]
      if (value !== undefined && value !== null && Number.isFinite(Number(value))) {
        result[field] = Number(value)
      }
    }
    for (const [suffix, field] of WANTED_SUFFIXES) apply(suffix, field)

    // 头维：优先用 key_length，没有就用 embedding_length / head_count 推
    if (!result.keyLength && result.embeddingLength && result.headCount) {
      result.keyLength = Math.round(result.embeddingLength / result.headCount)
    }
    // 没声明 KV 头数时按 MHA 处理（最坏情况，偏保守）
    if (!result.headCountKv && result.headCount) result.headCountKv = result.headCount
    result.ok = true
    return result
  } catch (error) {
    // 头部被读截断（我们只喂了前几 MB）→ 用已经读到的键继续，并标明不完整
    result.truncated = true
    result.error = error?.message || String(error)
    const arch = String(collected['general.architecture'] || '')
    result.architecture = arch
    const apply = (suffix, field) => {
      const value = collected[arch ? `${arch}.${suffix}` : suffix]
      if (value !== undefined && value !== null && Number.isFinite(Number(value))) result[field] = Number(value)
    }
    for (const [suffix, field] of WANTED_SUFFIXES) apply(suffix, field)
    if (!result.keyLength && result.embeddingLength && result.headCount) {
      result.keyLength = Math.round(result.embeddingLength / result.headCount)
    }
    if (!result.headCountKv && result.headCount) result.headCountKv = result.headCount
    result.ok = Boolean(result.blockCount)
    return result
  }
}

// ---------- KV 缓存体积 ----------

// 每元素字节数。量化档的块结构（q4_0 = 32 个权重 + 1 个 scale，共 18 字节）
// 换算成「每元素平均字节数」。
export function bytesPerElement(kvType) {
  switch (String(kvType || '').toLowerCase()) {
    case 'f32': return 4
    case 'f16':
    case 'bf16': return 2
    case 'q8_0': return 1.0625 // 34/32
    case 'q5_1': return 0.6875 // 22/32
    case 'q5_0': return 0.625 // 20/32
    case 'q4_1': return 0.5625 // 18/32
    case 'q4_0':
    case 'iq4_nl': return 0.5625
    default: return 2 // 不认识的档位按 f16 估，偏保守
  }
}

/**
 * KV 缓存字节数（K + V 两份）。
 * 公式：2 × 层数 × 上下文 × KV头数 × 头维 × 每元素字节
 */
export function estimateKvBytes({ blockCount, ctx, headCountKv, headDim, kvType }) {
  const layers = Math.max(0, Number(blockCount) || 0)
  const tokens = Math.max(0, Number(ctx) || 0)
  const heads = Math.max(0, Number(headCountKv) || 0)
  const dim = Math.max(0, Number(headDim) || 0)
  if (!layers || !tokens || !heads || !dim) return 0
  return 2 * layers * tokens * heads * dim * bytesPerElement(kvType)
}

// ---------- 稳定预设的计算 ----------

const MIB = 1024 * 1024

// 给系统桌面、Electron 自身与推理时的计算缓冲留的显存。
// 8 GB 卡上留 1 GB 是经验值：不留的话会在生成第一个 token 时 OOM。
export const VRAM_RESERVE_MIB = 1024

// 上下文候选：从大到小试，取「能整模上卡」的最大一个；都不行就退回最保守档。
const CTX_CANDIDATES = [32768, 16384, 8192, 4096, 2048, 1024]
const FALLBACK_CTX = 4096

function clampCtxToTraining(ctx, trainingCtx) {
  // 不要超过模型自己声明的训练上下文：超了画质会崩，而且 KV 占用虚高
  const training = Number(trainingCtx) || 0
  if (!training) return ctx
  return Math.min(ctx, training)
}

/**
 * 计算一份「稳定优先」的预设增量。
 * 返回 patch（只含需要改的字段）、steps（每项的依据，给用户看）、warnings。
 */
export function computeStablePreset(payload = {}) {
  const meta = payload.modelMeta || {}
  const fileSizeBytes = Number(payload.fileSizeBytes) || 0
  const vramTotalMiB = Number(payload.vramTotalMiB) || 0
  const ramTotalGB = Number(payload.ramTotalGB) || 0
  const logicalThreads = Number(payload.logicalThreads) || 0
  const engineId = String(payload.engineId || 'llama-cpp')

  const steps = []
  const warnings = []

  const weightsMiB = fileSizeBytes > 0 ? fileSizeBytes / MIB : 0
  const blockCount = Number(meta.blockCount) || 0
  const trainCtx = Number(meta.contextLength) || 0
  const headCountKv = Number(meta.headCountKv) || 0
  const headDim = Number(meta.keyLength) || 0

  // 线程：逻辑核心的一半作为物理核心的保守估计。
  // 超线程全开会让 CPU 推理变慢，因此不直接取逻辑核心数。
  const threads = logicalThreads > 0 ? Math.max(4, Math.min(32, Math.floor(logicalThreads / 2))) : 0
  if (threads) steps.push(`CPU 线程 ${threads}：逻辑核心 ${logicalThreads} 的一半（超线程全开反而更慢）`)

  steps.push(`模型文件 ${(weightsMiB / 1024).toFixed(2)} GB`)
  if (blockCount) steps.push(`GGUF 声明 ${blockCount} 层${meta.architecture ? `（架构 ${meta.architecture}）` : ''}`)
  if (trainCtx) steps.push(`模型训练上下文 ${trainCtx}`)
  if (!blockCount) {
    warnings.push('这个 GGUF 没有读到层数信息，只能按文件体积估算，结果会偏保守。')
  }

  const patch = {
    batch_size: 512,
    ubatch_size: 128,
    threads,
    threads_batch: threads,
  }
  steps.push('批大小 512 / 微批 128：小微批最省显存，先求能跑起来')

  // KV 类型分两个概念，混在一起会出错：
  //   kvForEstimate —— 估算显存占用时**引擎实际会用**的档（KVMem 默认就是 q8_0）
  //   kvToWrite     —— 我们要主动写进配置的档；只有当「换档才放得下」时才写，
  //                    引擎默认本来就够用时留空，不写冗余字段
  const kvForEstimate = engineId === 'kvmem' ? 'q8_0' : 'f16'
  let kvToWrite = ''

  let chosenCtx = 0
  let chosenLayers = 0
  let fitsAll = false

  if (vramTotalMiB > 0 && weightsMiB > 0 && blockCount > 0 && headCountKv > 0 && headDim > 0) {
    const budget = Math.max(0, vramTotalMiB - VRAM_RESERVE_MIB)
    steps.push(`显存 ${(vramTotalMiB / 1024).toFixed(1)} GB，预留 ${(VRAM_RESERVE_MIB / 1024).toFixed(1)} GB 给系统与计算缓冲 → 可用 ${(budget / 1024).toFixed(1)} GB`)

    const weightsPerLayer = weightsMiB / blockCount
    // 每层 KV：先算「全部层在 ctx 下的 KV 总量」，再除以层数。
    // 之前这里漏了除以层数，把「全部层的 KV」当成了「每层 KV」加到每层权重上，
    // 成本虚高约 blockCount 倍 → 24 GB 显存也算成只能放 3 层、上下文被压到 2048。
    const kvPerLayerMiB = (ctx, kvType) =>
      estimateKvBytes({ blockCount, ctx, headCountKv, headDim, kvType }) / MIB / blockCount

    const layersThatFit = (ctx, kvType) => {
      const cost = weightsPerLayer + kvPerLayerMiB(ctx, kvType)
      if (cost <= 0) return blockCount
      return Math.max(0, Math.min(blockCount, Math.floor(budget / cost)))
    }
    // 某个 KV 档下，能整模上卡的最大上下文（0 = 连最保守的上下文都放不下整模）
    const largestCtxFitting = (kvType) => {
      for (const candidate of CTX_CANDIDATES) {
        const ctx = clampCtxToTraining(candidate, trainCtx)
        if (ctx <= 0) continue
        if (layersThatFit(ctx, kvType) >= blockCount) return ctx
      }
      return 0
    }

    const ctxWithDefault = largestCtxFitting(kvForEstimate)

    // 取舍的优先级（从实测反馈定下来的）：
    //   1) 必须能起来            —— 硬约束
    //   2) 上下文要够用          —— 8K 是本地对话的实用下限
    //   3) 尽量多放层到 GPU      —— 只是快慢问题，部分卸载照样能用
    //
    // 一开始把「整模上卡」排在上下文前面，结果是 8 GB 卡跑 27B 时给出
    // 「64 层全上卡 + ctx=1024」—— 层数是好看的，但 1K 上下文几乎没法用。
    // 现在改成：先保住 8K 上下文，再在这个上下文下尽量多放层。
    const USABLE_CTX = 8192
    const largestCandidateBelow = (limit) => {
      for (const candidate of CTX_CANDIDATES) {
        const ctx = clampCtxToTraining(candidate, trainCtx)
        if (ctx <= 0) continue
        if (ctx <= limit) return ctx
      }
      return 0
    }

    if (ctxWithDefault >= USABLE_CTX) {
      // 默认精度就能整模上卡，且上下文够用 —— 最理想的情况
      chosenCtx = ctxWithDefault
      chosenLayers = blockCount
      fitsAll = true
    } else if (kvForEstimate === 'f16' && largestCtxFitting('q8_0') >= USABLE_CTX) {
      // 换 KV 档位就能整模上卡且上下文够用 —— 值得换
      kvToWrite = 'q8_0'
      chosenCtx = largestCtxFitting('q8_0')
      chosenLayers = blockCount
      fitsAll = true
      steps.push(`默认 f16 的 KV 只够 ${ctxWithDefault || '更小'} 的上下文，换成 q8_0 可以到 ${chosenCtx} 并整模上卡（上下文比 KV 精度更影响可用性）`)
    } else {
      // 整模上卡换不来够用的上下文 → 保住上下文，接受部分卸载。
      // 先要 8K；模型训练上下文本身不足 8K 时就用它的上限。
      const targetCtx = trainCtx > 0 ? Math.min(USABLE_CTX, trainCtx) : USABLE_CTX
      let ctxTry = largestCandidateBelow(targetCtx)
      let layers = ctxTry > 0 ? layersThatFit(ctxTry, kvForEstimate) : 0
      if (layers < 1) {
        // 目标上下文下一层都放不下（模型相对显存太大）→ 逐步降上下文，直到能放下一层
        for (const candidate of CTX_CANDIDATES) {
          const ctx = clampCtxToTraining(candidate, trainCtx)
          if (ctx <= 0) continue
          const fit = layersThatFit(ctx, kvForEstimate)
          if (fit >= 1) { ctxTry = ctx; layers = fit; break }
        }
      }
      chosenCtx = ctxTry || (clampCtxToTraining(FALLBACK_CTX, trainCtx) || FALLBACK_CTX)
      if (layers >= blockCount) {
        chosenLayers = blockCount
        fitsAll = true
      } else {
        chosenLayers = Math.max(0, layers)
        if (chosenLayers <= 0) {
          warnings.push(`模型 ${(weightsMiB / 1024).toFixed(1)} GB 连一层都放不进显存，只能全部用 CPU 推理，速度会明显变慢。`)
        } else if (chosenLayers < blockCount) {
          warnings.push(`显存放不下整模：${chosenLayers}/${blockCount} 层上 GPU，其余走 CPU。优先保住了 ${chosenCtx} 上下文；想全上卡请换更小的量化档。`)
        }
      }
    }

    if (fitsAll) {
      steps.push(`上下文 ${chosenCtx}：整模 ${blockCount} 层都能放进显存（含 KV 缓存）`)
    }
  } else {
    // 没有显存读数 / 缺少模型元数据 → 退到保守默认，并说清为什么
    chosenCtx = clampCtxToTraining(FALLBACK_CTX, trainCtx) || FALLBACK_CTX
    chosenLayers = blockCount || 99
    if (vramTotalMiB <= 0) warnings.push('没有读到显存读数（可能是非 NVIDIA 显卡或驱动未装 nvidia-smi），GPU 层数按「全部尝试」给出，失败时请下调。')
    if (!headCountKv || !headDim) warnings.push('模型没声明 KV 头数/头维，无法精确估算 KV 缓存，上下文按保守值给。')
    steps.push(`上下文 ${chosenCtx}：缺少精确估算所需的信息，取保守值`)
  }

  patch.ctx_size = chosenCtx
  patch.n_gpu_layers = chosenLayers

  // KV 档位：只有「换档才放得下」时才写进配置。
  // 引擎默认本来就够用时留空 —— 写了只是冗余，还会让用户以为是我们替他做了质量取舍。
  patch.type_k = kvToWrite
  patch.type_v = kvToWrite
  if (kvToWrite) steps.push(`KV 缓存量化 ${kvToWrite}：用少量质量换显存，让你不必砍上下文或砍层数`)
  else steps.push(`KV 缓存用引擎默认（llama.cpp 默认 f16，KVMem 默认 q8_0）${kvForEstimate === 'q8_0' ? '，即 ' + kvForEstimate : ''}`)

  // 内存检查：权重走 CPU / 部分卸载时，权重必须放得进内存
  if (ramTotalGB > 0 && weightsMiB / 1024 > ramTotalGB * 0.6) {
    warnings.push(`模型 ${(weightsMiB / 1024).toFixed(1)} GB 超过内存 ${ramTotalGB} GB 的 60%，CPU 侧可能吃紧。`)
  }

  // 辅助模型（MTP 草稿模型等）不能当对话模型推荐。
  // 实测踩到：mtp-gemma-4-12b-it.gguf 只有 4 层 / 0.43 GB、架构 gemma4-assistant，
  // 不给提示的话用户会拿到一份「全部上卡、上下文 32768」的漂亮建议，
  // 然后困惑为什么跑出来的东西不对。
  const modelKind = classifyModelKind({ meta, fileName: payload.fileName || payload.modelPath || '' })
  if (modelKind !== 'chat') {
    warnings.unshift(modelKind === 'draft'
      ? `这个 GGUF 看起来是 MTP / 草稿模型（${blockCount || '?'} 层，${(weightsMiB / 1024).toFixed(2)} GB）——它通常配合主模型做加速，不单独当对话模型用。建议改选主模型文件再生成预设。`
      : `这个模型只有 ${blockCount} 层且体积偏小，可能不是完整的对话模型，请确认选对了文件。`)
  }

  return {
    patch,
    steps,
    warnings,
    modelKind,
    confidence: modelKind === 'chat' && blockCount && headCountKv && headDim && vramTotalMiB > 0 ? 'high' : 'low',
    summary: {
      weightsGB: Number((weightsMiB / 1024).toFixed(2)),
      blockCount,
      offloadAll: fitsAll || (!blockCount && chosenLayers >= 99),
      ctxSize: chosenCtx,
      gpuLayers: chosenLayers,
      kvType: kvToWrite || `${kvForEstimate}（引擎默认）`,
    },
  }
}

// 判断这个 GGUF 是不是「辅助模型」。
// 实测踩到：本机 mtp-gemma-4-12b-it.gguf 只有 4 层 / 0.43 GB，架构是 gemma4-assistant ——
// 它是 MTP 草稿模型，配合主模型做投机解码用的，单独当对话模型跑没有意义。
// 不给提示的话，用户会拿到一份「4 层都能上卡、上下文可以开 32768」的漂亮建议，
// 然后困惑为什么效果不对。
export function classifyModelKind({ meta = {}, fileName = '' } = {}) {
  const arch = String(meta.architecture || '').toLowerCase()
  const name = String(fileName || '').toLowerCase()
  if (/assistant|draft/.test(arch)) return 'draft'
  if (/^(?:mtp|draft)[-_]/.test(name)) return 'draft'
  // 架构和文件名都没线索，但体积与层数明显不成比例（每层 < 40 MB 且层数很少）
  const blocks = Number(meta.blockCount) || 0
  return blocks > 0 && blocks <= 8 ? 'auxiliary' : 'chat'
}

/** 预设名建议：模型名 + 稳定档。用于「保存为预设」。 */
export function suggestPresetName(modelPath) {
  const base = String(modelPath || '').split(/[\\/]/).filter(Boolean).pop() || ''
  const stem = base.replace(/\.gguf$/i, '')
  const cleaned = stem.replace(/\s+/g, '-').replace(/[^\w\u4e00-\u9fff.-]/g, '').slice(0, 48)
  return cleaned ? `${cleaned}-稳定` : '稳定预设'
}
