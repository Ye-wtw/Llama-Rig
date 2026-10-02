import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// 接线契约测试：主进程注册的 IPC、preload 暴露的 API、渲染进程调用的方法必须三方对齐。
// 这类错误（通道名写错、暴露了没有 handler 的接口）在纯逻辑单测里查不出来，
// 但会在运行时表现为「点击没反应」，所以用文本契约把它钉住。

const read = relative => readFileSync(new URL(relative, import.meta.url), 'utf8')

const mainSource = read('../desktop/main.mjs')
const preloadSource = read('../desktop/preload.cjs')
const rendererSource = read('../renderer/app.js')

function matchAll(source, pattern, group = 1) {
  return [...source.matchAll(pattern)].map(match => match[group])
}

const registeredChannels = new Set(matchAll(mainSource, /ipcMain\.handle\(\s*'([^']+)'/g))
const invokedChannels = new Set(matchAll(preloadSource, /ipcRenderer\.invoke\(\s*'([^']+)'/g))

const preloadBlock = preloadSource.slice(preloadSource.indexOf('exposeInMainWorld'))
const exposedApis = new Set(matchAll(preloadBlock, /^\s{2}([A-Za-z_$][\w$]*)\s*:/gm))
const rendererCalls = new Set(matchAll(rendererSource, /window\.llamaDesktop\.([A-Za-z_$][\w$]*)/g))

test('契约测试自身能解析出内容（防止正则失效后静默通过）', () => {
  assert.ok(registeredChannels.size > 0, '没有解析到 ipcMain.handle')
  assert.ok(invokedChannels.size > 0, '没有解析到 ipcRenderer.invoke')
  assert.ok(exposedApis.size > 0, '没有解析到 preload 暴露的 API')
  assert.ok(rendererCalls.size > 0, '没有解析到渲染进程的 API 调用')
})

test('preload 调用的每个 IPC 通道都在主进程注册过', () => {
  const missing = [...invokedChannels].filter(channel => !registeredChannels.has(channel))
  assert.deepEqual(missing, [], `以下通道在 preload 中调用但主进程没有 handler：${missing.join(', ')}`)
})

test('新增功能的 IPC 通道全部就位', () => {
  const expected = [
    'llama:preset-list',
    'llama:preset-read',
    'llama:preset-write',
    'llama:preset-delete',
    'llama:engine-list',
    'llama:engine-detect',
    'llama:vram-check',
    'llama:preset-metadata',
  ]
  for (const channel of expected) {
    assert.ok(invokedChannels.has(channel), `preload 缺少通道 ${channel}`)
    assert.ok(registeredChannels.has(channel), `主进程缺少 handler ${channel}`)
  }
})

test('preload 暴露了新增功能的 API', () => {
  const expected = [
    'presetList', 'presetRead', 'presetWrite', 'presetDelete',
    'engineList', 'engineDetect', 'vramCheck', 'presetMetadata',
  ]
  for (const api of expected) {
    assert.ok(exposedApis.has(api), `preload 未暴露 ${api}`)
  }
})

test('渲染进程只调用 preload 真正暴露的 API', () => {
  const unknown = [...rendererCalls].filter(api => !exposedApis.has(api))
  assert.deepEqual(unknown, [], `渲染进程调用了未暴露的 API：${unknown.join(', ')}`)
})

test('主进程复用 lib/preset-engine.mjs 而不是内联重复规则', () => {
  assert.match(mainSource, /from '\.\/lib\/preset-engine\.mjs'/, '主进程没有引用预设/引擎逻辑模块')
  assert.doesNotMatch(mainSource, /const DEFAULT_ENGINES/, '引擎定义仍内联在主进程，存在重复来源')
})

test('显存守卫在主进程与渲染进程之间字段对齐', () => {
  // 主进程经 vramSnapshot 产出 available/total；渲染进程据此渲染与告警。
  assert.match(rendererSource, /vramUsage\.available/, '渲染进程未读取 available')
  assert.match(rendererSource, /vramUsage\.total/, '渲染进程未读取 total')
  assert.match(rendererSource, /function checkVram/, '渲染进程缺少 checkVram')
})

test('预设页签同时具备导航按钮与生效渲染分支', () => {
  // settingsTabs 是设置栏导航的唯一来源：只加内容不加页签，用户根本点不到。
  const tabsBlock = rendererSource.slice(
    rendererSource.indexOf('const settingsTabs = ['),
    rendererSource.indexOf('const appEl ='),
  )
  assert.match(tabsBlock, /\['presets',/, 'settingsTabs 缺少 presets 页签，导航栏不会出现按钮')

  const modernStart = rendererSource.indexOf('function renderModernSettingsContent')
  assert.ok(modernStart > 0, '找不到 renderModernSettingsContent')
  assert.match(
    rendererSource.slice(modernStart),
    /tab === 'presets'/,
    '生效的设置面板没有 presets 分支',
  )
})

test('预设 UI 必须落在生效的现代设置面板内（回归：曾误加到已废弃的旧函数）', () => {
  const modernStart = rendererSource.indexOf('function renderModernSettingsContent')
  const legacyStart = rendererSource.indexOf('function renderSettingsContent')
  const selectAt = rendererSource.indexOf('id="presetSelect"')

  assert.ok(selectAt > 0, '缺少预设下拉框')
  assert.ok(selectAt > modernStart, '预设下拉框不在 renderModernSettingsContent 内，即落在未生效的旧函数里')
  assert.ok(
    !(legacyStart > 0 && selectAt > legacyStart && selectAt < modernStart),
    '预设下拉框仍残留在旧函数 renderSettingsContent 中（该函数已不被 render() 调用）',
  )
})

test('新按钮走 data-action 委托，不使用内联 onclick（模块作用域下内联必然 ReferenceError）', () => {
  assert.equal(
    /onclick=|onchange=|oninput=/.test(rendererSource),
    false,
    'renderer/app.js 出现内联事件处理器：ES 模块里的函数不是全局的，内联调用会报错',
  )
  for (const action of ['preset-apply', 'preset-save', 'preset-delete', 'engine-switch']) {
    assert.ok(rendererSource.includes(`data-action="${action}"`), `缺少 data-action="${action}" 按钮`)
    assert.match(rendererSource, new RegExp(`action === '${action}'`), `点击分发缺少 ${action} 分支`)
  }
})

test('预设下拉框通过委托的 change 监听处理', () => {
  assert.match(rendererSource, /addEventListener\('change'/, '缺少 change 监听器')
  assert.match(rendererSource, /event\.target\?\.id === 'presetSelect'/, 'change 监听未处理 presetSelect')
})

test('渲染进程启动时会初始化预设、引擎与显存状态', () => {
  // 不写死 .catch：启动时可能是 loadPresetList().catch(...)，
  // 也可能是 loadPresetList().then(渲染).catch(...) —— 两者都算「加载了」。
  assert.match(rendererSource, /loadPresetList\(\)\.(then|catch)/, '启动流程未加载预设列表')
  // 预设摘要不再在启动处单独调用：它已并进 loadPresetList（名单与摘要必须同时刷新）。
  // 所以断言的是「摘要会被加载」，而不是「在哪一行被调用」。
  assert.match(rendererSource, /await loadPresetSummaries\(\)/, '预设摘要没有被加载')
  assert.match(rendererSource, /loadEngineList\(\)\.catch/, '启动流程未加载引擎列表')
  assert.match(rendererSource, /checkVram\(\)\.catch/, '启动流程未检查显存')
})

test('引擎切换入口已接入界面', () => {
  assert.match(rendererSource, /function renderEngineSelector/, '缺少引擎选择器渲染函数')
  assert.match(rendererSource, /id="engineSelect"/, '缺少引擎下拉框')
  assert.match(rendererSource, /handleSwitchEngine/, '缺少切换引擎入口')
  assert.match(rendererSource, /llama_server_path: engine\.path/, '切换引擎未写回 llama_server_path')
})

test('预设详情面板会真正读取元信息', () => {
  assert.match(rendererSource, /function renderPresetMeta/, '缺少预设详情渲染函数')
  assert.match(rendererSource, /function loadPresetMetadata/, '缺少元信息加载函数')
  assert.match(rendererSource, /llamaDesktop\.presetMetadata\(/, '未调用 presetMetadata 接口')
  assert.match(rendererSource, /presetMeta \? renderPresetMeta/, '详情面板未接入渲染')
})

test('加载预设会同步刷新引擎徽章与详情', () => {
  assert.match(rendererSource, /await refreshEngineForConfig\(\)/, '加载预设后未刷新引擎')
  assert.match(rendererSource, /await loadPresetMetadata\(name\)/, '加载预设后未刷新详情')
})

test('界面文本没有残留的编码损坏字符', () => {
  // ⚠ 的 UTF-8 字节 E2 9A A0 若被按 Latin-1 解码，会变成 â + 控制字符。
  assert.equal(
    rendererSource.includes('\u00e2\u009a\u00a0'),
    false,
    'renderer/app.js 存在 mojibake（â + 控制字符），应写作 U+26A0',
  )
  assert.equal(
    preloadSource.includes('\u00e2\u009a\u00a0'),
    false,
    'preload.cjs 存在 mojibake',
  )
  assert.equal(
    mainSource.includes('\u00e2\u009a\u00a0'),
    false,
    'main.mjs 存在 mojibake',
  )
})

test('预设区样式与界面结构对应', () => {
  const stylesSource = read('../renderer/styles.css')
  for (const selector of [
    '.preset-area',
    '.preset-controls',
    '.preset-select',
    '.preset-engine-row',
    '.preset-meta-grid',
    '.preset-meta-item',
    '.preset-warning',
    '.engine-badge',
  ]) {
    assert.ok(stylesSource.includes(selector), `styles.css 缺少 ${selector}`)
  }
})

// ---------------------------------------------------------------------------
// 2026-09-25 回归护栏：以下每条都对应一个真实踩过的坑，别删。
// ---------------------------------------------------------------------------

// 去掉注释后再做"禁用某 API"的检查，避免把说明文字里的示例也算成违规。
const rendererCode = rendererSource
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')

test('渲染进程不使用 Electron 不支持的原生对话框', () => {
  // Electron 不支持 window.prompt()，调用会抛 "prompt() is not supported."；
  // 异常发生在 async 函数里会变成未处理拒绝 —— 「保存预设」就是这样彻底哑火的。
  assert.doesNotMatch(rendererCode, /window\.prompt\s*\(/, 'renderer 不能用 window.prompt()')
  assert.doesNotMatch(rendererCode, /(^|[^.\w])prompt\s*\(/m, 'renderer 不能用裸 prompt()')
  assert.doesNotMatch(rendererCode, /(^|[^.\w])confirm\s*\(/m, 'renderer 不能用裸 confirm()')
})

test('预设管理的每个动作都接入了事件分发', () => {
  const actions = [
    'preset-apply',
    'preset-save',
    'preset-rename',
    'preset-duplicate',
    'preset-delete',
    'preset-refresh',
    'preset-dialog-close',
    'preset-dialog-confirm',
  ]
  for (const action of actions) {
    assert.ok(
      rendererSource.includes("action === '" + action + "'"),
      '事件分发缺少动作 ' + action,
    )
  }
  for (const action of ['preset-save', 'preset-rename', 'preset-duplicate', 'preset-delete', 'preset-refresh']) {
    assert.ok(
      rendererSource.includes('data-action="' + action + '"'),
      '预设区缺少按钮 ' + action,
    )
  }
})

test('预设下拉框重渲染后必须保持选中项（回归：选完就丢，加载预设永远读到空值）', () => {
  assert.match(
    rendererSource,
    /name === \(state\.presetPreview \|\| state\.preset\)/,
    '下拉框未回填选中项，选中的预设会被下一次 render() 冲掉',
  )
  assert.match(rendererSource, /chosen \? ' selected' : ''/, 'option 未写 selected 属性')
})

test('预设对话框渲染已挂载进主渲染树', () => {
  assert.match(rendererSource, /function renderPresetDialog/)
  assert.match(rendererSource, /\$\{renderPresetDialog\(\)\}/, 'renderPresetDialog 未挂载')
  assert.match(rendererSource, /data-preset-name-input/, '缺少名称输入框')
})

test('主进程保持独立实例：数据根自包含、不共用原装 userData', () => {
  assert.doesNotMatch(mainSource, /authoredBaseDir/, 'authoredBaseDir 会让数据根回退到原装目录')
  assert.match(mainSource, /app\.setPath\('userData'/, '未把 userData 搬离原装的 %APPDATA%\\Llama.cpp Desktop')
  assert.match(mainSource, /function defaultBaseDir\(\) \{\s*return appOwnDir/, 'defaultBaseDir 未固定为应用自有目录')
  assert.match(mainSource, /async function ensureOwnDataRoot\(\)/, '缺少首次运行播种')
})

test('引擎不支持的开关在界面上置灰（对应验收 #7/#8）', () => {
  const stylesSource = read('../renderer/styles.css')
  assert.match(rendererSource, /function engineBlockedKeys/)
  assert.match(rendererSource, /engineIncompatibleConfigKeys/)
  assert.match(rendererSource, /is-disabled/)
  assert.ok(stylesSource.includes('.switch.is-disabled'), 'styles.css 缺少 .switch.is-disabled')
})

test('引擎不兼容开关的约束由代码兜底，不依赖预设文件写死', () => {
  // readPreset 现在先把 TOML 解析成局部变量 parsed 再走管线，两种写法都要认；
  // 关键是这条「normalize → sanitize」兜底链不能少。
  assert.match(mainSource, /sanitizeEngineParams\(normalizeConfig\((?:parseToml\(raw\)|parsed)\)\)/, 'readPreset 未做兜底')
  assert.match(mainSource, /sanitizeEngineParams\(normalizeConfig\(config\)\)/, 'saveConfig 未做兜底')
})

test('IPC 错误文案会剥掉 Electron 外层包装', () => {
  assert.match(rendererSource, /function readableError/)
  assert.match(rendererSource, /Error invoking remote method/)
  assert.match(rendererSource, /setToast\(readableError\(error\)\)/, '起服失败未用 readableError')
})

test('打包后数据根要用 portable 的真实目录（回归：自解压临时目录会被清掉）', () => {
  assert.match(mainSource, /PORTABLE_EXECUTABLE_DIR/, 'portable 目标下数据根会落在自解压临时目录')
  assert.match(mainSource, /process\.env\.PORTABLE_EXECUTABLE_DIR \|\| path\.dirname\(process\.execPath\)/)
})

test('启动前会校验 extra_args（回归：无效开关导致静默死亡）', () => {
  assert.match(mainSource, /async function assertExtraArgsSupported/)
  assert.match(mainSource, /await assertExtraArgsSupported\(sanitized\)/, '启动流程未调用校验')
  assert.match(mainSource, /unknownExtraFlags\(tokens, helpText\)/, '未用引擎 help 做比对')
  assert.match(mainSource, /async function engineHelpText/, '缺少 help 获取（按路径缓存）')
})

test('预设参数编辑器已完整接线', () => {
  assert.match(rendererSource, /function renderPresetEditor/)
  assert.match(rendererSource, /\$\{renderPresetEditor\(\)\}/, '编辑器未挂载')
  assert.match(rendererSource, /data-preset-field=/)
  assert.match(rendererSource, /data-action="preset-edit"/)
  assert.match(rendererSource, /action === 'preset-editor-save'/)
  assert.match(rendererSource, /action === 'preset-editor-close'/)

  // 输入必须只写草稿：重渲染会让输入框每敲一个字符就丢焦点。
  const updateFn = rendererSource.slice(
    rendererSource.indexOf('function updatePresetDraftField'),
    rendererSource.indexOf('async function presetEditorPick'),
  )
  assert.ok(updateFn.length > 0, '未找到 updatePresetDraftField')
  assert.doesNotMatch(updateFn, /renderAll\(\)/, 'updatePresetDraftField 不能重渲染')

  // 保存必须走引擎兜底，否则可能存出一份启动就被拒的预设。
  const saveFn = rendererSource.slice(
    rendererSource.indexOf('async function savePresetDraft'),
    rendererSource.indexOf('function renderPresetEditorField'),
  )
  assert.ok(saveFn.length > 0, '未找到 savePresetDraft')
  assert.match(saveFn, /sanitizeEngineParams/)
  assert.match(saveFn, /presetWrite/)
})

test('所有 renderXxx() 调用都必须有定义（回归：renderAll 从未定义过）', () => {
  // 真实事故：renderer/app.js 里调用 renderAll() 达 22 次，但整个文件从来没有
  // 定义过它（真正的渲染函数叫 render）。App 不报错、界面也不变 —— 所有预设操作
  // 都在改完 state 后崩在渲染那一步，表现为"点了没反应"。只有真机点得出来。
  const called = new Set(
    [...rendererCode.matchAll(/\b(render[A-Z][A-Za-z0-9_]*)\s*\(/g)].map(match => match[1]),
  )
  const defined = new Set()
  for (const match of rendererCode.matchAll(/function\s+(render[A-Z][A-Za-z0-9_]*)\s*\(/g)) defined.add(match[1])
  for (const match of rendererCode.matchAll(/(?:const|let|var)\s+(render[A-Z][A-Za-z0-9_]*)\s*=/g)) defined.add(match[1])
  for (const match of rendererSource.matchAll(/import\s*\{([\s\S]*?)\}\s*from/g)) {
    for (const part of match[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).pop().trim()
      if (name) defined.add(name)
    }
  }
  const missing = [...called].filter(name => !defined.has(name)).sort()
  assert.deepEqual(missing, [], '这些渲染函数被调用但从未定义：' + missing.join('、'))
})

test('编辑器字段全部存在于主进程配置模式里（跨文件契约）', () => {
  const block = rendererSource.slice(
    rendererSource.indexOf('const PRESET_EDITOR_GROUPS = ['),
    rendererSource.indexOf('function openPresetEditor'),
  )
  assert.ok(block.length > 0, '未找到 PRESET_EDITOR_GROUPS')
  const fields = [...block.matchAll(/name: '([a-z0-9_]+)'/g)].map(match => match[1])
  assert.ok(fields.length >= 30, '可调参数偏少，实际 ' + fields.length)

  const configBlock = mainSource.slice(
    mainSource.indexOf('function defaultConfig()'),
    mainSource.indexOf('async function readJson'),
  )
  const configKeys = new Set([...configBlock.matchAll(/^ {4}([a-z0-9_]+):/gm)].map(match => match[1]))
  assert.ok(configKeys.size > 30, '未解析出配置字段，实际 ' + configKeys.size)
  for (const name of fields) {
    assert.ok(configKeys.has(name), '编辑器字段 ' + name + ' 不在 defaultConfig 里')
  }
})

test('启动前的显存拦截已完整接线（验收 #9）', () => {
  assert.match(rendererSource, /function renderVramGuardDialog/, '缺少显存拦截弹窗渲染')
  assert.match(rendererSource, /\$\{renderVramGuardDialog\(\)\}/, '弹窗未挂载')
  for (const action of ['vram-guard-confirm', 'vram-guard-cancel']) {
    assert.ok(rendererSource.includes("action === '" + action + "'"), '事件分发缺少 ' + action)
  }
  // start() 必须先查显存、命中警戒线就停下等用户决定，不能直接起服。
  const startFn = rendererSource.slice(
    rendererSource.indexOf('async function start()'),
    rendererSource.indexOf('async function doStartServer()'),
  )
  assert.ok(startFn.length > 0, '未找到 start()')
  assert.match(startFn, /await checkVram\(\)/, 'start() 未在启动前重查显存')
  assert.match(startFn, /state\.vramWarning/, 'start() 未判警戒线')
  assert.match(startFn, /state\.vramGuard/, 'start() 未弹出拦截弹窗')
  assert.doesNotMatch(startFn, /startServer\(/, 'start() 不应直接起服，必须先过守卫')

  // 阈值只有一份真相
  assert.match(mainSource, /LLAMA_DESKTOP_FORCE_LOW_VRAM/, '缺少低显存测试缝')
  assert.match(rendererSource, /VRAM_WARN_THRESHOLD_MIB/, '弹窗未复用共享阈值')
})

test('设置页签自定义排序已完整接线', () => {
  assert.match(rendererSource, /orderedSettingsTabs\(\)/, '左栏未使用自定义顺序')
  assert.match(rendererSource, /state\.tabOrder = loadTabOrder\(\)/, '启动时未载入顺序')
  for (const action of ['tab-move-up', 'tab-move-down', 'tab-order-reset']) {
    assert.ok(rendererSource.includes("action === '" + action + "'"), '事件分发缺少 ' + action)
  }
  assert.ok(rendererSource.includes('llama-desktop:tab-order'), '缺少顺序持久化 key')

  const stylesSource = read('../renderer/styles.css')
  for (const selector of ['.tab-order-list', '.tab-order-row', '.preset-editor-body', '.preset-editor-grid']) {
    assert.ok(stylesSource.includes(selector), 'styles.css 缺少 ' + selector)
  }
})

// ---------- 原型参数面板 ↔ 主进程配置的跨文件契约 ----------

test('原型那 6 个参数都有真实 flag，且按引擎能力守卫', () => {
  // 事故背景：KVMem 不认的开关拼进命令行就是 unknown flag 当场退出，
  // 所以每个可选 flag 都必须先问 supportsFlag。
  const guarded = [
    ['--cache-type-k', 'type_k'],
    ['--cache-type-v', 'type_v'],
    ['--kv-unified-per-slot', 'kv_out_size'],
    ['--rope-freq-base', 'rope_freq_base'],
    ['--mirostat', 'mirostat'],
  ]
  const lines = mainSource.split('\n')
  for (const [flag, key] of guarded) {
    const needle = "if (supportsFlag('" + flag + "')) pushArg(args, '" + flag + "', "
    assert.ok(mainSource.includes(needle), flag + ' 未按引擎能力守卫')
    const line = lines.find(item => item.includes(needle)) || ''
    assert.ok(line.includes('config.' + key), flag + ' 未接到 config.' + key)
  }
  assert.ok(mainSource.includes("supportsFlag('--lora')"), '--lora 未按引擎能力守卫')
  // 0 = 不设：这两个数值参数必须过 positiveNumber，否则会拼出 "--x 0"
  assert.ok(mainSource.includes('positiveNumber(config.kv_out_size)'), 'kv_out_size 未做 0=不设')
  assert.ok(mainSource.includes('positiveNumber(config.rope_freq_base)'), 'rope_freq_base 未做 0=不设')
  // num_lora 只决定取前 N 个，真正路径来自 lora_paths
  assert.ok(mainSource.includes('loraPathsForConfig(config)'), '--lora 未按 num_lora 截取路径')
})

test('新参数键能落盘：TOML 是白名单式，漏写就存不下来', () => {
  for (const key of ['type_k', 'type_v', 'mirostat']) {
    const needle = key + ' = ${tomlString(config.' + key + ')}'
    assert.ok(mainSource.includes(needle), key + ' 未写入 TOML')
  }
  for (const key of ['kv_out_size', 'rope_freq_base', 'num_lora']) {
    assert.ok(mainSource.includes("optionalNumberLine('" + key + "'"), key + ' 未写入 TOML')
  }
  assert.ok(mainSource.includes('lora_paths = ${tomlString(config.lora_paths)}'), 'lora_paths 未写入 TOML')
})

test('参数面板每个字段都在 defaultConfig 里（与预设编辑器同一契约）', () => {
  const block = rendererSource.slice(
    rendererSource.indexOf('const PARAM_PANEL_SECTIONS = ['),
    rendererSource.indexOf('function paramTipHtml'),
  )
  assert.ok(block.length > 0, '未找到 PARAM_PANEL_SECTIONS')
  const fields = [...block.matchAll(/field: '([a-z0-9_]+)'/g)].map(match => match[1])
  assert.ok(fields.length >= 20, '面板字段偏少，实际 ' + fields.length)

  const configBlock = mainSource.slice(
    mainSource.indexOf('function defaultConfig()'),
    mainSource.indexOf('async function readJson'),
  )
  const configKeys = new Set([...configBlock.matchAll(/^ {4}([a-z0-9_]+):/gm)].map(match => match[1]))
  for (const name of fields) {
    assert.ok(configKeys.has(name), '面板字段 ' + name + ' 不在 defaultConfig 里')
  }
  // 原型那 6 个必须都在面板里（不许再退回「本应用没有这个键」）
  for (const name of ['type_k', 'type_v', 'kv_out_size', 'rope_freq_base', 'num_lora', 'mirostat']) {
    assert.ok(fields.includes(name), '原型字段 ' + name + ' 未接进参数面板')
  }
})

test('渲染层的置灰清单同时覆盖布尔键与非布尔参数', () => {
  assert.ok(rendererSource.includes('engineIncompatibleConfigKeys(id)'), '未用布尔清单')
  assert.ok(rendererSource.includes('engineIncompatibleParamKeys(id)'), '未用非布尔参数清单')
})

// ---------- 原型 sec-mem / sec-hw 开关 + 状态栏指标条 ----------

test('原型 sec-mem / sec-hw 的开关都已接成真 flag', () => {
  // 原型 data-toggle: mlock, no_map (sec-mem) + flash_attn, logits_all, no_perf, use_mmap, verbose (sec-hw)
  for (const key of ['flash_attn', 'no_perf', 'mlock', 'no_map', 'use_mmap']) {
    assert.ok(mainSource.includes(key + ':'), key + ' 不在 defaultConfig 里')
  }
  // flash-attn 是带值开关（on|off|auto）：开 = 强制 on，关 = 不传（保持 auto）
  assert.ok(mainSource.includes("args.push('--flash-attn', 'on')"), 'flash-attn 未拼成 on')
  // no_map 与 use_mmap 互为反义，必须互斥，否则会同时拼出 --mmap 与 --no-mmap
  assert.match(
    mainSource,
    /if \(config\.no_map[^\n]*\) args\.push\('--no-mmap'\)\s*\n\s*else if \(config\.use_mmap/,
    'no_map / use_mmap 未做互斥',
  )
  // logits_all 刻意不实现：三引擎的 --help 里都没有 --logits-all（注释里会提到，只查是否真被拼出）
  assert.doesNotMatch(mainSource, /args\.push\([^)]*--logits-all/, 'logits-all 不该被拼出来')
  assert.doesNotMatch(mainSource, /pushArg\([^)]*--logits-all/, 'logits-all 不该被拼出来')
  assert.ok(!mainSource.includes('logits_all:'), 'logits_all 不该进 defaultConfig')
})

test('底部状态栏有 VRAM/RAM 指标条（对齐原型 .res-metrics）', () => {
  const stylesSource = read('../renderer/styles.css')
  assert.ok(rendererSource.includes('function renderResMetrics'), '缺少 renderResMetrics')
  assert.ok(rendererSource.includes('${renderResMetrics()}'), 'renderResMetrics 未挂进 service-bar')
  assert.ok(rendererSource.includes('state.vramUsage'), 'VRAM 未接数据源')
  assert.ok(rendererSource.includes('totalMemoryGB'), 'RAM 未接数据源')
  for (const sel of ['.res-metrics', '.metric-label', '.metric-content', '.metric-text', '.metric .bar', '.metric .fill']) {
    assert.ok(stylesSource.includes(sel), 'styles.css 缺少 ' + sel)
  }
})

test('面板每个开关字段都在 defaultConfig 里（含 sec-mem / sec-hw 那批）', () => {
  const block = rendererSource.slice(
    rendererSource.indexOf('const PARAM_PANEL_SECTIONS = ['),
    rendererSource.indexOf('function paramTipHtml'),
  )
  const fields = [...block.matchAll(/field: '([a-z0-9_]+)'/g)].map(m => m[1])
  for (const name of ['mlock', 'no_map', 'flash_attn', 'no_perf', 'use_mmap']) {
    assert.ok(fields.includes(name), '面板缺少字段 ' + name)
  }
  const configBlock = mainSource.slice(
    mainSource.indexOf('function defaultConfig()'),
    mainSource.indexOf('async function readJson'),
  )
  const configKeys = new Set([...configBlock.matchAll(/^ {4}([a-z0-9_]+):/gm)].map(m => m[1]))
  for (const name of fields) {
    assert.ok(configKeys.has(name), '面板字段 ' + name + ' 不在 defaultConfig 里')
  }
})

test('预设读写两端都设了外观防漏（回归：保存预设会把外观腌进文件）', () => {
  // 事故：另存为提交整个 state.config，buildToml 照单全收，
  // 于是 theme_mode/chat_font 被写进预设；加载时 render() 开头的
  // applyAppearancePreferences() 立刻把界面翻成预设里那个外观。
  //
  // 2026-09-30 二次踩坑：这条测试当时只断言「调用了 stripUiPreferences」，
  // 而 buildToml 内部**无条件**写这两行 —— 断言通过、bug 照旧，
  // 实测导出的预设文件里确实带着 theme_mode/chat_font。
  // 现在断言真正的契约：写预设必须显式关掉外观键。
  assert.ok(
    mainSource.includes('buildToml(stripUiPreferences(config), { includeUiPreferences: false, presetHeader: true })'),
    'writePreset 未显式关掉外观键（只调 stripUiPreferences 不够，buildToml 会再写回去）',
  )
  assert.ok(
    /const includeUiPreferences = options\.includeUiPreferences !== false/.test(mainSource),
    'buildToml 缺少 includeUiPreferences 开关',
  )
  assert.ok(
    /\.\.\.\(includeUiPreferences \? \[[\s\S]*?theme_mode[\s\S]*?chat_font[\s\S]*?\] : \[\]\)/.test(mainSource),
    'buildToml 里 theme_mode/chat_font 必须受开关控制，不能无条件写',
  )
  // readPreset 现在是多行管线：
  //   parseToml → normalizeConfig → sanitizeEngineParams → stripUiPreferences → restoreEmptyPathFields
  // 所以不再断言那一行字面量，改断言「管线里确实剥了外观键」。
  const readPresetStart = mainSource.indexOf('async function readPreset(')
  assert.ok(readPresetStart >= 0, '没找到 readPreset')
  const readPresetBody = mainSource.slice(readPresetStart, readPresetStart + 1200)
  assert.ok(
    /stripUiPreferences\(\s*[\s\S]*?sanitizeEngineParams\(normalizeConfig\(parsed\)\)/.test(readPresetBody),
    'readPreset 未剔除外观键',
  )
  assert.ok(rendererSource.includes('preserveUiPreferences(state.config'), 'applyPreset 未保留当前外观')
  assert.ok(rendererSource.includes('stripUiPreferences(state.config)'), '另存为未剥外观键')
  assert.ok(
    rendererSource.includes('stripUiPreferences(sanitizeEngineParams(state.presetDraft))'),
    '预设编辑器保存未剥外观键',
  )
})

// ---------- 底部状态栏 / 窗口控件留位 / 引导门控 / overlay 配色 ----------

test('底部状态栏是原型的三段式（status-left + res-metrics + acts）', () => {
  const stylesSource = read('../renderer/styles.css')
  assert.ok(rendererSource.includes('<footer class="status">'), '未用原型的 .status 容器')
  assert.ok(rendererSource.includes('class="status-left"'), '缺少 .status-left')
  assert.ok(rendererSource.includes('class="led '), '缺少 .led 指示灯')
  assert.ok(rendererSource.includes('class="st-txt"'), '缺少 .st-txt')
  assert.ok(rendererSource.includes('class="st-url"'), '缺少 .st-url')
  assert.ok(rendererSource.includes('class="acts"'), '缺少 .acts 按钮组')
  assert.ok(rendererSource.includes('class="abtn ghost"'), '缺少 .abtn ghost')
  assert.ok(rendererSource.includes('class="abtn go"'), '缺少 .abtn go')
  assert.ok(rendererSource.includes('class="abtn no"'), '缺少 .abtn no')
  for (const sel of ['.status {', '.status-left', '.led {', '.st-txt', '.st-url', '.res-metrics', '.acts {', '.abtn {', '.abtn.ghost', '.abtn.no', '.abtn.go']) {
    assert.ok(stylesSource.includes(sel), 'styles.css 缺少 ' + sel)
  }
  // 原型的两条渐变：VRAM 走 ok->warn，RAM 走蓝青
  assert.ok(stylesSource.includes('.metric .fill.vram'), '缺少 VRAM 渐变')
  assert.ok(stylesSource.includes('.metric .fill.ram'), '缺少 RAM 渐变')
  assert.ok(rendererSource.includes("variant: 'vram'") && rendererSource.includes("variant: 'ram'"), '指标未区分 vram/ram 变体')
  // 旧的三段式残留不该再有
  assert.ok(!rendererSource.includes('class="service-bar"'), '旧的 .service-bar 应已替换')
})

test('顶栏给系统窗口控件留位（titleBarOverlay 悬浮在右上角）', () => {
  const stylesSource = read('../renderer/styles.css')
  // 实测：1340 宽窗口下 env(titlebar-area-width)=1204，即控件占 136px
  assert.ok(stylesSource.includes('env(titlebar-area-width'), '未用 env(titlebar-area-width) 计算留位')
  assert.match(stylesSource, /\.topbar\s*\{[\s\S]*?padding-right:\s*150px/, '缺少 env 不可用时的固定回退')
  // overlay 是独立图层，页面改 CSS 影响不到，必须主动同步
  assert.ok(mainSource.includes("ipcMain.handle('app:set-titlebar-theme'"), '主进程缺少 overlay 配色同步')
  assert.ok(mainSource.includes('setTitleBarOverlay('), '未调用 setTitleBarOverlay')
})

test('主区引导首次使用后消失', () => {
  assert.ok(rendererSource.includes('ONBOARDING_DONE_KEY'), '缺少持久化键')
  assert.ok(rendererSource.includes('function markOnboardingDone'), '缺少 markOnboardingDone')
  assert.match(rendererSource, /isSetupOnboarding = isEmptyChat\s*\n\s*&& !state\.onboardingDone/, '引导未按已用门控')
  // 三种「用过」都要落标记
  assert.ok(rendererSource.includes("if (payload.status.state === 'running') markOnboardingDone()"), '起服务未落标记')
  assert.match(rendererSource, /async function sendChat\(\) \{\s*\n\s*markOnboardingDone\(\)/, '发消息未落标记')
})

test('深色模式品牌标记不再「一坨黑」', () => {
  const stylesSource = read('../renderer/styles.css')
  // 回归：旧 .app-mark 规则排在后面，用未定义的 --accent 回退成硬编码 #0a0a0a，
  // 深色下变成黑底黑图标。那条死规则必须不存在。
  assert.ok(!stylesSource.includes('var(--accent, #0a0a0a)'), '旧的 --accent 回退黑仍在，会覆盖深色配色')
  assert.ok(!stylesSource.includes('.brand-copy'), '旧的死类 .brand-copy 仍在')
  assert.ok(!stylesSource.includes('.brand-row'), '旧的死类 .brand-row 仍在')
  // 新规则的背景必须走主题变量
  assert.match(stylesSource, /\.app-mark,\s*\n\.brand-mark\s*\{[\s\S]*?background:\s*var\(--green\)/)
})

test('图标 SVG 必须有尺寸来源（回归：齿轮在顶栏塌成空框）', () => {
  const stylesSource = read('../renderer/styles.css')
  // 这些 render*Icon() 产出的 svg 只有 viewBox、没有 width/height 属性，
  // 也没有全局 svg 尺寸规则 —— 缺 CSS 尺寸就会在 flex 里塌成一个空框，图标看不见。
  const usages = [
    ['renderGearIcon', '.topbar-action svg'],
    ['renderCopyIcon', '.icon-copy-btn svg'],
    ['renderModelChipIcon', '.model-chip-icon svg'],
    ['renderSettingsTabIcon', '.settings-tab-icon svg'],
  ]
  for (const [fn, sel] of usages) {
    assert.ok(rendererSource.includes('function ' + fn), '缺少 ' + fn)
    assert.ok(stylesSource.includes(sel), fn + ' 的 svg 没有 CSS 尺寸来源，会塌成空框')
  }
  assert.ok(stylesSource.includes('.app-mark svg'), '品牌标记 svg 缺少尺寸规则')
  // 品牌标记另走内联尺寸，确认它确实带属性
  assert.match(rendererSource, /<svg width="16" height="16" viewBox="0 0 16 16"/)
})
