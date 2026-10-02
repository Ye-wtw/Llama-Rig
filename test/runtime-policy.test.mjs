import test from 'node:test'
import assert from 'node:assert/strict'
import * as runtimePolicy from '../desktop/lib/runtime-policy.mjs'

const { DEFAULT_HOST, runtimeWarnings, assertNoCoreArgConflicts, serviceUrls } = runtimePolicy

test('defaults to loopback host', () => assert.equal(DEFAULT_HOST, '127.0.0.1'))
test('warns for public bind, high context, and short timeout', () => {
  const ids = runtimeWarnings({ host: '0.0.0.0', ctx_size: 65537, request_timeout_ms: 29999 }).map(item => item.id)
  assert.deepEqual(ids, ['public-host', 'high-context', 'short-timeout'])
})
test('rejects extra args that override UI-owned values', () => {
  assert.throws(() => assertNoCoreArgConflicts('--port 9000 --ctx-size=131072'), /--port, --ctx-size/)
})
test('rejects quoted UI-owned flags after shell-style splitting', () => {
  assert.throws(() => assertNoCoreArgConflicts('"--host" 0.0.0.0'), /--host/)
})
test('canonicalizes common llama-server aliases before rejecting UI-owned overrides', () => {
  assert.throws(
    () => assertNoCoreArgConflicts('-c 4096 -m model.gguf -t 8 -b 256 -ub 128 -ngl 99 --gpu-layers 99'),
    /--ctx-size, --model, --threads, --batch-size, --ubatch-size, --n-gpu-layers/,
  )
})
test('reports the configured listener and usable local URL separately', () => {
  assert.deepEqual(serviceUrls({ host: '0.0.0.0', port: 8080 }), {
    listenBaseUrl: 'http://0.0.0.0:8080',
    localBaseUrl: 'http://127.0.0.1:8080',
    chatCompletionsUrl: 'http://127.0.0.1:8080/v1/chat/completions'
  })
})
test('formats IPv6 listener and loopback URLs with brackets', () => {
  assert.deepEqual(serviceUrls({ host: '::', port: 8080 }), {
    listenBaseUrl: 'http://[::]:8080',
    localBaseUrl: 'http://127.0.0.1:8080',
    chatCompletionsUrl: 'http://127.0.0.1:8080/v1/chat/completions'
  })
  assert.deepEqual(serviceUrls({ host: '::1', port: 8080 }), {
    listenBaseUrl: 'http://[::1]:8080',
    localBaseUrl: 'http://[::1]:8080',
    chatCompletionsUrl: 'http://[::1]:8080/v1/chat/completions'
  })
})
test('validates start prerequisites before persistence', () => {
  const config = {
    launch_mode: 'direct',
    llama_server_path: 'C:\\llama-server.exe',
    model: 'C:\\missing.gguf',
  }
  assert.throws(() => runtimePolicy.assertStartableServerConfig(config, filePath => filePath !== config.model), /模型文件/)
})

// ---------- 需求书 P2-1：思考预算与 max_tokens 联动（防「空回答」） ----------

test('从 extra_args 里读出思考预算（含 = 形式）', () => {
  assert.equal(runtimePolicy.reasoningBudgetFromExtraArgs('--reasoning-budget 1024'), 1024)
  assert.equal(runtimePolicy.reasoningBudgetFromExtraArgs('--reasoning-budget=2048 -fa on'), 2048)
  assert.equal(runtimePolicy.reasoningBudgetFromExtraArgs('-fa on -ctk q8_0'), null)
  assert.equal(runtimePolicy.reasoningBudgetFromExtraArgs(''), null)
})

test('显式 n_predict 时，思考预算不小于它就是硬冲突：告警 + 阻止启动', () => {
  const bad = {
    launch_mode: 'direct',
    llama_server_path: 'C:\\llama-server.exe',
    model: 'C:\\model.gguf',
    n_predict: 512,
    extra_args: '--reasoning-budget 1024',
  }
  const issue = runtimePolicy.reasoningBudgetIssue(bad)
  assert.ok(issue, '应判定为冲突')
  assert.equal(issue.budget, 1024)
  assert.equal(issue.maxTokens, 512)
  assert.ok(runtimePolicy.runtimeWarnings(bad).some(item => item.id === 'reasoning-budget'))
  assert.throws(() => runtimePolicy.assertStartableServerConfig(bad, () => true), /思考预算/)
})

test('n_predict = -1（自动）不算硬冲突，但简单提问的地板必须抬到预算之上', () => {
  const auto = { n_predict: -1, extra_args: '--reasoning-budget 1024' }
  assert.equal(runtimePolicy.reasoningBudgetIssue(auto), null)
  const floor = runtimePolicy.effectiveSimplePromptMaxTokens(auto)
  assert.ok(floor > 1024, '地板必须高于思考预算，实际 ' + floor)
  assert.equal(floor, 1024 + runtimePolicy.REASONING_BUDGET_HEADROOM)
})

test('没设思考预算时一切照旧', () => {
  assert.equal(runtimePolicy.effectiveSimplePromptMaxTokens({ extra_args: '-fa on' }), runtimePolicy.SIMPLE_PROMPT_MAX_TOKENS)
  assert.equal(runtimePolicy.reasoningBudgetIssue({ n_predict: 512, extra_args: '-fa on' }), null)
  assert.equal(runtimePolicy.runtimeWarnings({ n_predict: 512 }).some(item => item.id === 'reasoning-budget'), false)
})
