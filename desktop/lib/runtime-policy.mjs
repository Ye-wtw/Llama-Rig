export const DEFAULT_HOST = '127.0.0.1'
const CORE_ARGS = new Set(['--host', '--port', '--model', '--mmproj', '--ctx-size', '--n-gpu-layers', '--threads', '--batch-size', '--ubatch-size', '--chat-template-kwargs'])
const CORE_ARG_ALIASES = new Map([
  ['-c', '--ctx-size'],
  ['-m', '--model'],
  ['-t', '--threads'],
  ['-b', '--batch-size'],
  ['-ub', '--ubatch-size'],
  ['-ngl', '--n-gpu-layers'],
  ['--gpu-layers', '--n-gpu-layers'],
])

export const SIMPLE_PROMPT_MAX_TOKENS = 512
export const REASONING_BUDGET_HEADROOM = 256

// 从 extra_args 里读 --reasoning-budget N（或 --reasoning-budget=N）。
// 思考预算目前是写在附加参数里的（预设都这么写），所以规则也从那里读。
export function reasoningBudgetFromExtraArgs(extraArgs = '') {
  const tokens = splitExtraArgs(extraArgs)
  for (let index = 0; index < tokens.length; index += 1) {
    const match = tokens[index].match(/^--reasoning-budget(?:=(.+))?$/)
    if (!match) continue
    const raw = match[1] !== undefined ? match[1] : tokens[index + 1]
    const value = Number(raw)
    return Number.isFinite(value) ? value : null
  }
  return null
}

// 「简单提问」时应用会把 max_tokens 压到 SIMPLE_PROMPT_MAX_TOKENS。
// 一旦设了思考预算，这个地板必须抬到预算之上并留出正文余量 ——
// 否则思考吃光额度、content 返回空串（需求书 P2-1 记录的坑）。
export function effectiveSimplePromptMaxTokens(config = {}) {
  const budget = reasoningBudgetFromExtraArgs(config.extra_args)
  if (budget === null || budget <= 0) return SIMPLE_PROMPT_MAX_TOKENS
  return Math.max(SIMPLE_PROMPT_MAX_TOKENS, budget + REASONING_BUDGET_HEADROOM)
}

// n_predict 是显式正数时，应用照它发 max_tokens；此时思考预算必须小于它。
// 返回 null 表示没问题。
export function reasoningBudgetIssue(config = {}) {
  const budget = reasoningBudgetFromExtraArgs(config.extra_args)
  if (budget === null || budget <= 0) return null
  const nPredict = Number(config.n_predict)
  const explicit = String(config.n_predict ?? '').trim() !== '' && Number.isFinite(nPredict) && nPredict > 0
  if (!explicit) return null
  const limit = nPredict - REASONING_BUDGET_HEADROOM
  if (budget <= limit) return null
  return { budget, maxTokens: nPredict, suggested: Math.max(0, limit) }
}

export function runtimeWarnings(config = {}) {
  const warnings = []
  if (['0.0.0.0', '::'].includes(String(config.host || '').trim())) warnings.push({ id: 'public-host', level: 'warning', message: '当前监听地址可能允许局域网设备访问。' })
  if (Number(config.ctx_size) > 65536) warnings.push({ id: 'high-context', level: 'warning', message: '上下文超过 65536，可能显著增加内存占用。' })
  if (Number(config.request_timeout_ms) < 30000) warnings.push({ id: 'short-timeout', level: 'warning', message: '请求超时低于 30000 ms，长回答可能被提前中断。' })
  const budgetIssue = reasoningBudgetIssue(config)
  if (budgetIssue) {
    warnings.push({
      id: 'reasoning-budget',
      level: 'error',
      message: `思考预算 ${budgetIssue.budget} 不小于最大输出 ${budgetIssue.maxTokens}（正文还需留 ${REASONING_BUDGET_HEADROOM}），回答会变成空串。建议把 --reasoning-budget 降到 ${budgetIssue.suggested} 以下，或调大 n_predict。`,
    })
  }
  return warnings
}

export function assertNoCoreArgConflicts(extraArgs = '') {
  const conflicts = splitExtraArgs(extraArgs)
    .map(arg => arg.match(/^(-{1,2}[\w-]+)(?:=.*)?$/)?.[1])
    .map(name => CORE_ARG_ALIASES.get(name) || name)
    .filter(name => CORE_ARGS.has(name))
  const unique = [...new Set(conflicts)]
  if (unique.length) throw new Error(`额外参数不能覆盖界面配置：${unique.join(', ')}`)
}

export function splitExtraArgs(raw) {
  const text = String(raw || '').replace(/\r?\n/g, ' ').trim()
  if (!text) return []

  const args = []
  let current = ''
  let quote = ''
  for (const char of text) {
    if (quote) {
      if (char === quote) quote = ''
      else current += char
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      continue
    }
    if (/\s/.test(char)) {
      if (current) {
        args.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  if (quote) throw new Error('自定义附加参数里有未闭合的引号')
  if (current) args.push(current)
  return args
}

export function assertStartableServerConfig(config = {}, pathExists = () => true) {
  assertNoCoreArgConflicts(config.extra_args)
  if (config.launch_mode === 'launcher' && !pathExists(config.launcher_path)) {
    throw new Error(`找不到启动器：${config.launcher_path}`)
  }
  if (!pathExists(config.llama_server_path)) {
    throw new Error(`找不到 llama-server.exe：${config.llama_server_path}`)
  }
  if (!pathExists(config.model)) {
    throw new Error(`找不到模型文件：${config.model}`)
  }
  const budgetIssue = reasoningBudgetIssue(config)
  if (budgetIssue) {
    throw new Error(
      `思考预算(--reasoning-budget ${budgetIssue.budget}) 不小于最大输出(n_predict ${budgetIssue.maxTokens})：` +
      `思考会吃光额度、正文返回空串。请把预算降到 ${budgetIssue.suggested} 以下，或调大 n_predict。`,
    )
  }
}

function formatUrlHost(host) {
  return host.includes(':') && !(host.startsWith('[') && host.endsWith(']')) ? `[${host}]` : host
}

export function serviceUrls(config = {}) {
  const host = String(config.host || DEFAULT_HOST).trim()
  const port = Number(config.port) || 8080
  const localHost = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host
  const listenUrlHost = formatUrlHost(host)
  const localUrlHost = formatUrlHost(localHost)
  return {
    listenBaseUrl: `http://${listenUrlHost}:${port}`,
    localBaseUrl: `http://${localUrlHost}:${port}`,
    chatCompletionsUrl: `http://${localUrlHost}:${port}/v1/chat/completions`
  }
}
