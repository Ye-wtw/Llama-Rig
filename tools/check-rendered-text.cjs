// 界面文本运行时检查
//
// 为什么必须有这一层：源码扫描看不到插值。
//   addLog('desktop', `配置已保存：${config.config_path}`)
// 在源码里只有「配置已保存：」，路径是运行时拼进去的 ——
// 而这次的路径泄露大多是这种形态。只有把真实渲染结果抓出来看才靠得住。
//
// 判定模型不是「文本里有没有路径」，而是**按区域判定**：
//   prose（散文/标签/状态）  → 不允许出现盘符路径与可执行文件名（这是这次要修的那类）
//   editable（输入框的值）   → 允许。用户在「模型」「高级」里就是要看和改这些路径
//   pre（等宽命令预览块）    → 允许。启动命令预览、日志明细本身就是给排障看的
//   log（日志区）            → 允许。引擎自己的输出里本来就带路径
//   悬停提示 title           → 允许（有意保留的按需查看渠道），只登记不判失败
//
// 用法: node tools/check-rendered-text.cjs <wsUrl>
// 取得 wsUrl: 用 --remote-debugging-port=PORT 启动应用，
//             访问 http://127.0.0.1:PORT/json/list 取 webSocketDebuggerUrl
const WebSocket = globalThis.WebSocket

const WS = process.argv[2]
if (!WS) {
  console.error('用法: node tools/check-rendered-text.cjs <wsUrl>')
  process.exit(2)
}

const pending = new Map()
let seq = 0
const ws = new WebSocket(WS)
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data.toString())
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result || {}); pending.delete(m.id) }
})
const send = (method, params) => new Promise(res => {
  const i = ++seq
  pending.set(i, res)
  ws.send(JSON.stringify({ id: i, method, params }))
})
const ev = async expr => {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) return 'EVAL-ERROR: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text)
  return r.result?.value
}
const sleep = ms => new Promise(r => setTimeout(r, ms))
const click = sel => ev('(function(){ var b=document.querySelector(' + JSON.stringify(sel) + '); if(b){b.click(); return true} return false })()')

const GRAB = [
  '(function(){',
  '  var NL = String.fromCharCode(10);',
  '  var items = [];',
  '  var titles = [];',
  '  function visible(el) {',
  '    var cs = getComputedStyle(el);',
  '    if (cs.display === "none" || cs.visibility === "hidden" || +cs.opacity === 0) return false;',
  '    var r = el.getBoundingClientRect();',
  '    return r.width >= 2 && r.height >= 2;',
  '  }',
  '  // 按区域分类：谁在承载这段文本',
  '  function zoneOf(el) {',
  '    var tag = el.tagName;',
  '    if (tag === "INPUT" || tag === "TEXTAREA") return "editable";',
  '    var e = el;',
  '    while (e && e !== document.body) {',
  '      var cls = String(e.className || "");',
  '      if (/path-snapshot|command-preview|terminal-console|log-box|log-entry|terminal-line|model-template|raw-output|code-block|preview-panel/.test(cls)) return "pre";',
  '      if (tag === "PRE" || e.tagName === "PRE") return "pre";',
  '      e = e.parentElement;',
  '    }',
  '    return "prose";',
  '  }',
  '  var nodes = document.querySelectorAll("body *");',
  '  for (var i = 0; i < nodes.length; i++) {',
  '    var el = nodes[i];',
  '    if (!visible(el)) continue;',
  '    if (!el.children.length) {',
  '      var t = (el.textContent || "").trim();',
  '      if (t) items.push(zoneOf(el) + " :: " + t);',
  '    }',
  '    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {',
  '      var v = String(el.value || "").trim();',
  '      if (v) items.push("editable :: " + v);',
  '    }',
  '    if (el.tagName === "OPTION" && el.selected) {',
  '      var ot = String(el.textContent || "").trim();',
  '      if (ot) items.push("prose :: " + ot);',
  '    }',
  '    var tv = String(el.getAttribute("title") || "").trim();',
  '    if (tv) titles.push(String(el.className || el.tagName).split(" ")[0] + " :: " + tv);',
  '  }',
  '  return JSON.stringify({ items: items.join(NL), titles: titles.join(NL) });',
  '})()',
].join('\n')

const DRIVE_PATH = /[A-Za-z]:\\/
const EXE_NAME = /\.[eE][xX][eE]\b/

// 运行时白名单：只放「指导用户去磁盘上找到某个文件」的可操作指引。
// 与 tools/lint-ui-text.cjs 的 ALLOW 同一口径，两处都必须写明理由。
const ALLOW_PHRASES = [
  '选择 llama-server.exe',
  '已找到 llama-server.exe',
  'llama-server.exe',
  '目录里要有 llama-server.exe 以及同版本的 DLL。',
]
const isAllowedPhrase = t =>
  ALLOW_PHRASES.includes(t) ||
  /下载包含 llama-server\.exe/.test(t) ||
  /direct = 直接调用 llama-server\.exe/.test(t) ||
  /选择包含 llama-server\.exe 的目录/.test(t)

let checkedStates = 0
const problems = []
const titleExposures = []
const zoneHits = { editable: 0, pre: 0 }

