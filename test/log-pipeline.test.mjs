import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  appendVisibleLogs,
  createLogChunkBuffers,
  flushLogChunkBuffer,
  isImportantRuntimeLine,
  processBufferedLogChunk,
  processLogChunk,
  selectTerminalLogs,
  selectVisibleTerminalLogs,
  isErrorLogLine,
} from '../desktop/lib/log-pipeline.mjs'

const rendererSource = readFileSync(new URL('../renderer/app.js', import.meta.url), 'utf8')

test('filters streamed JSON, prompt, code echo, and idle polling', () => {
  const input = ['http: streamed chunk: data: {"choices":[]}', 'prompt: <|im_start|>user', '<div>echo</div>', 'body { color: red; }', 'const answer = 1;', 'que start_loop: waiting for new tasks'].join('\n')
  const result = processLogChunk('stdout', input)
  assert.deepEqual(result.entries, [])
  assert.equal(result.filtered, 6)
})

test('keeps CPU CUDA Metal listener and error lines', () => {
  const input = ['CPU backend loaded', 'CUDA0 ready', 'Metal device selected', 'server listening at 127.0.0.1:8080', 'error: port in use'].join('\n')
  assert.equal(processLogChunk('stdout', input).entries.length, 5)
})

test('tracks filtered truncated and capacity-dropped counts separately', () => {
  let state = { entries: [], filtered: 2, truncated: 1, dropped: 0 }
  state = appendVisibleLogs(state, Array.from({ length: 521 }, (_, index) => ({ source: 'stdout', line: `line ${index}` })), 520)
  assert.equal(state.entries.length, 520)
  assert.deepEqual({ filtered: state.filtered, truncated: state.truncated, dropped: state.dropped }, { filtered: 2, truncated: 1, dropped: 1 })
})

test('recognizes the runtime lines retained by the terminal', () => {
  assert.equal(isImportantRuntimeLine('CUDA0 ready'), true)
  assert.equal(isImportantRuntimeLine('server listening at 127.0.0.1:8080'), true)
  assert.equal(isImportantRuntimeLine('request chat-123: 2 messages -> http://127.0.0.1:8080/v1/chat/completions'), true)
  assert.equal(isImportantRuntimeLine('stream done: 42 approx tokens, 1.2s'), true)
  assert.equal(isImportantRuntimeLine('plain application output'), false)
})

test('reports terminal relevance exclusions and entries hidden by the 520-line visible cap', () => {
  const result = selectVisibleTerminalLogs(
    [
      { source: 'stdout', line: 'plain application output' },
      ...Array.from({ length: 521 }, (_, index) => ({
        source: 'stdout',
        line: `server listening line ${index}`,
      })),
    ],
    520,
  )

  assert.equal(result.entries.length, 520)
  assert.equal(result.excluded, 1)
  assert.equal(result.hidden, 1)
  assert.equal(result.entries[0].line, 'server listening line 1')
})

test('terminal summary reports entries excluded by the relevance filter', () => {
  assert.match(rendererSource, /terminalView\.excluded/)
})

test('buffers split filter patterns independently for each source', () => {
  const buffers = createLogChunkBuffers()
  const results = [
    processBufferedLogChunk(buffers, 'stdout', 'http: streamed '),
    processBufferedLogChunk(buffers, 'stderr', 'que start_loop: wai'),
    processBufferedLogChunk(buffers, 'stdout', 'chunk: data: {"choices":[]}\n'),
    processBufferedLogChunk(buffers, 'stderr', 'ting for new tasks\n'),
  ]

  assert.deepEqual(results.flatMap(result => result.entries), [])
  assert.equal(results.reduce((count, result) => count + result.filtered, 0), 2)
  assert.deepEqual(flushLogChunkBuffer(buffers, 'stdout').entries, [])
  assert.deepEqual(flushLogChunkBuffer(buffers, 'stderr').entries, [])
})

test('truncates a split long line when its pending buffer is flushed', () => {
  const buffers = createLogChunkBuffers()
  const line = `server: ${'x'.repeat(500)}`

  const first = processBufferedLogChunk(buffers, 'stdout', line.slice(0, 200))
  const second = processBufferedLogChunk(buffers, 'stdout', line.slice(200))
  const flushed = flushLogChunkBuffer(buffers, 'stdout')

  assert.deepEqual(first.entries, [])
  assert.deepEqual(second.entries, [])
  assert.equal(flushed.entries.length, 1)
  assert.equal(flushed.truncated, 1)
  assert.match(flushed.entries[0].line, /^server: x+ \.\.\. \[truncated \d+ chars\]$/)
})

// ---------- 终端三视图（对齐原型 .term-tab：输出 / 完整 / 错误）----------

