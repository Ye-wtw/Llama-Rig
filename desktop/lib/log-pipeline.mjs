const ANSI_ESCAPE = /\x1B\[[0-?]*[ -/]*[@-~]/g
const ANSI_COLOR = /\[[0-9;]*m/g
const ROUTINE_PATTERNS = [
  'que start_loop: waiting for new tasks',
  'que start_loop: processing new tasks',
  'srv update_slots: all slots are idle',
  'srv update_slots: run slots completed',
  'srv update_slots: update slots',
]

function cleanLogText(chunk) {
  const text = typeof chunk === 'string' ? chunk : chunk?.toString?.('utf8') || String(chunk || '')
  return text.replace(ANSI_ESCAPE, '').replace(ANSI_COLOR, '').replace(/\r\n?/g, '\n')
}

function isErrorLine(line) {
  // 中英双语都要认。引擎输出是英文，但我们自己写的日志（例如「请求失败：…」）
  // 已本地化成中文；只认英文的话，中文错误行既进不了错误视图，
  // 也会在输出视图里被当成噪音滤掉 —— 排障信息静默消失。
  return /\b(error|failed?|exception|fatal|crash|exit)\b/i.test(line) ||
    /(失败|错误|异常|故障|无法|超时|拒绝|中断|不可读)/.test(line)
}

function isCodeEcho(line) {
  return /^\s*(?:<!doctype html|<\/?[a-z][^>]*>|(?:body|html|[.#][\w-]+)\s*\{|(?:const|let|var|function|class|import|export)\b)/i.test(line)
}

function shouldFilterLine(line) {
  const lower = line.toLowerCase()
  if (isErrorLine(line)) return false
  if (ROUTINE_PATTERNS.some(pattern => lower.includes(pattern))) return true
  if (lower.includes('http: streamed chunk: data:')) return true
  if (
    lower.startsWith('parsed message:') ||
    lower.startsWith('parsed chat message:') ||
    lower.startsWith('response:') ||
    lower.startsWith('assistant:') ||
    lower.startsWith('prompt:') ||
    line.includes('"prompt":') ||
    line.includes('<|im_start|>') ||
    isCodeEcho(line)
  ) {
    return true
  }
  return false
}

export function isImportantRuntimeLine(line) {
  const text = String(line || '').trim()
  if (!text) return false
  if (isErrorLine(text)) return true
  return /^(?:llama_|load_|clip_|common_|sched_|ggml|cuda|cublas|main:|server|srv\b|srv_|slot|system_info|webui|warn|warning)/i.test(text) ||
    /\b(?:cpu|cuda\d*|metal)\b/i.test(text) ||
    /\b(?:server is listening|server listening|listening on|model loaded|request (?:started|completed)|tokens per second)\b/i.test(text) ||
    // 下面两条与 desktop/main.mjs 里 addLog('chat', ...) 的文案是**成对**的：
    // 输出视图只认 source==='desktop' 或本函数为真的行，正则一脱节，
    // 这两条请求日志就会静默变成「噪音」被过滤掉。
    // 因此同时认中文（当前）与英文（旧格式）两种写法。
    /^请求 .+：\d+ 条消息 → \S+$/.test(text) ||
    /^响应结束：约 \d+ tokens，\d+(?:\.\d+)?s$/.test(text) ||
    /^request .+: \d+ messages -> \S+$/i.test(text) ||
    /^stream done: \d+ approx tokens, \d+(?:\.\d+)?s$/i.test(text)
}

// 终端视图一次显示上限。以前这个 520 只散落在默认参数和界面文案里，
    // 文案写死数字 → 常量一改，界面就开始说谎。现在有名字，文案引用它。
export const TERMINAL_VIEW_LOG_LIMIT = 520

export function selectVisibleTerminalLogs(entries, limit = TERMINAL_VIEW_LOG_LIMIT) {
  const stored = Array.isArray(entries) ? entries : []
  const displayable = stored
    .filter(entry => entry?.source === 'desktop' || isImportantRuntimeLine(entry?.line))
  const maximum = Math.max(0, Number.isFinite(limit) ? Math.floor(limit) : 0)
  const hidden = Math.max(0, displayable.length - maximum)

  return {
    entries: maximum ? displayable.slice(-maximum) : [],
    excluded: stored.length - displayable.length,
    hidden,
  }
}

// 终端三个视图（对齐原型 .term-tab：输出日志 / 完整日志 / 错误日志）。
// 与 selectVisibleTerminalLogs 的区别：那个是固定筛选，这个是按视图选。
// 原型里三个页签只切高亮、不做过滤；这里做成真的过滤。
// 错误行判定：按 token 切分后精确匹配，不依赖正则词边界（避免转义坑与子串误命中）。
const TERMINAL_ERROR_TOKENS = new Set([
  'error', 'err', 'failed', 'failure', 'fatal', 'panic', 'exception',
  'refused', 'denied', 'timeout', 'oom', 'cannot', 'unable',
])
const TERMINAL_ERROR_PHRASES = ['out of memory', 'unknown argument', 'timed out']

export function isErrorLogLine(line) {
  const text = String(line || '').toLowerCase()
  if (TERMINAL_ERROR_PHRASES.some(phrase => text.includes(phrase))) return true
  return text.split(/[^a-z0-9]+/).some(token => TERMINAL_ERROR_TOKENS.has(token))
}

export function selectTerminalLogs(entries, mode = 'output', limit = TERMINAL_VIEW_LOG_LIMIT) {
  const stored = Array.isArray(entries) ? entries : []
  const maximum = Math.max(0, Number.isFinite(limit) ? Math.floor(limit) : 0)

  let selected
  if (mode === 'full') {
    selected = stored
  } else if (mode === 'error') {
    selected = stored.filter(entry => isErrorLogLine(entry?.line))
  } else {
    selected = stored.filter(entry => entry?.source === 'desktop' || isImportantRuntimeLine(entry?.line))
  }

  const hidden = Math.max(0, selected.length - maximum)
  return {
    entries: maximum ? selected.slice(-maximum) : [],
    // excluded 只对「输出日志」有意义：它相对全量少掉了多少条
    excluded: mode === 'output' ? Math.max(0, stored.length - selected.length) : 0,
    hidden,
    total: stored.length,
  }
}

function processLogLines(source, rawLines) {
  const entries = []
  let filtered = 0
  let truncated = 0

  for (const rawLine of rawLines) {
    const text = rawLine.trim()
    if (!text) continue
    if (shouldFilterLine(text)) {
      filtered += 1
      continue
    }

    const line = text.length > 420
      ? `${text.slice(0, 260)} ... [truncated ${text.length - 260} chars]`
      : text
    if (line !== text) truncated += 1
    entries.push({ source, line })
  }

  return { entries, filtered, truncated }
}

export function processLogChunk(source, chunk) {
  return processLogLines(source, cleanLogText(chunk).split('\n'))
}

export function createLogChunkBuffers() {
  return new Map()
}

export function processBufferedLogChunk(buffers, source, chunk) {
  const combined = `${buffers.get(source) || ''}${cleanLogText(chunk)}`
  const lines = combined.split('\n')
  const pending = lines.pop() || ''

  if (pending) {
    buffers.set(source, pending)
  } else {
    buffers.delete(source)
  }

  return processLogLines(source, lines)
}

export function flushLogChunkBuffer(buffers, source) {
  const pending = buffers.get(source) || ''
  buffers.delete(source)
  return processLogLines(source, [pending])
}

export function appendVisibleLogs(state, entries, limit) {
  const currentEntries = Array.isArray(state?.entries) ? state.entries : []
  const nextEntries = Array.isArray(entries) ? entries : []
  const maximum = Math.max(0, Number.isFinite(limit) ? Math.floor(limit) : 0)
  const combined = [...currentEntries, ...nextEntries]
  const overflow = Math.max(0, combined.length - maximum)

  return {
    entries: overflow ? (maximum ? combined.slice(-maximum) : []) : combined,
    filtered: Number(state?.filtered || 0),
    truncated: Number(state?.truncated || 0),
    dropped: Number(state?.dropped || 0) + overflow,
  }
}