function scanItems(label, items) {
  for (const line of String(items).split('\n')) {
    const t = line.trim()
    if (!t) continue
    const sep = t.indexOf(' :: ')
    const zone = sep > 0 ? t.slice(0, sep) : 'prose'
    const text = sep > 0 ? t.slice(sep + 4) : t
    const hasPath = DRIVE_PATH.test(text)
    const hasExe = EXE_NAME.test(text)
    if (!hasPath && !hasExe) continue
    if (zone !== 'prose') { zoneHits[zone] = (zoneHits[zone] || 0) + 1; continue }
    if (isAllowedPhrase(text)) continue
    problems.push({
      state: label,
      kind: hasPath ? '散文里的盘符路径' : '散文里的可执行文件名',
      text: text.slice(0, 120),
    })
  }
}

async function scanState(label) {
  checkedStates++
  const raw = await ev(GRAB)
  let parsed
  try { parsed = JSON.parse(raw) } catch {
    problems.push({ state: label, kind: '抓取失败', text: String(raw).slice(0, 200) })
    return
  }
  scanItems(label, parsed.items)
  for (const line of String(parsed.titles).split('\n')) {
    const t = line.trim()
    if (!t) continue
    if (DRIVE_PATH.test(t) || EXE_NAME.test(t)) titleExposures.push({ state: label, text: t.slice(0, 110) })
  }
}

(async () => {
  await new Promise(r => ws.addEventListener('open', r))
  await sleep(3000)
  await send('Page.bringToFront', {})
  await sleep(500)

  console.log('=== 主视图 ===')
  for (const [view, name] of [['params', '参数'], ['chat', '聊天'], ['terminal', '终端']]) {
    await click('[data-action="set-view"][data-view="' + view + '"]')
    await sleep(1200)
    await scanState('视图·' + name)
  }

  console.log('=== 顶栏两个下拉 ===')
  await click('[data-action="toggle-topbar-menu"][data-menu="engine"]')
  await sleep(900)
  await scanState('顶栏·引擎下拉')
  await click('[data-action="toggle-topbar-menu"][data-menu="engine"]')
  await sleep(500)
  await click('[data-action="toggle-topbar-menu"][data-menu="models"]')
  await sleep(2500)
  await scanState('顶栏·模型下拉')
  await click('[data-action="toggle-topbar-menu"][data-menu="models"]')
  await sleep(500)

  console.log('=== 7 个设置页 ===')
  await click('[data-action="toggle-settings"]')
  await sleep(1400)
  for (const t of ['overview', 'presets', 'display', 'developer', 'appearance', 'logs', 'rescue']) {
    await click('[data-section="' + t + '"]')
    await sleep(1100)
    await scanState('设置·' + t)
  }

  console.log('=== 救援页：路径快照默认折叠 ===')
  await click('[data-section="rescue"]')
  await sleep(1100)
  const state = await ev([
    '(function(){',
    '  var box = document.querySelector(".path-snapshot");',
    '  if (!box) return "MISSING";',
    '  var rows = box.querySelectorAll("div");',
    '  var shown = 0;',
    '  for (var i = 0; i < rows.length; i++) {',
    '    var r = rows[i].getBoundingClientRect();',
    '    if (r.width > 2 && r.height > 2 && getComputedStyle(rows[i]).display !== "none") shown++;',
    '  }',
    '  return JSON.stringify({ visibleRows: shown, hasToggle: !!box.querySelector(".path-snapshot-toggle") });',
    '})()',
  ].join('\n'))
  console.log('  ' + state)
  try {
    const st = JSON.parse(state)
    if (!st.hasToggle) problems.push({ state: '救援页', kind: '缺少折叠开关', text: '路径快照没有 toggle' })
    else if (st.visibleRows > 0) problems.push({ state: '救援页', kind: '路径快照未默认折叠', text: '可见路径行数=' + st.visibleRows })
  } catch { problems.push({ state: '救援页', kind: '折叠状态无法解析', text: String(state) }) }

  console.log('=== 展开路径快照（用户主动查看排障信息）===')
  await click('[data-action="toggle-path-snapshot"]')
  await sleep(1200)
  const before = problems.length
  await scanState('救援页（展开后）')
  const inSnapshot = await ev('(function(){ var b=document.querySelector(".path-snapshot"); return b ? b.innerText : "" })()')
  const snapshotLines = new Set(String(inSnapshot).split('\n').map(s => s.trim()).filter(Boolean))
  const kept = problems.slice(0, before).concat(problems.slice(before).filter(p => !snapshotLines.has(p.text)))
  problems.length = 0
  problems.push(...kept)
  await click('[data-action="toggle-path-snapshot"]')
  await sleep(1000)

  console.log('')
  console.log('检查了 ' + checkedStates + ' 个界面状态')
  console.log('  （区域判定：editable/pre 区域里的路径 ' + ((zoneHits.editable || 0) + (zoneHits.pre || 0)) + ' 处，属允许范围）')
  if (titleExposures.length) {
    console.log('')
    console.log('悬停提示里暴露路径的位置（有意保留的按需查看渠道，仅登记）：')
    const seen = new Set()
    for (const t of titleExposures) {
      const key = t.state + '|' + t.text.split('::')[0]
      if (seen.has(key)) continue
      seen.add(key)
      console.log('  [' + t.state + '] ' + t.text)
    }
  }
  if (!problems.length) {
    console.log('')
    console.log('运行时文本检查：通过')
    console.log('  （散文区域无盘符路径与可执行文件名；路径快照默认折叠，展开后仅限本区块）')
    process.exit(0)
  }
  console.log('')
  console.log('运行时文本检查：发现 ' + problems.length + ' 处')
  for (const p of problems) {
    console.log('')
    console.log('  [' + p.state + '] ' + p.kind)
    console.log('    ' + p.text)
  }
  process.exit(1)
})()