test('错误行判定按 token 精确匹配，不做子串误命中', () => {
  assert.equal(isErrorLogLine('error: unknown argument --bogus'), true)
  assert.equal(isErrorLogLine('CUDA error: out of memory'), true)
  assert.equal(isErrorLogLine('FATAL: model failed to load'), true)
  assert.equal(isErrorLogLine('request timed out'), true)
  // 子串不该误判
  assert.equal(isErrorLogLine('an errorless run'), false)
  assert.equal(isErrorLogLine('terraforming done'), false)
  assert.equal(isErrorLogLine('llama.cpp b10816'), false)
  assert.equal(isErrorLogLine(''), false)
})

test('终端三视图各自过滤不同，完整视图不丢行', () => {
  const logs = [
    { source: 'desktop', line: 'desktop ready' },
    { source: 'server', line: 'llama.cpp b10816' },
    { source: 'server', line: 'pure noise line' },
    { source: 'server', line: 'error: unknown argument --bogus' },
    { source: 'server', line: 'CUDA error: out of memory' },
  ]
  const output = selectTerminalLogs(logs, 'output', 520)
  const full = selectTerminalLogs(logs, 'full', 520)
  const error = selectTerminalLogs(logs, 'error', 520)

  assert.equal(full.entries.length, 5, '完整视图应显示全部')
  assert.equal(full.excluded, 0, '完整视图不该报排除')
  assert.ok(output.entries.length < full.entries.length, '输出视图应过滤掉噪音')
  assert.equal(error.entries.length, 2, '错误视图应只留两行报错')
  assert.ok(error.entries.every(e => isErrorLogLine(e.line)), '错误视图里不该有非报错行')
  assert.equal(error.excluded, 0, '错误视图的 excluded 语义不适用')
  assert.equal(output.total, 5, 'total 应为全量条数')

  // limit 仍然生效
  const capped = selectTerminalLogs(logs, 'full', 2)
  assert.equal(capped.entries.length, 2)
  assert.equal(capped.hidden, 3)
})

test('终端三视图已接进渲染层', () => {
  assert.ok(rendererSource.includes('selectTerminalLogs(logEntries()'), '未用三视图取日志')
  assert.ok(rendererSource.includes('terminalTab'), '缺少 terminalTab 状态')
  for (const tab of ['output', 'full', 'error']) {
    assert.ok(rendererSource.includes('data-terminal-tab="' + tab + '"'), '缺少页签 ' + tab)
  }
  assert.ok(rendererSource.includes("action === 'terminal-tab'"), '缺少 terminal-tab 动作')
  assert.ok(rendererSource.includes('输出日志') && rendererSource.includes('完整日志') && rendererSource.includes('错误日志'), '页签文案不全')
})

// 契约测试：主进程写的聊天日志，必须仍被终端过滤规则认作「重要」。
// 这条是在翻译日志文案时踩出来的：输出视图只显示 source==='desktop'
// 或 isImportantRuntimeLine(line) 为真的行，而请求/响应两条 chat 日志
// **只靠英文正则**被认出来。文案一改中文，正则就失配，
// 两条日志会静默变成「噪音」被滤掉 —— 排障信息凭空消失，且没有任何报错。
test('主进程写的聊天日志与终端过滤正则不许脱节', () => {
  const main = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8')

  // 从源码里抽出 addLog('chat', ...) 的模板，还原成一条真实日志样本
  const samples = []
  for (const m of main.matchAll(/addLog\('chat',\s*(`[^`]*`|'[^']*')\)/g)) {
    let tpl = m[1].slice(1, -1)
    tpl = tpl
      .replace(/\$\{[^}]*requestId[^}]*\}/g, 'chat-abc')
      .replace(/\$\{[^}]*messages\.length[^}]*\}/g, '2')
      .replace(/\$\{[^}]*url[^}]*\}/g, 'http://127.0.0.1:8080/v1/chat/completions')
      .replace(/\$\{[^}]*approxTokens[^}]*\}/g, '42')
      .replace(/\$\{[^}]*elapsed[^}]*\}/g, '1.2')
      .replace(/\$\{[^}]*message[^}]*\}/g, 'boom')
    samples.push({ raw: m[1], text: tpl })
  }
  assert.ok(samples.length >= 5, '应能从 main.mjs 抽出至少 5 条 chat 日志，实际 ' + samples.length)

  // 「请求 N 条消息」与「响应结束」这两条是用户排障时最需要看到的，
  // 它们不匹配任何前缀规则，必须靠专门的正则命中。
  const mustBeVisible = samples.filter(s => /请求|响应结束/.test(s.text))
  assert.ok(mustBeVisible.length >= 2, '应至少抽到「请求…」与「响应结束…」两条，实际 ' + mustBeVisible.length)
  for (const s of mustBeVisible) {
    assert.equal(
      isImportantRuntimeLine(s.text),
      true,
      `这条日志会被输出视图当成噪音滤掉（写入方与过滤正则脱节）：${s.text}`,
    )
  }

  // 旧英文格式仍然认（防止历史日志或回退时漏网）
  assert.equal(isImportantRuntimeLine('request chat-abc: 2 messages -> http://127.0.0.1:8080/v1/chat/completions'), true)
  assert.equal(isImportantRuntimeLine('stream done: 42 approx tokens, 1.2s'), true)
})
