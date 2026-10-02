import { runtimeWarnings } from '../desktop/lib/runtime-policy.mjs'

import { TERMINAL_VIEW_LOG_LIMIT, selectTerminalLogs, selectVisibleTerminalLogs } from '../desktop/lib/log-pipeline.mjs'
import { moveTabInOrder, normalizeTabOrder, orderTabsById, tabsDefaultOrder } from './lib/tab-order.js'
import { presetNameIssue } from './lib/preset-naming.js'

// 引擎能力约束与主进程共用同一份真相源：UI 置灰、切换引擎、加载预设三处都靠它。
import {
  VRAM_WARN_THRESHOLD_MIB,
  applyPresetOverCurrent,
  cacheTypeIssues,
  cacheTypeSupported,
  detectEngineByPath,
  engineCacheTypes,
  engineIncompatibleConfigKeys,
  engineIncompatibleLabels,
  engineIncompatibleParamKeys,
  getEngineLabel,
  preserveUiPreferences,
  sanitizeEngineParams,
  stripUiPreferences,
  vramSnapshot,
} from '../desktop/lib/preset-engine.mjs'

import {
  attachmentMenuPosition,
  attachmentNotice,
  renderAttachmentMenu,
  renderAttachmentNotice,
} from './lib/attachment-policy.js'
import {
  diagnosticBundleText,
  modelCapability,
  readinessChecklist,
  terminalDiagnosis,
} from './lib/product-insights.js'
import {
  clientSmokePlan,
  downloadGuidance,
  environmentIntegrity,
  firstRunSteps,
  hardwareRecommendation,
  integrationGuide,
  modelCapabilityCatalog,
  modelRecommendation,
  multimodalAdvice,
  performanceHints,
  portDiagnosis,
  portRepairPlan,
  shouldShowFirstRunWizard,
  startupDiagnosis,
  supportBundleText,
} from './lib/feedback-repair.js'

// 旧的 8 页签表（sections）随废弃的 renderSettingsPanel / renderSettingsContent /
// renderSettingsSection 一起删除：那套面板早已不被 render() 调用，留着只会让人
// 以为设置里真有「采样/惩罚」等页面，也让改动落到不生效的代码上。
// 现行唯一的页签表是下面的 settingsTabs。

const promptSeeds = ['你现在是什么模型', '分析一下内容', '写一个 API 请求示例', '生成 OpenAI 兼容配置']
// 设置左栏页签表。顺序可被用户自定义（见下方 tab-order 一节）。
//
// 2026-09-29 从 9 个收敛到 7 个，删掉的两个都经实测确认是「无用的页面」：
//   · mcp       —— 纯占位，正文只有一句「未接入原生 MCP 服务」，零可操作项；
//   · io 进出口 —— direct 模式下 field() 会把 config_path / launcher_path /
//                  llama_server_path 三个字段全部返回空串，整页只剩一个标题卡，
//                  实测 .settings-body 里字段数 = 0。它的真实内容（路径类字段）
//                  并入了「高级」，不再单开一页。
// 页签 id 保持不变（overview/display/developer/presets/appearance/logs/rescue），
// 这样旧版本存在 localStorage 里的自定义顺序不需要迁移。
const settingsTabs = [
  ['overview', '&#9881;', '概述', '服务入口、启动命令与接入信息'],
  ['presets', '&#9733;', '预设与引擎', '一键加载配置，引擎按 server 路径自动匹配'],
  ['display', '&#128421;', '模型', 'GGUF、视觉投影与显示项'],
  ['developer', '&lt;/&gt;', '高级', '路径、线程、批处理与附加参数'],
  ['appearance', '&#9681;', '外观', '主题、字体与页签顺序'],
  ['logs', '&#128196;', '日志', '当前 llama.cpp 服务输出'],
  ['rescue', '&#9874;', '启动救援', '启动失败、端口与第三方接入排查'],
]

// ============================================================
// 设置左栏页签的自定义排序
//
// 顺序存在 localStorage 里（和会话记录同一套持久化），不动 config.toml，
// 也就不影响命令行入口依赖的配置字段集。
// ============================================================

const SETTINGS_TAB_ORDER_KEY = 'llama-desktop:tab-order'

function defaultTabOrder() {
  return tabsDefaultOrder(settingsTabs)
}

function loadTabOrder() {
  try {
    const raw = JSON.parse(window.localStorage?.getItem(SETTINGS_TAB_ORDER_KEY) || 'null')
    return normalizeTabOrder(raw, settingsTabs)
  } catch {
    return defaultTabOrder()
  }
}

function persistTabOrder() {
  try {
    window.localStorage?.setItem(SETTINGS_TAB_ORDER_KEY, JSON.stringify(state.tabOrder))
  } catch {
    // localStorage 不可用时静默降级：顺序只在本次会话内生效。
  }
}

function orderedSettingsTabs() {
  return orderTabsById(settingsTabs, state.tabOrder)
}

function moveSettingsTab(id, delta) {
  state.tabOrder = moveTabInOrder(state.tabOrder, id, delta, settingsTabs)
  persistTabOrder()
  render()
}

function resetSettingsTabOrder() {
  state.tabOrder = defaultTabOrder()
  persistTabOrder()
  state.toast = '设置页签顺序已恢复默认'
  render()
}

function renderTabOrderList() {
  const tabs = orderedSettingsTabs()
  return `
    <div class="tab-order-list">
      ${tabs.map(([id, _icon, label, hint], index) => `
        <div class="tab-order-row">
          <span class="tab-order-index">${index + 1}</span>
          <span class="tab-order-copy">
            <strong>${escapeHtml(label)}</strong>
            <em>${escapeHtml(hint)}</em>
          </span>
          <button type="button" class="icon-btn" data-action="tab-move-up" data-tab-id="${escapeAttribute(id)}" ${index === 0 ? 'disabled' : ''} title="上移">↑</button>
          <button type="button" class="icon-btn" data-action="tab-move-down" data-tab-id="${escapeAttribute(id)}" ${index === tabs.length - 1 ? 'disabled' : ''} title="下移">↓</button>
        </div>
      `).join('')}
    </div>
    <button type="button" class="outline-btn" data-action="tab-order-reset">恢复默认顺序</button>
  `
}

const appEl = document.getElementById('app')
const STREAM_RENDER_INTERVAL_MS = 100
let pendingStreamRenderIndex = null
let streamRenderTimer = null

const state = {
  active: 'chat',
  config: null,
  validation: {},
  launch: {},
  status: { state: 'stopped', message: '服务未启动', url: 'http://127.0.0.1:8080' },
  logs: { entries: [], filtered: 0, truncated: 0, dropped: 0 },
  view: 'params',
  paramTab: 'gen',
  sidebarPanel: 'chats',
  sidebarCollapsed: false,
  sessions: [],
  currentSessionId: '',
  historySearch: '',
  historyMenuId: '',
  historyDialog: null,
  presetDialog: null,
  presetPreview: null,
  presetDraft: null,
  presetEditorName: null,
  presetEditorDirty: false,
  tabOrder: [],
  chatMessages: [],
  chatInput: '',
  attachments: [],
  draggingFiles: false,
  dragDepth: 0,
  openThinkingMessages: new Set(),
  closedThinkingMessages: new Set(),
  attachmentMenuOpen: false,
  attachmentMenuPosition: null,
  streamRequestId: '',
  preview: null,
  previewError: '',
  modelInfo: null,
  modelInfoOpen: false,
  chatBusy: false,
  dirty: false,
  busy: false,
  settingsOpen: false,
  firstRunWizardOpen: false,
  firstRunWizardSeen: false,
  health: null,
  runCheckExpanded: false,
  portInspection: null,
  systemInfo: null,
  clientSmoke: null,
  toast: '',
  topbarMenu: null,
  onboardingDone: false,
  terminalTab: 'output',
  // P0-1: Preset/Engine/VRAM state
  preset: null,
  presetList: [],
  presetMeta: null,
  engine: null,
  engineList: [],
  // 扫描到的引擎候选（同一个引擎可能有多份构建，靠路径区分）
  engineCandidates: [],
  vramUsage: null,
  vramWarning: false,
  vramGuard: null,
  // 启动救援页的路径快照：默认折叠（完整路径保留，展开才看）
  pathSnapshotOpen: false,
  // 按硬件生成的稳定预设（弹窗）：null | {loading} | {error} | {result}
  stablePreset: null,
  // 顶栏「模型」折叠菜单：本机全部本地 gguf
  modelList: [],
  modelListLoaded: false,
  presetSummaries: [],
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/'/g, '&#39;')
}

// Electron 会把主进程抛出的错误包成
// "Error invoking remote method 'llama:start-server': Error: 真正的信息"，
// 直接弹给用户读起来很吵；这里剥掉外层壳，只留能照做的部分。
function readableError(error) {
  const text = (error && error.message) || String(error || '')
  return text
    .replace(/^Error invoking remote method '[^']*':\s*/, '')
    .replace(/^Error:\s*/, '')
}

// ============================================================
// P0: Preset / Engine / VRAM management
// ============================================================

// 预设名单 + 预设摘要，两者必须一起刷新。
//
// 摘要（presetSummaries）决定左侧列表里「哪些预设属于当前模型」，它是个快照。
// 曾经这里只刷名单不刷摘要：保存预设后名字进了 presetList，却没进摘要，
// 于是被过滤条件当成「跟当前模型无关」直接不显示 —— 而设置区用的是未过滤的
// presetList，所以那里照样看得见，现象就是「新建的预设只在设置里出现」。
// 把摘要并进来，所有调用点（保存/改名/复制/删除/刷新）自动一起更新。
async function loadPresetList() {
  const list = await window.llamaDesktop.presetList()
  state.presetList = list || []
  await loadPresetSummaries()
}

async function loadEngineList() {
  // 一次调用同时拿「引擎定义（已合并扫描结果）」、「扫到的候选清单」和「推荐哪个」，
  // 避免为了候选再单独扫一遍磁盘。
  const scanned = await window.llamaDesktop.engineRescan?.({
    currentServerPath: state.config?.llama_server_path || '',
    searchDir: state.config?.engine_search_dir || '',
  })
  const engines = scanned?.engines || await window.llamaDesktop.engineList()
  state.engineList = engines || []
  state.engineCandidates = scanned?.candidates || []

  const configured = String(state.config?.llama_server_path || '').trim()
  if (configured) {
    // 用户已经指定过引擎 —— 只识别它是什么，绝不改动。
    state.engine = await window.llamaDesktop.engineDetect(configured)
    return
  }

  // 还没指定过引擎：直接替用户选好，别让他先去弄懂 KVMem 和 llama.cpp 的区别。
  // 主进程按模型类型给推荐（三元 Bonsai → KVMem，其余 → llama.cpp），
  // 且只推荐「真的扫到了」的那个，所以这里不会指到一个用不了的路径。
  const recommended = scanned?.recommended
  if (recommended?.path) {
    state.config = sanitizeEngineParams({
      ...state.config,
      llama_server_path: recommended.path,
      llama_bin_dir: recommended.dir || '',
    })
    state.engine = { engineId: recommended.engineId, engines: state.engineList }
    state.dirty = true
    state.toast = `已自动选用引擎：${engineLabelOf(recommended.engineId)}（可随时手动更改）`
  }
}

async function checkVram() {
  try {
    const vram = await window.llamaDesktop.vramCheck()
    state.vramUsage = vram
    // 阈值判定走 preset-engine 的纯函数，界面与主进程只有一份真相。
    state.vramWarning = vramSnapshot(vram).warning
  } catch (err) {
    console.warn('VRAM check failed:', err)
    state.vramUsage = null
    state.vramWarning = false
  }
}

// 顶栏「模型」菜单的数据源。扫描在磁盘上做，可能慢，所以只在启动、
// 显式点「重新扫描」、以及切换成功后刷新，不做轮询。
async function loadModelList() {
  try {
    const result = await window.llamaDesktop.listModels()
    state.modelList = Array.isArray(result?.models) ? result.models : []
    state.modelListLoaded = true
  } catch (err) {
    console.warn('Model scan failed:', err)
    state.modelList = []
    state.modelListLoaded = true
  }
}

// 预设摘要：用来把「当前配置」反查回「它属于哪个预设」。
async function loadPresetSummaries() {
  try {
    const list = await window.llamaDesktop.presetSummaries?.()
    state.presetSummaries = Array.isArray(list) ? list : []
  } catch (err) {
    console.warn('Preset summaries failed:', err)
    state.presetSummaries = []
  }
}

// 当前模型「有哪些预设可用」。
// 预设摘要由 llama:preset-summaries 提供（每个预设的 name / model / ctxSize / engine），
// 用它把左侧列表收窄到「这个模型真能用的预设」——
// 原先左侧是把全部预设一股脑列出来，选了 mtp-gemma 却看到一堆 Bonsai/Qwen，无从下手。
function presetsForCurrentModel() {
  const all = state.presetList || []
  const summaries = state.presetSummaries || []
  // 「一个预设都没有」与「摘要没取到」是两件事，必须分开：
  //   前者是发布版的正常起点（干净安装不带任何预设），列表就该是空的，
  //   而且必须露出「按硬件生成稳定预设」入口 —— 那正是这个场景最需要的；
  //   后者是取数失败，才退化成「全部列出」，免得把用户的预设藏起来。
  if (!all.length) return { names: [], filtered: true, matched: 0, modelName: currentModelName() }
  if (!summaries.length) return { names: all, filtered: false, matched: all.length }
  const modelName = currentModelName()
  if (!modelName) return { names: all, filtered: false, matched: all.length }
  // 绑定本模型的预设
  const specific = summaries.filter(item => item.model && item.model === modelName).map(item => item.name)
  // 不绑定任何模型的「参数型预设」（例如随包附带的示例）：对哪个模型都能用，所以始终列出
  const generic = summaries.filter(item => !item.model).map(item => item.name)
  // 摘要里查不到的预设一律保留 —— 这里必须「失败即放行」。
  // 摘要是异步快照，可能落后于 presetList（刚保存、刚改名、或用户直接把
  // .config.toml 丢进 configs\ 目录）；把「查不到」当成「不适用」，就等于把
  // 用户自己的预设藏起来，而他只能去设置区看到它，找不到原因。
  // 宁可多列一个不相关的，也不能少列一个属于他的。
  const summarized = new Set(summaries.map(item => item.name))
  const names = all.filter(
    name => !summarized.has(name) || specific.includes(name) || generic.includes(name),
  )
  // matched 只数「专门为这个模型做的预设」—— 它决定要不要露出「按硬件生成」入口，
  // 参数型预设的存在不该把这个入口挤掉。
  return { names, filtered: true, matched: specific.length, modelName }
}

// 加载预设之后，把「到底变了什么」说出来。
//
// 原先加载预设只是替换 state.config，界面上没有任何一句话交代结果。
// 于是当预设的值和当前值本来就相同时（例如随包的参数模板，或你已经调成一样的），
// 用户看到的就是「点了按钮，什么都没发生」，很容易误判成「加载失败 / 界面没同步」。
// 这里把真正变化的字段列出来；一个都没变就明说没有差异。
const PRESET_OUTCOME_FIELDS = [
  ['ctx_size', '上下文'],
  ['n_gpu_layers', 'GPU 层数'],
  ['port', '端口'],
  ['batch_size', 'batch'],
  ['ubatch_size', 'ubatch'],
  ['threads', '线程'],
  ['temp', '温度'],
  ['top_k', 'top_k'],
  ['top_p', 'top_p'],
  ['model', '模型'],
  ['llama_server_path', '引擎路径'],
]

function describePresetOutcome(name, before, after) {
  const changes = []
  // 路径只报末尾两级（`bin\llama-server.exe`），整条路径塞进提示条会挤成一团。
  // 但如果缩完两边一模一样（例如只是换了盘符或上层目录），就必须退回完整值 ——
  // 否则提示会显示成「引擎路径 llama-server.exe → llama-server.exe」，
  // 明明变了却看着像没变，正好和这条提示要解决的问题相反。
  const shorten = value => {
    if (!value.includes('\\') && !value.includes('/')) return value
    const parts = value.split(/[\\/]/).filter(Boolean)
    return parts.length ? parts.slice(-2).join('\\') : value
  }
  const render = value => {
    const text = String(value ?? '')
    if (!text) return '(空)'
    const short = shorten(text)
    return short || text
  }
  for (const [field, label] of PRESET_OUTCOME_FIELDS) {
    const from = String(before?.[field] ?? '')
    const to = String(after?.[field] ?? '')
    if (from === to) continue
    // 缩短后撞在一起了（只差上层目录）→ 两边都退回完整值，保证看得出差别。
    const collapsed = from && to && shorten(from) === shorten(to)
    changes.push(`${label} ${collapsed ? from : render(from)} → ${collapsed ? to : render(to)}`)
  }
  if (!changes.length) return `已加载「${name}」，但它的参数与当前配置完全相同`
  const shown = changes.slice(0, 3).join('、')
  const more = changes.length > 3 ? ` 等 ${changes.length} 项` : ''
  return `已加载「${name}」：${shown}${more}`
}

async function applyPreset(name) {
  if (!name) return
  try {
    const config = await window.llamaDesktop.presetRead(name)
    // 读不到不能静默返回。
    // 这里原来是 if (config) { ... }：读失败时函数一声不响地结束，
    // 用户点了「加载预设」界面上毫无变化，也无从判断是没生效还是自己点错了。
    if (!config) {
      state.toast = '读不到预设「' + name + '」，请确认 configs 目录里这个文件还在'
      render()
      return
    }
    // 外观属于用户偏好，不属于预设：合并时保留当前值，
    // 否则预设里残留的 theme_mode 会把界面外观改掉。
    // 路径类字段留空 = 沿用当前（见 applyPresetOverCurrent 的注释）：
    // 否则一个不含模型路径的示例预设会把用户已配好的路径清空。
    const beforeConfig = state.config
    state.config = sanitizeEngineParams(
      preserveUiPreferences(state.config, applyPresetOverCurrent(state.config, config)),
    )
    state.preset = name
    state.presetPreview = name
    state.dirty = true
    // 必须在 loadPresetMetadata 之前设好：它内部会 render()，提示要跟着那一帧显示出来。
    state.toast = describePresetOutcome(name, beforeConfig, state.config)
    await refreshEngineForConfig()
    await loadPresetMetadata(name)
  } catch (err) {
    console.error('Failed to load preset:', err)
    state.toast = '加载预设失败: ' + err.message
    // 出错也要重绘，否则 toast 根本没机会显示出来。
    render()
  }
}

// ============================================================
// 预设管理：另存 / 重命名 / 复制 / 删除 / 刷新
//
// 这里刻意不再使用 window.prompt()：Electron 不支持它，调用会抛
// "prompt() is not supported."，原实现因此点「保存当前为预设」完全没反应。
// 统一改成应用内对话框(复用 .history-dialog 样式)。
// ============================================================

const PRESET_DIALOG_COPY = {
  save: { title: '另存为新预设', hint: '把当前表单里的全部参数存成一份独立预设文件。', confirm: '保存' },
  rename: { title: '重命名预设', hint: '只改文件名，文件内容原样保留。', confirm: '重命名' },
  duplicate: { title: '复制预设', hint: '以选中的预设为模板，另存为一份新预设。', confirm: '复制' },
  delete: { title: '删除预设', hint: '会删除磁盘上的预设文件，无法撤销。', confirm: '删除' },
}

function selectedPresetName() {
  return document.getElementById('presetSelect')?.value || ''
}

// 命名规则与重名判定在 renderer/lib/preset-naming.js（纯函数，可单测）。
function currentPresetNameIssue(name, dialog) {
  return presetNameIssue(name, dialog, state.presetList || [])
}

function openPresetDialog(type, nameOverride = '') {
  const current = selectedPresetName()
  if (type !== 'save' && !current) {
    state.toast = '先在下拉框里选中一个预设'
    render()
    return
  }
  const suggested = nameOverride || (type === 'save'
    ? (state.preset || presetNameFromConfig(state.config))
    : (type === 'rename' ? current : current + '-副本'))
  state.presetDialog = { type, name: suggested, target: current, error: '', confirmOverwrite: false }
  render()
  setTimeout(() => {
    const input = document.querySelector('[data-preset-name-input]')
    input?.focus()
    input?.select()
  }, 0)
}

function closePresetDialog() {
  state.presetDialog = null
  render()
}

function presetDialogError(message) {
  state.presetDialog = { ...state.presetDialog, error: message }
  render()
}

async function submitPresetDialog() {
  const dialog = state.presetDialog
  if (!dialog) return

  if (dialog.type === 'delete') {
    try {
      await window.llamaDesktop.presetDelete(dialog.target)
      if (state.preset === dialog.target) state.preset = null
      if (state.presetPreview === dialog.target) state.presetPreview = null
      state.presetDialog = null
      await loadPresetList()
      state.toast = '预设「' + dialog.target + '」已删除'
      render()
    } catch (err) {
      presetDialogError('删除失败：' + err.message)
    }
    return
  }

  const input = document.querySelector('[data-preset-name-input]')
  const name = String(input ? input.value : dialog.name || '').trim()
  const issue = currentPresetNameIssue(name, dialog)

  if (issue) {
    if (issue.startsWith('EXISTS:')) {
      const existing = issue.slice(7)
      if (!dialog.confirmOverwrite) {
        state.presetDialog = {
          ...dialog,
          name,
          error: '已存在同名预设「' + existing + '」，再点一次「' + PRESET_DIALOG_COPY[dialog.type].confirm + '」即覆盖',
          confirmOverwrite: true,
        }
        render()
        return
      }
    } else {
      state.presetDialog = { ...dialog, name, error: issue, confirmOverwrite: false }
      render()
      setTimeout(() => document.querySelector('[data-preset-name-input]')?.focus(), 0)
      return
    }
  }

  try {
    if (dialog.type === 'save') {
      await window.llamaDesktop.presetWrite({ name, config: stripUiPreferences(state.config) })
      state.preset = name
      state.presetPreview = name
    } else {
      const config = await window.llamaDesktop.presetRead(dialog.target)
      if (!config) throw new Error('读不到「' + dialog.target + '」')
      await window.llamaDesktop.presetWrite({ name, config })
      if (dialog.type === 'rename' && name !== dialog.target) {
        await window.llamaDesktop.presetDelete(dialog.target)
        if (state.preset === dialog.target) state.preset = name
      }
      if (dialog.type === 'duplicate') state.presetPreview = name
    }
  } catch (err) {
    presetDialogError('写入失败：' + err.message)
    return
  }

  state.presetDialog = null
  await loadPresetList()
  state.toast = dialog.type === 'rename'
    ? '预设已重命名为「' + name + '」'
    : '预设「' + name + '」已保存'
  render()
}

async function refreshPresetList() {
  try {
    await loadPresetList()
    state.toast = '已刷新，共 ' + (state.presetList || []).length + ' 个预设'
  } catch (err) {
    state.toast = '刷新失败：' + err.message
  }
  render()
}

// 显存拦截弹窗（验收 #9）
// 按本机硬件为「当前模型」算一份稳定预设，并把过程摊开给用户看。
// 只读不算写入：算完由用户决定是「应用到当前配置」还是「存成预设」。
async function openStablePresetDialog() {
  state.stablePreset = { loading: true }
  render({ preserveChatScroll: true })
  try {
    const result = await window.llamaDesktop.stablePreset({ config: state.config })
    state.stablePreset = result?.ok ? { result } : { error: result?.error || '计算失败' }
  } catch (error) {
    state.stablePreset = { error: readableError(error) }
  }
  render({ preserveChatScroll: true })
}

// 把建议合并进当前配置（只改建议里给出的字段，其余保持用户现有设置）
function applyStablePreset() {
  const result = state.stablePreset?.result
  if (!result) return
  state.config = { ...state.config, ...result.proposal.patch }
  state.dirty = true
  state.stablePreset = null
  setToast('已按本机硬件应用稳定参数，保存后生效')
}

function renderStablePresetDialog() {
  const box = state.stablePreset
  if (!box) return ''
  const close = '<div class="dialog-backdrop" data-action="close-stable-preset"></div>'

  if (box.loading) {
    return `${close}
      <section class="history-dialog stable-preset">
        <h2>按本机硬件生成稳定预设</h2>
        <p>正在读模型头部信息与显卡读数…</p>
      </section>`
  }
  if (box.error) {
    return `${close}
      <section class="history-dialog stable-preset">
        <h2>按本机硬件生成稳定预设</h2>
        <p class="stable-preset-error">${escapeHtml(box.error)}</p>
        <div class="dialog-actions">
          <button type="button" class="outline-btn" data-action="close-stable-preset">关闭</button>
        </div>
      </section>`
  }

  const { proposal, gguf, hardware, modelName, suggestedName, engineLabel } = box.result
  const s = proposal.summary
  const offloadText = s.offloadAll
    ? `全部 ${s.blockCount || '?'} 层`
    : `${s.gpuLayers}/${s.blockCount || '?'} 层上 GPU，其余走 CPU`

  return `${close}
    <section class="history-dialog stable-preset">
      <h2>按本机硬件生成稳定预设</h2>
      <p class="stable-preset-target">目标模型：<strong>${escapeHtml(modelName)}</strong></p>

      <div class="stable-preset-summary">
        <div><span>上下文</span><strong>${s.ctxSize}</strong></div>
        <div><span>GPU 层数</span><strong>${offloadText}</strong></div>
        <div><span>线程</span><strong>${proposal.patch.threads || '自动'}</strong></div>
        <div><span>KV 缓存</span><strong>${escapeHtml(s.kvType)}</strong></div>
        <!-- 引擎是从当前配置继承的，这份预设不会改它；写出来免得用户以为会自动挑引擎 -->
        <div><span>引擎</span><strong>${escapeHtml(engineLabel || '当前引擎')}</strong></div>
      </div>

      ${proposal.warnings.length
        ? `<ul class="stable-preset-warnings">${proposal.warnings.map(w => `<li>${escapeHtml(w)}</li>`).join('')}</ul>`
        : ''}

      <details class="stable-preset-why">
        <summary>为什么是这些值（${proposal.steps.length} 条依据）</summary>
        <ul>${proposal.steps.map(st => `<li>${escapeHtml(st)}</li>`).join('')}</ul>
        <p class="stable-preset-note">信息来自模型自己的 GGUF 头部与本机显卡读数，不是按文件名猜的。
          ${gguf.ok ? '' : '<br>这个模型的头部没读全，结果偏保守，可能要手工再调。'}</p>
      </details>

      <p class="stable-preset-hint">这份参数只求「一定能起来」。跑通之后再慢慢加大上下文或 GPU 层数。</p>

      <div class="dialog-actions">
        <button type="button" class="outline-btn" data-action="close-stable-preset">取消</button>
        <button type="button" class="outline-btn" data-action="apply-stable-preset">应用到当前配置</button>
        <button type="button" class="danger-solid-btn" data-action="apply-save-stable-preset">应用并保存为「${escapeHtml(suggestedName)}」</button>
      </div>
    </section>`
}

function renderVramGuardDialog() {
  const guard = state.vramGuard
  if (!guard) return ''
  const available = Math.round(Number(guard.available) || 0)
  const total = Math.round(Number(guard.total) || 0)
  return `
    <div class="dialog-backdrop" data-action="vram-guard-cancel"></div>
    <section class="history-dialog vram-guard">
      <h2>显存不足，仍要启动吗？</h2>
      <p>当前可用显存 <strong>${available} MiB</strong> / 共 ${total} MiB，低于 ${VRAM_WARN_THRESHOLD_MIB} MiB 警戒线。
         此时启动很可能直接 OOM，或长时间卡在加载模型上。</p>
      <p class="vram-guard-hint">建议先关掉占显存的程序，或换小模型 / 降低 ctx_size 再试。</p>
      <div class="dialog-actions">
        <button type="button" class="outline-btn" data-action="vram-guard-cancel">取消</button>
        <button type="button" class="danger-solid-btn" data-action="vram-guard-confirm">仍然启动</button>
      </div>
    </section>
  `
}

function renderPresetDialog() {
  const dialog = state.presetDialog
  if (!dialog) return ''
  const copy = PRESET_DIALOG_COPY[dialog.type] || PRESET_DIALOG_COPY.save
  const body = dialog.type === 'delete'
    ? '<p>确定删除预设「' + escapeHtml(dialog.target) + '」吗？该文件会从磁盘移除。</p>'
    : `<input data-preset-name-input value="${escapeAttribute(dialog.name || '')}" placeholder="预设名称" />
       <p class="${dialog.error ? 'preset-dialog-error' : ''}">${escapeHtml(dialog.error || copy.hint)}</p>`
  return `
    <div class="dialog-backdrop" data-action="preset-dialog-close"></div>
    <section class="history-dialog preset-dialog">
      <h2>${escapeHtml(copy.title)}</h2>
      ${body}
      <div class="dialog-actions">
        <button type="button" class="outline-btn" data-action="preset-dialog-close">取消</button>
        <button type="button" class="${dialog.type === 'delete' ? 'danger-solid-btn' : 'primary-btn'}" data-action="preset-dialog-confirm">${escapeHtml(copy.confirm)}</button>
      </div>
    </section>
  `
}

// ============================================================
// 预设参数编辑窗口
//
// 按「预设」维度编辑全部可调参数（而不是只改全局配置页），
// 保存时写回该预设自己的 .config.toml。引擎不支持的开关在这里也会置灰。
// ============================================================

const PRESET_EDITOR_GROUPS = [
  {
    title: '模型与引擎',
    hint: '决定这套预设使用哪个模型与哪个引擎。',
    fields: [
      { name: 'model', label: '模型文件', type: 'text', pick: 'gguf', hint: '选择 .gguf 模型文件。' },
      { name: 'mmproj', label: 'mmproj（多模态投影）', type: 'text', pick: 'gguf', hint: '纯文本模型留空。' },
      { name: 'llama_server_path', label: 'llama-server 可执行文件', type: 'text', pick: 'exe', hint: '切换引擎就改这里。' },
      { name: 'llama_bin_dir', label: 'llama.cpp 原文件目录', type: 'text', hint: '留空则自动推断。' },
    ],
  },
  {
    title: '服务与上下文',
    fields: [
      { name: 'host', label: 'Host', type: 'text' },
      { name: 'port', label: 'Port', type: 'number', min: 1, max: 65535, hint: 'KVMem 预设用 18200，llama.cpp 用 8080，避免抢端口。' },
      { name: 'ctx_size', label: '上下文大小 ctx_size', type: 'number', min: 512, hint: '越大越吃显存；超过 65536 会显著增加内存占用。' },
      { name: 'n_predict', label: '最大输出 n_predict', type: 'number', hint: '-1 表示不限制。' },
      { name: 'request_timeout_ms', label: '请求超时（毫秒）', type: 'number', min: 1000 },
    ],
  },
  {
    title: '显存与性能',
    fields: [
      { name: 'n_gpu_layers', label: 'GPU 层数', type: 'number', min: 0, hint: '99 = 尽量全部放 GPU。' },
      { name: 'threads', label: '线程数', type: 'number', min: 1, hint: '留空 = 自动。' },
      { name: 'threads_batch', label: '批处理线程数', type: 'number', min: 1 },
      { name: 'batch_size', label: 'batch size', type: 'number', min: 1 },
      { name: 'ubatch_size', label: 'ubatch size', type: 'number', min: 1 },
      { name: 'cpu_moe', label: 'MoE 卸载到 CPU', type: 'checkbox', engineBlocked: true },
      { name: 'n_cpu_moe', label: 'MoE 放 CPU 的层数', type: 'number', min: 0, engineBlocked: true },
      { name: 'device', label: 'device', type: 'text' },
      { name: 'split_mode', label: 'split mode', type: 'text' },
      { name: 'tensor_split', label: 'tensor split', type: 'text' },
      { name: 'main_gpu', label: 'main gpu', type: 'number', min: 0 },
    ],
  },
  {
    title: '采样',
    fields: [
      { name: 'temp', label: '温度 temp', type: 'number', step: '0.01' },
      { name: 'top_k', label: 'Top-K', type: 'number', min: 0 },
      { name: 'top_p', label: 'Top-P', type: 'number', step: '0.01' },
      { name: 'min_p', label: 'Min-P', type: 'number', step: '0.01' },
      { name: 'presence_penalty', label: '存在惩罚', type: 'number', step: '0.01' },
      { name: 'repeat_penalty', label: '重复惩罚', type: 'number', step: '0.01' },
    ],
  },
  {
    title: '运行开关',
    fields: [
      { name: 'webui', label: 'WebUI', type: 'checkbox' },
      { name: 'show_thinking', label: '显示思考', type: 'checkbox' },
      { name: 'expand_thinking', label: '默认展开思考', type: 'checkbox' },
      { name: 'show_raw_output', label: '显示原始输出', type: 'checkbox' },
      { name: 'verbose', label: 'Verbose', type: 'checkbox' },
      { name: 'log_verbosity', label: '日志级别', type: 'text' },
      { name: 'embeddings', label: 'Embeddings', type: 'checkbox', engineBlocked: true },
      { name: 'continuous_batching', label: 'Continuous batching', type: 'checkbox', engineBlocked: true },
    ],
  },
  {
    title: '其它',
    fields: [
      { name: 'extra_args', label: '追加参数 extra_args', type: 'textarea', hint: '例如 -ctk q4_0 -ctv q4_0 -fa on。会追加到启动命令末尾。' },
    ],
  },
]

function openPresetEditor() {
  const name = selectedPresetName()
  if (!name) {
    state.toast = '先在下拉框里选中一个预设'
    render()
    return
  }
  window.llamaDesktop.presetRead(name)
    .then(config => {
      if (!config) {
        state.toast = '读不到预设「' + name + '」'
        render()
        return
      }
      state.presetEditorName = name
      state.presetDraft = { ...config }
      state.presetEditorDirty = false
      render()
    })
    .catch(err => {
      state.toast = '打开编辑器失败：' + err.message
      render()
    })
}

function closePresetEditor() {
  state.presetDraft = null
  state.presetEditorName = null
  state.presetEditorDirty = false
  render()
}

// 输入时只改草稿、不重渲染 —— 重渲染会让输入框失去焦点。
function updatePresetDraftField(element) {
  if (!state.presetDraft) return
  const name = element.dataset.presetField
  const kind = element.dataset.presetKind
  let value
  if (kind === 'boolean') value = !!element.checked
  else if (kind === 'number') value = element.value === '' ? '' : Number(element.value)
  else value = element.value
  state.presetDraft = { ...state.presetDraft, [name]: value }
  state.presetEditorDirty = true
  const status = document.querySelector('.preset-editor-status')
  if (status) status.textContent = '有未保存的修改'
}

async function presetEditorPick(name, kind) {
  if (!state.presetDraft) return
  const filters = {
    exe: [{ name: 'Executable', extensions: ['exe', 'cmd', 'bat'] }, { name: 'All Files', extensions: ['*'] }],
    gguf: [{ name: 'GGUF', extensions: ['gguf'] }, { name: 'All Files', extensions: ['*'] }],
  }[kind] || [{ name: 'All Files', extensions: ['*'] }]
  const selected = await window.llamaDesktop.pickFile(kind === 'dir' ? { properties: ['openDirectory'] } : filters)
  if (!selected) return
  const next = { ...state.presetDraft, [name]: selected }
  if (name === 'llama_bin_dir') {
    next.llama_server_path = selected.replace(/[\\/]+$/, '') + '\\llama-server.exe'
  }
  state.presetDraft = next
  state.presetEditorDirty = true
  render()
}

async function savePresetDraft() {
  if (!state.presetDraft || !state.presetEditorName) return
  const name = state.presetEditorName
  try {
    // 与主进程同一套兜底：引擎不支持的开关直接关掉，保证存出来的预设一定能启动。
    await window.llamaDesktop.presetWrite({ name, config: stripUiPreferences(sanitizeEngineParams(state.presetDraft)) })
    state.presetDraft = null
    state.presetEditorName = null
    state.presetEditorDirty = false
    await loadPresetList()
    state.presetPreview = name
    if (state.preset === name || !state.preset) await loadPresetMetadata(name)
    state.toast = '预设「' + name + '」的参数已保存'
  } catch (err) {
    state.toast = '保存失败：' + err.message
  }
  render()
}

function renderPresetEditorField(f, draft, blocked) {
  const isBlocked = !!f.engineBlocked && blocked.includes(f.name)
  const value = draft[f.name]
  const hint = isBlocked ? '当前引擎不支持，保存时会强制关闭。' : (f.hint || '')
  const hintHtml = hint ? `<div class="hint">${escapeHtml(hint)}</div>` : ''

  if (f.type === 'checkbox') {
    return `
      <label class="switch preset-editor-switch ${isBlocked ? 'is-disabled' : ''}">
        <span>
          <strong>${escapeHtml(f.label)}</strong>
          <em>${escapeHtml(hint)}</em>
        </span>
        <input data-preset-field="${f.name}" data-preset-kind="boolean" type="checkbox" ${value && !isBlocked ? 'checked' : ''} ${isBlocked ? 'disabled' : ''} />
      </label>
    `
  }

  if (f.type === 'textarea') {
    return `
      <label class="field preset-editor-wide">
        <span>${escapeHtml(f.label)}</span>
        <textarea data-preset-field="${f.name}" data-preset-kind="string" spellcheck="false">${escapeHtml(value ?? '')}</textarea>
        ${hintHtml}
      </label>
    `
  }

  const isNumber = f.type === 'number'
  const attrs = [
    f.min !== undefined ? `min="${f.min}"` : '',
    f.max !== undefined ? `max="${f.max}"` : '',
    f.step !== undefined ? `step="${f.step}"` : '',
    isBlocked ? 'disabled' : '',
  ].filter(Boolean).join(' ')
  const picker = f.pick
    ? `<button class="icon-btn text-btn" type="button" data-preset-pick="${f.name}" data-kind="${f.pick}">选择</button>`
    : ''

  return `
    <label class="field">
      <span>${escapeHtml(f.label)}</span>
      <div class="${picker ? 'field-row' : ''}">
        <input data-preset-field="${f.name}" data-preset-kind="${isNumber ? 'number' : 'string'}" type="${isNumber ? 'number' : 'text'}" value="${escapeAttribute(value ?? '')}" ${attrs} />
        ${picker}
      </div>
      ${hintHtml}
    </label>
  `
}

function renderPresetEditor() {
  const draft = state.presetDraft
  if (!draft) return ''
  const blocked = engineIncompatibleConfigKeys(detectEngineByPath(draft.llama_server_path))
  const groups = PRESET_EDITOR_GROUPS.map(group => `
    <div class="preset-editor-group">
      <h3>${escapeHtml(group.title)}</h3>
      ${group.hint ? `<p class="preset-editor-group-hint">${escapeHtml(group.hint)}</p>` : ''}
      <div class="preset-editor-grid">
        ${group.fields.map(f => renderPresetEditorField(f, draft, blocked)).join('')}
      </div>
    </div>
  `).join('')
  const count = PRESET_EDITOR_GROUPS.reduce((total, group) => total + group.fields.length, 0)
  return `
    <div class="dialog-backdrop" data-action="preset-editor-close"></div>
    <section class="history-dialog preset-editor">
      <h2>编辑预设参数：${escapeHtml(state.presetEditorName || '')}</h2>
      <p class="preset-editor-sub">共 ${count} 项可调参数，分 ${PRESET_EDITOR_GROUPS.length} 组。保存后写回该预设自己的 .config.toml。</p>
      <div class="preset-editor-body">${groups}</div>
      <div class="dialog-actions">
        <span class="preset-editor-status">${state.presetEditorDirty ? '有未保存的修改' : '尚未修改'}</span>
        <button type="button" class="outline-btn" data-action="preset-editor-close">取消</button>
        <button type="button" class="primary-btn" data-action="preset-editor-save">保存到预设</button>
      </div>
    </section>
  `
}

function presetNameFromConfig(config) {
  if (!config) return '未知'
  // Extract a friendly name from model + engine
  const model = config.model || ''
  const modelName = model ? model.replace(/\.[^.]+$/, '').slice(-10) : '未命名'
  // 三引擎都要认：旧写法只判 kvmem，PrismML 会被显示成 llama.cpp。
  const engineId = state.engine?.engineId || detectEngineByPath(config.llama_server_path)
  return modelName + ' (' + getEngineLabel(engineId) + ')'
}

// 依据当前 llama_server_path 重新识别引擎，供「加载预设 / 切换引擎」后刷新徽章。
async function refreshEngineForConfig() {
  if (!state.config?.llama_server_path) return
  try {
    state.engine = await window.llamaDesktop.engineDetect(state.config.llama_server_path)
  } catch (error) {
    console.error('Engine detect failed:', error)
  }
}

async function updateEngineByServerPath() {
  await refreshEngineForConfig()
  render()
}

// 读取某个预设的元信息（上下文、端口、采样参数等），用于详情面板。
async function loadPresetMetadata(name) {
  if (!name) {
    state.presetMeta = null
    render()
    return
  }
  try {
    state.presetMeta = await window.llamaDesktop.presetMetadata({ name })
  } catch (error) {
    console.error('Failed to load preset metadata:', error)
    state.presetMeta = null
  }
  render()
}

// 下拉框只做「预览」：不改动「当前已加载预设」，否则仅仅浏览就会谎报已加载。
function handlePresetSelect() {
  const name = document.getElementById('presetSelect')?.value || ''
  state.presetPreview = name || null
  loadPresetMetadata(name)
}

function renderEngineSelector() {
  const engines = state.engineList || []
  if (!engines.length) return ''
  const currentId = state.engine?.engineId || 'llama-cpp'
  const currentPath = String(state.config?.llama_server_path || '')
  const options = engines
    .map(engine => {
      const selected = engine.id === currentId ? ' selected' : ''
      const disabled = engine.path ? '' : ' disabled'
      const suffix = engine.path ? '' : '（未找到）'
      return `<option value="${escapeAttribute(engine.id)}"${selected}${disabled}>${escapeHtml(engine.label + suffix)}</option>`
    })
    .join('')
  const current = engines.find(engine => engine.id === currentId)

  // 面向普通使用者：先给一句「现在用的是哪个」，别让人从路径里猜。
  const statusLine = currentPath
    ? `<div class="engine-status">当前：<strong>${escapeHtml(engineLabelOf(currentId))}</strong>${current?.desc ? ` · ${escapeHtml(current.desc)}` : ''}</div>`
    : `<div class="engine-status">还没指定引擎。点下面的按钮选一个，或让软件自动找。</div>`

  // 扫描结果：**名称在前**，路径只作为悬停提示。
  // 同一个引擎有多份构建时才补一句上级目录名（那才是用户能分辨的信息，
  // 整条绝对路径对普通使用者没有意义）。
  const candidates = (state.engineCandidates || []).slice(0, 8)
  const sameEngineCount = candidates.reduce((acc, c) => {
    acc[c.engineId] = (acc[c.engineId] || 0) + 1
    return acc
  }, {})
  const candidateList = candidates.length
    ? `
      <div class="engine-found">
        <div class="engine-found-title">找到了这些引擎，点一下就能用</div>
        ${candidates.map(candidate => {
          const parent = String(candidate.dir || '').split(/[\\/]/).filter(Boolean).pop() || ''
          const needDisambiguate = sameEngineCount[candidate.engineId] > 1
          return `
          <button type="button" class="engine-found-item${candidate.path === currentPath ? ' on' : ''}"
                  data-action="engine-pick" data-engine-path="${escapeAttribute(candidate.path)}" data-engine-id="${escapeAttribute(candidate.engineId)}"
                  title="${escapeAttribute(candidate.path)}">
            <span class="engine-found-name">${escapeHtml(engineLabelOf(candidate.engineId))}</span>
            ${needDisambiguate ? `<span class="engine-found-where">${escapeHtml(parent)}</span>` : ''}
          </button>`
        }).join('')}
      </div>`
    : ''

  // 一个都没找到时，才对普通用户提「告诉我你把它放在哪」——
  // 平时不必让这些字占地方（渐进披露）。
  const notFoundHelp = candidates.length
    ? ''
    : `
      <div class="engine-empty">
        <div>没找到引擎。告诉我你把它放在哪个文件夹，我就能自己找出其余的：</div>
        <div class="engine-empty-actions">
          <button class="btn btn-primary" type="button" data-action="engine-pick-dir">选择引擎文件夹…</button>
          <button class="btn btn-secondary" type="button" data-action="engine-browse">或直接选中那个文件</button>
        </div>
      </div>`

  return `
    <div class="preset-engine-row">
      <span class="preset-engine-label">引擎</span>
      <select id="engineSelect" class="preset-select">${options}</select>
      <button id="switchEngineBtn" class="btn btn-primary" type="button" data-action="engine-switch">切换</button>
      <button class="btn btn-secondary" type="button" data-action="engine-rescan">自动查找</button>
    </div>
    ${statusLine}
    ${candidateList}
    ${notFoundHelp}
  `
}

function engineLabelOf(engineId) {
  const hit = (state.engineList || []).find(engine => engine.id === engineId)
  return hit?.label || engineId
}

// 把选中的引擎可执行文件写回配置。
// 手动选择和「点扫描结果」走同一条路径，避免两处逻辑走偏。
async function applyEngineBinary(fullPath, source = '扫到的', knownEngineId = '') {
  const target = String(fullPath || '').trim()
  if (!target) return
  const binDir = target.split(/[\\/]/).slice(0, -1).join('\\')
  // 引擎类型只由主进程判定（detectEngineByPath 是唯一真相）。
  // 渲染进程是普通脚本、不能 import 那个模块，所以**不复制**这套规则 ——
  // 复制就会漂移，扫描结果里已经带好了 engineId，手动选择时问一次主进程。
  let engineId = String(knownEngineId || '').trim()
  if (!engineId) {
    try {
      engineId = (await window.llamaDesktop.engineDetect(target))?.engineId || 'llama-cpp'
    } catch {
      engineId = 'llama-cpp'
    }
  }
  state.config = sanitizeEngineParams({ ...state.config, llama_server_path: target, llama_bin_dir: binDir })
  state.engine = { engineId, engines: state.engineList }
  state.dirty = true
  state.toast = `已${source === '手动' ? '手动指定' : '选用'}引擎：${engineLabelOf(engineId)}`
  render()
}

// 重新扫描：用户把引擎挪了位置、或新解压了一份之后点一下。
async function rescanEngines() {
  try {
    const result = await window.llamaDesktop.engineRescan?.({
      currentServerPath: state.config?.llama_server_path || '',
      searchDir: state.config?.engine_search_dir || '',
    })
    if (result) {
      state.engineList = result.engines || state.engineList
      state.engineCandidates = result.candidates || []
    }
    const count = (state.engineCandidates || []).length
    state.toast = count
      ? `找到 ${count} 个引擎`
      : '没找到引擎。点「选择引擎文件夹…」告诉我你把它放在哪，我就能自己找出其余的'
  } catch (error) {
    state.toast = '查找引擎失败：' + (error?.message || error)
  }
  render()
}

// 让用户指一个文件夹（「我放 llama.cpp 的地方」）。
//
// 这是对新用户最关键的一步：他们的引擎可能在任意盘、任意层级，
// 靠猜是猜不到的；但只要指一次，同级目录下的其他引擎就能自动找齐。
// 指过的位置会存进配置，下次启动就不用再指。
async function pickEngineFolder() {
  try {
    const selected = await window.llamaDesktop.pickFile({ properties: ['openDirectory'] })
    if (!selected) return
    state.config = { ...state.config, engine_search_dir: selected }
    state.dirty = true
    await rescanEngines()
    if (!(state.engineCandidates || []).length) {
      state.toast = '这个文件夹里没找到引擎。可以再选上一层，或点「手动指定…」直接选中那个 exe'
      render()
    }
  } catch (error) {
    state.toast = '选择文件夹失败：' + (error?.message || error)
    render()
  }
}

// 手动选择引擎可执行文件 —— 扫描没覆盖到的位置靠它兜底。
async function browseEngineBinary() {
  try {
    const selected = await window.llamaDesktop.pickFile({
      properties: ['openFile'],
      filters: [{ name: '引擎可执行文件', extensions: ['exe'] }],
    })
    if (selected) await applyEngineBinary(selected, '手动')
  } catch (error) {
    state.toast = '选择引擎失败：' + (error?.message || error)
    render()
  }
}

function handleSwitchEngine() {
  const select = document.getElementById('engineSelect')
  const engineId = select?.value
  if (!engineId) return
  const engine = (state.engineList || []).find(item => item.id === engineId)
  if (!engine) return
  if (!engine.path) {
    state.toast = `引擎 ${engine.label} 未安装，无法切换`
    render()
    return
  }
  const binDir = engine.path.split(/[\\/]/).slice(0, -1).join('\\')
  // 切到 KVMem 这类引擎时，把不支持的开关关掉，否则启动会被自己的校验拦下。
  state.config = sanitizeEngineParams({ ...state.config, llama_server_path: engine.path, llama_bin_dir: binDir })
  state.engine = { engineId, engines: state.engineList }
  state.dirty = true
  state.toast = `已切换到 ${engine.label}`
  render()
}

function renderPresetMeta(meta) {
  if (!meta) return ''
  const rows = [
    ['模型', meta.model || '未设置'],
    ['类型', meta.modelType],
    ['引擎', meta.engine],
    ['上下文', String(meta.ctxSize)],
    ['端口', String(meta.port)],
    ['温度', String(meta.temp)],
    ['Top-K', String(meta.topK)],
    ['Top-P', String(meta.topP)],
    ['GPU 层', String(meta.nGpuLayers)],
    ['线程', meta.threads ? String(meta.threads) : '自动'],
  ]
  return `
    <div class="preset-meta">
      <div class="preset-meta-title">预设详情</div>
      <div class="preset-meta-grid">
        ${rows
          .map(
            ([label, value]) =>
              `<div class="preset-meta-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`,
          )
          .join('')}
      </div>
    </div>
  `
}


function isNearBottom(element) {
  if (!element) return true
  return element.scrollHeight - element.scrollTop - element.clientHeight < 96
}

function currentSettingsTabId() {
  return settingsTabs.some(([id]) => id === state.active) ? state.active : 'overview'
}

function currentSettingsTabMeta() {
  return settingsTabs.find(([id]) => id === currentSettingsTabId()) || settingsTabs[0]
}

function effectiveThemeMode() {
  // 默认浅色：与主进程保持一致，且不再走 prefers-color-scheme。
  const mode = state.config?.theme_mode || 'light'
  if (mode === 'light' || mode === 'dark') return mode
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

function applyAppearancePreferences() {
  const theme = effectiveThemeMode()
  const font = state.config?.chat_font || 'default'
  document.body.classList.toggle('theme-dark', theme === 'dark')
  document.body.classList.toggle('theme-light', theme !== 'dark')
  document.body.classList.toggle('font-sans', font === 'sans')
  document.body.classList.toggle('font-system', font === 'system')
  document.body.classList.toggle('font-readable', font === 'readable')
  document.body.dataset.themeMode = state.config?.theme_mode || 'light'
  document.body.dataset.chatFont = font
  // 系统窗口控件（titleBarOverlay）是独立于页面的一层，必须显式同步配色，
  // 否则切到深色后右上角仍是浅色一坨。
  window.llamaDesktop?.setTitleBarTheme?.({
    dark: theme === 'dark',
    light: { color: '#f5f5f5', symbolColor: '#0a0a0a' },
    darkColors: { color: '#111111', symbolColor: '#f0f0f0' },
  })
}

function openSettingsSection(section = 'overview') {
  state.active = settingsTabs.some(([id]) => id === section) ? section : 'overview'
  state.settingsOpen = true
  state.firstRunWizardOpen = false
  state.attachmentMenuOpen = false
  state.attachmentMenuPosition = null
}

function thinkingMessageKey(message, messageIndex) {
  return `${message?.createdAt || 'message'}:${messageIndex}`
}

function renderCopyIcon() {
  return `
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <rect x="5" y="3" width="8" height="10" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"></rect>
      <rect x="2" y="6" width="8" height="8" rx="2" fill="none" stroke="currentColor" stroke-width="1.4"></rect>
    </svg>
  `
}

function renderModelChipIcon() {
  return `
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M8 1.4 13.2 4v8L8 14.6 2.8 12V4L8 1.4Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"></path>
      <path d="M8 1.8V6.1m0 0 5.1-2.1M8 6.1 2.9 4" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"></path>
    </svg>
  `
}

function renderSidebarToggleIcon() {
  return `
    <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <rect x="3" y="3.25" width="12" height="11.5" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.5"></rect>
      <path d="M7 3.75v10.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
    </svg>
  `
}

function renderGearIcon() {
  return `
    <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
      <path d="m9 2.7 1 .3.5 1.4 1.3.5 1.2-.7.8.7-.7 1.2.5 1.3 1.4.5.3 1-.3 1-1.4.5-.5 1.3.7 1.2-.8.7-1.2-.7-1.3.5-.5 1.4-1 .3-1-.3-.5-1.4-1.3-.5-1.2.7-.8-.7.7-1.2-.5-1.3-1.4-.5-.3-1 .3-1 1.4-.5.5-1.3-.7-1.2.8-.7 1.2.7 1.3-.5.5-1.4 1-.3Z" fill="none" stroke="currentColor" stroke-width="1.15" stroke-linejoin="round"></path>
      <circle cx="9" cy="9" r="2.25" fill="none" stroke="currentColor" stroke-width="1.4"></circle>
    </svg>
  `
}

function renderSettingsTabIcon(kind) {
  const icons = {
    overview: `
      <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <circle cx="9" cy="9" r="5.6" fill="none" stroke="currentColor" stroke-width="1.5"></circle>
        <path d="M9 5.2v3.9l2.4 1.7" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
    `,
    rescue: `
      <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <path d="M9 2.7 14 4.6v3.9c0 3.2-1.9 5.6-5 6.8-3.1-1.2-5-3.6-5-6.8V4.6L9 2.7Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path>
        <path d="M6.4 9.1h5.2M9 6.5v5.2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
      </svg>
    `,
    display: `
      <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <rect x="2.6" y="3.4" width="12.8" height="9.2" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"></rect>
        <path d="M6.2 14.7h5.6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
      </svg>
    `,
    developer: `
      <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <path d="m7.2 5.4-3 3.6 3 3.6M10.8 5.4l3 3.6-3 3.6M9.9 4.6 8.1 13.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
    `,
    appearance: `
      <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <path d="M9 2.6a6.4 6.4 0 1 0 0 12.8 5.1 5.1 0 0 1 0-12.8Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path>
        <path d="M9 2.6v12.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
      </svg>
    `,
    presets: `
      <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <path d="M9 2.9 15 6l-6 3.1L3 6l6-3.1Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"></path>
        <path d="M3 9.2 9 12.3l6-3.1M3 12.2 9 15.3l6-3.1" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
      </svg>
    `,
    logs: `
      <svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">
        <rect x="3.2" y="2.8" width="11.6" height="12.4" rx="2" fill="none" stroke="currentColor" stroke-width="1.5"></rect>
        <path d="M6 6.4h6M6 9h6M6 11.6h4.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"></path>
      </svg>
    `,
  }

  return icons[kind] || icons.overview
}

function buildBetterModelInfoRows(info) {
  const config = state.config || {}
  const filePath = info?.filePath || config.model || ''
  const fileName = info?.name || basename(filePath) || '未选择模型'
  const formatCount = value => {
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0) return '未读取'
    return number.toLocaleString('zh-CN')
  }
  const formatTokens = value => {
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0) return '未读取'
    return `${number.toLocaleString('zh-CN')} 个代币`
  }
  const formatParams = value => {
    const number = Number(value)
    if (!Number.isFinite(number) || number <= 0) {
      return info?.parameterLabel || info?.parameterScale || paramScaleFromName(fileName) || '未读取'
    }
    if (number >= 100000000) return `${(number / 100000000).toFixed(2)} 亿`
    if (number >= 1000000) return `${(number / 1000000).toFixed(2)} M`
    return number.toLocaleString('zh-CN')
  }
  const templateText = String(info?.chatTemplateText || config.chat_template_kwargs || '未读取').trim()

  return {
    rows: [
      { label: '模型', value: fileName, copy: fileName },
      { label: '文件路径', value: filePath || '未配置', copy: filePath || '' },
      { label: '上下文大小', value: formatTokens(info?.ctxSize) },
      { label: '训练上下文', value: formatTokens(info?.trainingContext) },
      { label: '模型大小', value: formatBytes(info?.fileSize) },
      { label: '参数量', value: formatParams(info?.nParams) },
      { label: '嵌入维度', value: formatCount(info?.embeddingSize) },
      { label: '词汇表大小', value: formatCount(info?.vocabSize) },
      { label: '词汇表类型', value: formatCount(info?.vocabType) },
      { label: '并行槽位', value: formatCount(info?.parallelSlots) },
      { label: '构建信息', value: info?.build || '未读取' },
    ],
    runtimeRows: [
      { label: '模型家族', value: info?.family || modelFamilyFromName(fileName) || '未识别' },
      { label: '量化等级', value: info?.quantization || quantLabelFromName(fileName) || '未识别' },
      { label: '服务地址', value: info?.serverUrl || state.status?.url || '未启动', copy: info?.serverUrl || state.status?.url || '' },
      { label: '最大输出', value: `${config.n_predict ?? info?.nPredict ?? '未设置'}` },
      { label: 'GPU 层数', value: `${config.n_gpu_layers ?? info?.gpuLayers ?? '未设置'}` },
      { label: '温度', value: `${config.temp ?? info?.temperature ?? '未设置'}` },
      { label: 'Top-P', value: `${config.top_p ?? info?.topP ?? '未设置'}` },
      { label: 'Top-K', value: `${config.top_k ?? info?.topK ?? '未设置'}` },
      { label: 'Min-P', value: `${config.min_p ?? info?.minP ?? '未设置'}` },
      { label: '存在惩罚', value: `${config.presence_penalty ?? info?.presencePenalty ?? '未设置'}` },
      { label: '重复惩罚', value: `${config.repeat_penalty ?? info?.repeatPenalty ?? '未设置'}` },
    ],
    templateText,
  }
}

function basename(filePath) {
  return String(filePath || '').split(/[\\/]/).pop() || ''
}

function formatBytes(bytes) {
  const value = Number(bytes || 0)
  if (!Number.isFinite(value) || value <= 0) return '未读取'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let next = value
  let unitIndex = 0
  while (next >= 1024 && unitIndex < units.length - 1) {
    next /= 1024
    unitIndex += 1
  }
  return `${next >= 100 || unitIndex === 0 ? next.toFixed(0) : next.toFixed(2)} ${units[unitIndex]}`
}

function modelFamilyFromName(name) {
  return String(name || '')
    .replace(/\.gguf$/i, '')
    .replace(/\.(q\d[^.]*)$/i, '')
    .replace(/\.(iq\d[^.]*)$/i, '')
}

function quantLabelFromName(name) {
  const match = String(name || '').match(/\.(q\d[^.]*)\.gguf$/i) || String(name || '').match(/\.(iq\d[^.]*)\.gguf$/i)
  return match?.[1]?.toUpperCase() || '未标注'
}

function paramScaleFromName(name) {
  const match = String(name || '').match(/(\d+(?:\.\d+)?)B/i)
  return match ? `${match[1]}B` : '未标注'
}

function buildModelInfoRows(info) {
  const config = state.config || {}
  const filePath = info?.filePath || config.model || ''
  const fileName = info?.name || basename(filePath) || '未选择模型'
  const family = info?.family || modelFamilyFromName(fileName)
  const quantization = info?.quantization || quantLabelFromName(fileName)
  const params = info?.parameterScale || paramScaleFromName(fileName)
  const templateText = String(info?.chatTemplateText || config.chat_template_kwargs || '由模型内置模板决定')
  return {
    rows: [
      { label: '模型', value: fileName, copy: fileName },
      { label: '文件路径', value: filePath || '未配置', copy: filePath || '' },
      { label: '模型家族', value: family || '未识别' },
      { label: '量化等级', value: quantization },
      { label: '参数规模', value: params },
      { label: '模型大小', value: formatBytes(info?.fileSize) },
      { label: '上下文大小', value: `${config.ctx_size || info?.ctxSize || '未设置'} tokens` },
      { label: '最大输出', value: `${config.n_predict ?? info?.nPredict ?? '未设置'}` },
      { label: 'GPU 层数', value: `${config.n_gpu_layers ?? info?.gpuLayers ?? '未设置'}` },
      { label: '服务地址', value: info?.serverUrl || state.status?.url || '未启动', copy: info?.serverUrl || state.status?.url || '' },
      { label: 'Temperature', value: `${config.temp ?? info?.temperature ?? ''}` },
      { label: 'Top-P / Top-K', value: `${config.top_p ?? info?.topP ?? ''} / ${config.top_k ?? info?.topK ?? ''}` },
      { label: 'Min-P', value: `${config.min_p ?? info?.minP ?? ''}` },
      { label: 'Presence / Repeat', value: `${config.presence_penalty ?? info?.presencePenalty ?? ''} / ${config.repeat_penalty ?? info?.repeatPenalty ?? ''}` },
      // 兜底不再显示可执行文件名：那是实现细节，用户看到「llama-server.exe」没有信息量
      { label: '服务端', value: info?.build || basename(config.llama_server_path) || '未识别', copy: config.llama_server_path || '' },
    ],
    templateText,
  }
}

function splitCodeParts(content) {
  const parts = []
  const pattern = /```([^\n`]*)\n?([\s\S]*?)```/g
  let cursor = 0
  let match
  while ((match = pattern.exec(content)) !== null) {
    if (match.index > cursor) {
      parts.push({ type: 'text', value: content.slice(cursor, match.index) })
    }
    parts.push({
      type: 'code',
      language: String(match[1] || '').trim().split(/\s+/)[0] || 'text',
      value: match[2] || '',
    })
    cursor = match.index + match[0].length
  }
  if (cursor < content.length) {
    parts.push({ type: 'text', value: content.slice(cursor) })
  }
  return parts.flatMap(part => part.type === 'text' ? splitLooseHtmlParts(part.value) : [part])
}

function splitLooseHtmlParts(text) {
  const value = String(text || '')
  const looseHtmlPattern = /(?:<!doctype\s+html[^]*?<\/html>|<html[\s\S]*?<\/html>)/i
  const match = looseHtmlPattern.exec(value)
  if (!match) return value ? [{ type: 'text', value }] : []

  const parts = []
  if (match.index > 0) parts.push({ type: 'text', value: value.slice(0, match.index) })
  parts.push({ type: 'code', language: 'html', value: match[0] })
  const end = match.index + match[0].length
  if (end < value.length) parts.push({ type: 'text', value: value.slice(end) })
  return parts
}

function renderTextBlock(text) {
  const value = String(text || '')
  if (!value.trim()) return ''
  return `<div class="markdown-text">${escapeHtml(value)}</div>`
}

function canPreviewCode(language, code) {
  const lang = String(language || '').toLowerCase()
  return ['html', 'htm', 'svg'].includes(lang) || /<!doctype|<html|<body|<style|<script/i.test(code)
}

function validateCodePreview(language, code) {
  if (!canPreviewCode(language, code)) return ''
  const value = String(code || '').trim()
  const lang = String(language || '').toLowerCase()
  const looksLikeHtml = ['html', 'htm'].includes(lang) || /<!doctype|<html|<body|<canvas|<script|<style/i.test(value)
  if (!looksLikeHtml) return ''

  if (/<html[\s>]/i.test(value) && !/<\/html>/i.test(value)) {
    return '预览代码不完整：缺少 </html> 结束标签。请让模型继续补全后再预览。'
  }
  if (/<script[\s>]/i.test(value) && !/<\/script>/i.test(value)) {
    return '预览代码不完整：缺少 </script> 结束标签。请让模型继续补全后再预览。'
  }
  if (/<canvas[\s>]/i.test(value) && !/requestAnimationFrame|setInterval|setTimeout/i.test(value)) {
    return '预览代码不完整：Canvas 粒子页缺少 requestAnimationFrame 动画循环。请让模型继续生成完整脚本。'
  }
  return ''
}

function estimateTokens(text) {
  const value = String(text || '').trim()
  if (!value) return 0
  const cjk = (value.match(/[\u4e00-\u9fff]/g) || []).length
  const latin = value.replace(/[\u4e00-\u9fff]/g, '').trim()
  const latinTokens = latin ? latin.split(/\s+/).filter(Boolean).length : 0
  return Math.max(1, Math.round(cjk * 0.9 + latinTokens * 1.25))
}

function chatQualityDefaults(mode = 'quality') {
  if (mode === 'fast') {
    return {
      chat_quality_mode: 'fast',
      chat_template_kwargs: '{"enable_thinking": false}',
      temp: 0.8,
      top_k: 20,
      top_p: 0.95,
      min_p: 0.05,
      presence_penalty: 0,
      repeat_penalty: '',
      expand_thinking: false,
    }
  }
  return {
    chat_quality_mode: 'quality',
    chat_template_kwargs: '',
    temp: 1,
    top_k: 20,
    top_p: 0.95,
    min_p: 0.05,
    presence_penalty: 0,
    repeat_penalty: '',
    expand_thinking: false,
  }
}

function applyChatQualityMode(mode) {
  const defaults = chatQualityDefaults(mode)
  Object.assign(state.config, defaults)
}

function responseStats(raw, content, latencyMs) {
  const usage = raw?.usage || {}
  const timings = raw?.timings || {}
  const completionTokens = usage.completion_tokens || timings.predicted_n || estimateTokens(content)
  const totalTokens = usage.total_tokens || completionTokens
  const nativeTps = Number(timings.predicted_per_second)
  const speedSource = Number.isFinite(nativeTps) && nativeTps > 0 ? 'native' : ''
  return {
    tokens: completionTokens || totalTokens || estimateTokens(content),
    speed: speedSource ? `${nativeTps.toFixed(2)} t/s` : '',
    speedSource,
  }
}

function generatedTextForStats(message) {
  return [message?.content, message?.thinking].filter(Boolean).join('\n\n')
}

function updateLiveStats(message) {
  if (!message || message.role !== 'assistant') return
  const startedAt = message.startedAt || message.createdAt || Date.now()
  const latencyMs = Math.max(1, Date.now() - startedAt)
  const generatedText = generatedTextForStats(message)
  const tokens = message.tokens || estimateTokens(generatedText)
  message.latencyMs = latencyMs
  message.estimatedTokens = estimateTokens(generatedText)
  message.liveSpeed = tokens ? `${(Number(tokens) / (latencyMs / 1000)).toFixed(2)} t/s` : ''
  message.liveSpeedSource = 'estimate'
}

function renderCodeAwareText(text, messageIndex, counter) {
  return splitCodeParts(String(text || ''))
    .map(part => {
      if (part.type === 'text') return renderTextBlock(part.value)
      const codeIndex = counter.value
      counter.value += 1
      const language = part.language || 'text'
      const previewable = canPreviewCode(language, part.value)
      const codeValue = String(part.value || '').replace(/^(?:[ \t]*\n)+|(?:\n[ \t]*)+$/g, '')
      return `
        <figure class="code-block" data-code-index="${codeIndex}">
          <figcaption>
            <span>${escapeHtml(language.toUpperCase())}</span>
            <div>
              <button type="button" data-action="copy-code" data-message-index="${messageIndex}" data-code-index="${codeIndex}" title="复制代码">复制</button>
              ${previewable ? `<button type="button" data-action="preview-code" data-message-index="${messageIndex}" data-code-index="${codeIndex}" title="在客户端里预览网页">预览网页</button>` : ''}
              ${previewable ? `<button type="button" data-action="download-code" data-message-index="${messageIndex}" data-code-index="${codeIndex}" title="保存为 HTML 文件">保存 HTML</button>` : ''}
            </div>
          </figcaption>
          <pre><code>${escapeHtml(codeValue)}</code></pre>
        </figure>
      `
    })
    .join('')
}

const THINKING_END_MARKERS = [
  /\(\s*End of thought process\s*\)/i,
  /(?:^|\n)\s*End of thought process\s*[:：]?/i,
  /(?:^|\n)\s*(?:Okay,\s*I'll write:|I(?:'|’)ll output exactly that\.?|最终答案\s*[:：]|回答\s*[:：])/i,
]

function looksLikeReasoningText(text) {
  return /(?:Analyze the User|Determine the Intent|Formulate the Response|Drafting the response|Selecting the Best Response|Final Polish|思考|推理|分析用户|判断意图)/i.test(String(text || ''))
}

function thinkingEndBoundary(text) {
  for (const pattern of THINKING_END_MARKERS) {
    const match = pattern.exec(text)
    if (match) return { index: match.index, endIndex: match.index + match[0].length }
  }
  return null
}

function splitThinkingOutput(content) {
  const text = String(content || '')
  const tagPattern = /<think(?:ing)?>/i
  const closePattern = /<\/think(?:ing)?>/i
  const labelPattern = /(?:^|\n)\s*(?:Thinking Process|思考过程)\s*[:：]/i
  const openTag = tagPattern.exec(text)
  const openLabel = labelPattern.exec(text)
  const openCandidates = [openTag, openLabel].filter(Boolean)
  const firstOpen = openCandidates.sort((a, b) => a.index - b.index)[0]
  const closeTag = closePattern.exec(text)
  const cleanMarkers = value => String(value || '')
    .replace(/<\/?think(?:ing)?>/gi, '')
    .replace(/^\s*(?:Thinking Process|思考过程)\s*[:：]\s*/i, '')
    .trim()

  if (firstOpen) {
    const openEnd = firstOpen.index + firstOpen[0].length
    const prefix = text.slice(0, firstOpen.index)
    const closeAfterOpen = closePattern.exec(text.slice(openEnd))
    if (closeAfterOpen) {
      const closeStart = openEnd + closeAfterOpen.index
      const closeEnd = closeStart + closeAfterOpen[0].length
      const prefixLooksLikeThinking = !prefix.trim() || /(?:reasoning|thinking|思考|推理)/i.test(prefix)
      const answerPrefix = prefixLooksLikeThinking ? '' : prefix
      const thoughtPrefix = prefixLooksLikeThinking ? prefix : ''
      return {
        answer: cleanMarkers(`${answerPrefix}${text.slice(closeEnd)}`),
        thoughts: [cleanMarkers(`${thoughtPrefix}${text.slice(openEnd, closeStart)}`)].filter(Boolean),
      }
    }

    return {
      answer: cleanMarkers(prefix),
      thoughts: [cleanMarkers(text.slice(openEnd))].filter(Boolean),
    }
  }

  if (closeTag) {
    const closeEnd = closeTag.index + closeTag[0].length
    return {
      answer: cleanMarkers(text.slice(closeEnd)),
      thoughts: [cleanMarkers(text.slice(0, closeTag.index))].filter(Boolean),
    }
  }

  const naturalBoundary = thinkingEndBoundary(text)
  if (naturalBoundary && looksLikeReasoningText(text.slice(0, naturalBoundary.index))) {
    return {
      answer: cleanMarkers(text.slice(naturalBoundary.endIndex)),
      thoughts: [cleanMarkers(text.slice(0, naturalBoundary.index))].filter(Boolean),
    }
  }

  return { answer: text, thoughts: [] }
}

function renderMessageContent(message, messageIndex) {
  const content = String(message.content || '')
  if (!content && !message.thinking && message.role === 'assistant' && state.chatBusy) {
    return '<div class="typing-line">正在生成...</div>'
  }
  if (message.role !== 'assistant') {
    return content ? renderTextBlock(content) : ''
  }

  const counter = { value: 0 }
  const output = []
  const split = splitThinkingOutput(content)
  const answer = split.answer
  const thoughts = [String(message.thinking || '').trim(), ...split.thoughts].filter(Boolean)
  const showRawOutput = Boolean(state.config?.show_raw_output)
  const showThinking = state.config?.show_thinking !== false && !showRawOutput
  const expandThinking = Boolean(state.config?.expand_thinking)
  const thinkingKey = thinkingMessageKey(message, messageIndex)
  const thinkingOpen = state.openThinkingMessages.has(thinkingKey) ||
    (expandThinking && !state.closedThinkingMessages.has(thinkingKey))

  if (showThinking && thoughts.length > 0) {
    output.push(`
      <details class="think-block" data-thinking-key="${escapeAttribute(thinkingKey)}" ${thinkingOpen ? 'open' : ''}>
        <summary data-action="toggle-thinking" data-thinking-key="${escapeAttribute(thinkingKey)}" data-message-index="${messageIndex}">思考过程</summary>
        ${renderCodeAwareText(thoughts.join('\n\n'), messageIndex, counter)}
      </details>
    `)
  } else if (!showRawOutput && thoughts.length > 0 && state.config?.show_thinking === false) {
    output.push('<div class="markdown-text muted-note">思考过程已隐藏。</div>')
  }

  if (answer) {
    output.push(renderCodeAwareText(answer, messageIndex, counter))
  }

  if (showRawOutput && (content || message.thinking) && !message.streaming) {
    const rawOutput = [message.thinking ? `Thinking:\n${message.thinking}` : '', content].filter(Boolean).join('\n\n')
    output.push(`
      <details class="raw-output-block">
        <summary>原始输出</summary>
        <pre>${escapeHtml(rawOutput)}</pre>
      </details>
    `)
  } else if (showRawOutput && (content || message.thinking) && message.streaming) {
    output.push('<div class="markdown-text muted-note">原始输出将在生成结束后显示。</div>')
  }

  return output.join('') || renderTextBlock(content)
}

function getCodeBlock(messageIndex, codeIndex) {
  const message = state.chatMessages[Number(messageIndex)]
  if (!message) return null
  const blocks = splitCodeParts(String(message.content || '')).filter(part => part.type === 'code')
  return blocks[Number(codeIndex)] || null
}

function scrollOpenRawOutputs(root = document) {
  const sync = () => {
    root.querySelectorAll?.('.raw-output-block[open] pre').forEach(pre => {
      pre.scrollTop = pre.scrollHeight
    })
  }
  sync()
  window.requestAnimationFrame(sync)
}

function stickStreamingMessage(article, feed) {
  const sync = () => {
    scrollOpenRawOutputs(article)
    if (feed) feed.scrollTop = feed.scrollHeight
  }
  sync()
  window.requestAnimationFrame(sync)
}

function updateMessageDom(index) {
  const feed = document.getElementById('chatFeed')
  const shouldStick = isNearBottom(feed)
  const message = state.chatMessages[index]
  const article = document.querySelector(`[data-message-index="${index}"]`)
  const bubble = article?.querySelector('.bubble')
  const meta = article?.querySelector('.message-meta')
  if (!message || !bubble) return
  updateLiveStats(message)
  bubble.innerHTML = renderMessageContent(message, index)
  if (meta) meta.outerHTML = renderMessageMeta(message)
  if (message.streaming) {
    stickStreamingMessage(article, feed)
  } else if (shouldStick && feed) {
    feed.scrollTop = feed.scrollHeight
  }
}

function modelName() {
  const model = state.config?.model || ''
  return model.split(/[\\/]/).pop() || 'local-model'
}

function statusLabel() {
  return {
    stopped: '未启动',
    starting: '启动中',
    running: '运行中',
    stopping: '停止中',
    error: '需要处理',
  }[state.status.state] || state.status.state
}

function statusClass() {
  if (state.status.state === 'running') return 'running'
  if (state.status.state === 'error') return 'error'
  if (state.status.state === 'starting' || state.status.state === 'stopping') return 'pending'
  return ''
}

function compactStatusMessage(message) {
  const text = String(message || '')
  if (text.includes('System message must be at the beginning')) {
    return '系统消息位置错误：已在新版中自动合并到请求最前面。'
  }
  if (/timeout|aborted/i.test(text)) {
    return '请求超时：可在设置里调大“请求超时 ms”，或降低上下文/输出长度。'
  }
  if (text.length > 180) {
    return `${text.slice(0, 180)}...`
  }
  return text
}

function friendlyErrorMessage(error) {
  const text = String(error?.message || error || '')
  if (text.includes('System message must be at the beginning')) {
    return '发送失败：系统消息必须位于请求最前面。新版会自动整理历史消息，请再发送一次。'
  }
  if (/timeout|aborted/i.test(text)) {
    return '发送失败：请求超时。可以在设置里调大“请求超时 ms”，或降低 ctx_size / n_predict 后重试。'
  }
  if (text.includes('Chat Template Kwargs must be valid JSON')) {
    return `发送失败：Chat Template Kwargs 不是合法 JSON。${text}`
  }
  return text.length > 360 ? `发送失败：${text.slice(0, 360)}...` : `发送失败：${text}`
}

function shortTime(value) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

function makeSessionId() {
  return `session-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function titleFromMessages(messages) {
  const firstUser = messages.find(message => message.role === 'user' && String(message.content || '').trim())
  return String(firstUser?.content || '新聊天').replace(/\s+/g, ' ').slice(0, 36)
}

function loadSessions() {
  try {
    const saved = JSON.parse(localStorage.getItem('llama.cpp.desktop.sessions') || '[]')
    state.sessions = Array.isArray(saved) ? saved : []
  } catch {
    state.sessions = []
  }
}

function persistSessions() {
  localStorage.setItem('llama.cpp.desktop.sessions', JSON.stringify(state.sessions.slice(0, 80)))
}

function saveCurrentSession() {
  if (!state.currentSessionId || state.chatMessages.length === 0) return
  const now = Date.now()
  const next = {
    id: state.currentSessionId,
    title: titleFromMessages(state.chatMessages),
    messages: state.chatMessages,
    updatedAt: now,
  }
  const existing = state.sessions.findIndex(session => session.id === state.currentSessionId)
  if (existing >= 0) {
    state.sessions.splice(existing, 1, next)
  } else {
    state.sessions.unshift(next)
  }
  state.sessions.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  persistSessions()
}

function buildApiMessages(messages) {
  const systemMessages = []
  const conversation = []

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.localOnly) continue
    if (!['user', 'assistant', 'system'].includes(message.role)) continue
    if (!String(message.content || '').trim() && !(Array.isArray(message.attachments) && message.attachments.length)) continue

    if (message.role === 'system') {
      const systemText = String(message.content || '').trim()
      if (/^(发送失败|重试失败|请求失败|启动失败)[：:]/.test(systemText)) continue
      if (systemText === '系统消息：请在这里写给模型的长期要求，发送下一条消息时会一起带上。') continue
      systemMessages.push(systemText)
      continue
    }

    const next = message.role === 'assistant'
      ? sanitizeAssistantForContext(message)
      : sanitizeUserForContext(message)
    if (next) conversation.push(next)
  }

  return systemMessages.length
    ? [{ role: 'system', content: systemMessages.filter(Boolean).join('\n\n') }, ...conversation]
    : conversation
}

function sanitizeAssistantForContext(message) {
  const content = String(message?.content || '').trim()
  if (!content) return null
  if (/^(发送失败|重试失败|请求失败|启动失败|模型返回了空内容)[：:。]/.test(content)) return null
  const next = { role: 'assistant', content }
  delete next.thinking
  return next
}

function sanitizeUserForContext(message) {
  const content = String(message?.content || '').trim()
  const attachments = Array.isArray(message?.attachments) ? message.attachments : []
  if (!content && attachments.length === 0) return null
  const next = { role: 'user', content }
  if (attachments.length) next.attachments = attachments
  return next
}

function openSession(sessionId) {
  saveCurrentSession()
  const session = state.sessions.find(item => item.id === sessionId)
  if (!session) return
  state.currentSessionId = session.id
  state.chatMessages = Array.isArray(session.messages) ? session.messages : []
  state.chatInput = ''
  state.attachments = []
  state.view = 'chat'
  state.sidebarPanel = 'chats'
  state.attachmentMenuOpen = false
  state.historyMenuId = ''
}

function startFreshSession() {
  saveCurrentSession()
  state.currentSessionId = makeSessionId()
  state.chatMessages = []
  state.chatInput = ''
  state.attachments = []
  state.attachmentMenuOpen = false
  state.view = 'chat'
  state.sidebarPanel = 'chats'
  state.historyMenuId = ''
}

function attachmentLabel(kind) {
  return {
    image: '图片',
    audio: '音频',
    text: '文本',
    pdf: 'PDF',
    system: '系统',
    mcp: 'MCP',
    file: '文件',
  }[kind] || '文件'
}

function flushStreamRender() {
  if (streamRenderTimer) {
    window.clearTimeout(streamRenderTimer)
    streamRenderTimer = null
  }
  const index = pendingStreamRenderIndex
  pendingStreamRenderIndex = null
  if (index !== null && index !== undefined) {
    updateMessageDom(index)
  }
}

function scheduleStreamRender(index) {
  pendingStreamRenderIndex = index
  if (streamRenderTimer) return
  streamRenderTimer = window.setTimeout(flushStreamRender, STREAM_RENDER_INTERVAL_MS)
}

function readinessSummary() {
  const rows = readinessChecklist({
    config: state.config || {},
    validation: state.validation,
    status: state.status,
    dirty: state.dirty,
  })
  const repair = startupDiagnosis({
    config: state.config || {},
    validation: state.validation,
    status: state.status,
    dirty: state.dirty,
  })
  const counts = rows.reduce(
    (summary, row) => {
      if (row.state === 'ready') summary.pass += 1
      else if (row.state === 'blocked') summary.block += 1
      else summary.warn += 1
      return summary
    },
    { pass: 0, warn: 0, block: 0 },
  )
  const next = rows.find(row => row.state === 'blocked')
    || rows.find(row => row.state === 'warning')
    || rows.find(row => row.state === 'pending')
    || rows[0]

  return {
    rows,
    counts,
    nextAction: repair.level === 'good' && next?.state === 'ready' && counts.warn === 0 && counts.block === 0 ? '可以开始对话' : repair.action || next?.action || '检查本地运行状态',
  }
}

function renderReadinessStrip() {
  const { rows, counts, nextAction } = readinessSummary()
  return `
    <div class="run-check-shell">
      <button type="button" class="run-check-strip" data-action="toggle-run-check" aria-label="运行检查" aria-expanded="${state.runCheckExpanded ? 'true' : 'false'}">
        <span class="run-check-title">运行检查</span>
        <span class="run-check-count pass">通过 ${counts.pass}</span>
        <span class="run-check-count warn">提醒 ${counts.warn}</span>
        <span class="run-check-count block">阻塞 ${counts.block}</span>
        <span class="run-check-next">${escapeHtml(nextAction)}</span>
      </button>
      ${state.runCheckExpanded ? `
        <div class="run-check-details">
          ${rows.map(row => `
            <div class="run-check-detail ${escapeHtml(row.state)}">
              ${repairBadge(row.state)}
              <strong>${escapeHtml(row.label)}</strong>
              <span>${escapeHtml(row.action)}</span>
            </div>
          `).join('')}
        </div>
      ` : ''}
    </div>
  `
}

function supportValue(kind, capability) {
  if (kind === 'image') {
    if (capability.mode === 'vision-configured') return '已配置 mmproj，需实测模型支持'
    if (capability.mode === 'vision-needs-mmproj') return '需要 mmproj'
    return '未确认支持'
  }
  if (kind === 'pdf') return '暂不支持 PDF'
  return '暂不支持音频'
}

function buildCapabilityRows(info, capability) {
  const config = state.config || {}
  const filePath = info?.filePath || config.model || ''
  const fileName = info?.name || basename(filePath) || '未选择模型'
  const endpoint = info?.serverUrl || state.status?.url || ''
  const contextSize = config.ctx_size || info?.ctxSize || info?.trainingContext || ''

  return [
    { label: '模型文件', value: fileName },
    { label: '量化等级', value: info?.quantization || quantLabelFromName(fileName) || '未识别' },
    { label: '上下文', value: contextSize ? `${contextSize} tokens` : '未设置' },
    { label: '端点', value: endpoint ? `${String(endpoint).replace(/\/+$/, '')}/v1` : '未启动' },
    { label: '多模态', value: capability.label },
    { label: '图片', value: supportValue('image', capability) },
    { label: 'PDF', value: supportValue('pdf', capability) },
    { label: '音频', value: supportValue('audio', capability) },
  ]
}

function renderAttachmentItem(item, index, removable, mode = 'composer') {
  const kind = String(item?.kind || 'file')
  const name = String(item?.name || 'attachment')
  const notice = attachmentNotice(item)
  const meta = formatBytes(item.size || 0)
  const title = [name, item.path || '', meta, notice].filter(Boolean).join('\n')
  const removeButton = removable
    ? `<button type="button" class="attachment-remove" data-action="remove-attachment" data-index="${index}" title="移除附件">×</button>`
    : ''

  if (kind === 'image' && item?.dataUrl) {
    if (mode === 'message-user') {
      return `
        <button type="button" class="chat-image-attachment" data-action="preview-image" data-src="${escapeAttribute(item.dataUrl)}" data-title="${escapeAttribute(name)}" title="${escapeAttribute(title)}">
          <img src="${escapeAttribute(item.dataUrl)}" alt="${escapeAttribute(name)}" loading="lazy" />
        </button>
      `
    }

    return `
      <figure class="attachment-card image ${removable ? 'editable' : 'readonly'}" title="${escapeAttribute(title)}">
        <button type="button" class="attachment-image-trigger" data-action="preview-image" data-src="${escapeAttribute(item.dataUrl)}" data-title="${escapeAttribute(name)}" title="预览图片">
          <img src="${escapeAttribute(item.dataUrl)}" alt="${escapeAttribute(name)}" loading="lazy" />
        </button>
        <figcaption>
          <strong>${escapeHtml(name)}</strong>
          <span>${escapeHtml(meta)}</span>
          ${renderAttachmentNotice(item, escapeHtml)}
        </figcaption>
        ${removeButton}
      </figure>
    `
  }

  return `
    <span class="attachment-chip ${escapeHtml(kind)} ${mode === 'message-user' ? 'message-file' : ''}" title="${escapeAttribute(title)}">
      <strong>${attachmentLabel(kind)}</strong>
      <span class="attachment-details">
        <span class="attachment-name">${escapeHtml(name)}</span>
        ${renderAttachmentNotice(item, escapeHtml)}
      </span>
      <span class="attachment-size">${escapeHtml(formatBytes(item.size || 0))}</span>
      ${removeButton}
    </span>
  `
}

function renderMessageActions(index, message) {
  const canRetry = message.role === 'assistant'
  return `
    <div class="message-actions">
      <button type="button" data-action="copy-message" data-index="${index}" title="复制消息">⧉</button>
      <button type="button" data-action="edit-message" data-index="${index}" title="编辑消息">✎</button>
      ${canRetry ? `<button type="button" data-action="retry-message" data-index="${index}" title="重新生成回复">↻</button>` : ''}
      <button type="button" data-action="delete-message" data-index="${index}" title="删除消息">⌫</button>
    </div>
  `
}

function renderMessageMeta(message) {
  if (message.role !== 'assistant') return ''
  const tokens = message.tokens || message.estimatedTokens || estimateTokens(generatedTextForStats(message))
  const latencyMs = message.latencyMs || (message.streaming ? Date.now() - (message.startedAt || message.createdAt || Date.now()) : 0)
  const nativeSpeed = message.speedSource === 'native' && message.speed ? message.speed : ''
  const estimatedSpeed = !nativeSpeed && message.liveSpeed ? message.liveSpeed : ''
  const pieces = [
    `<span class="model-pill">◇ ${escapeHtml(message.model || modelName())}</span>`,
    `<span>▦ 输出 ${escapeHtml(tokens || 0)} tokens</span>`,
    latencyMs ? `<span>◷ 总耗时 ${(latencyMs / 1000).toFixed(1)}s</span>` : '<span>◷ 总耗时 0.0s</span>',
    nativeSpeed ? `<span>⌁ 生成速率 ${escapeHtml(nativeSpeed)}</span>` : '',
    estimatedSpeed ? `<span>⌁ 估算速率 ${escapeHtml(estimatedSpeed)}</span>` : '',
    message.streaming ? '<span>生成中</span>' : '',
    message.state === 'cancelling' ? '<span class="message-state cancelling">正在停止</span>' : '',
    message.state === 'cancelled' ? '<span class="message-state cancelled">已停止 · 不会加入上下文</span>' : '',
    message.state === 'failed' ? '<span class="message-state failed">生成失败 · 不会加入上下文</span>' : '',
  ].filter(Boolean)

  return pieces.length ? `<div class="message-meta">${pieces.join('')}</div>` : ''
}

function logEntries() {
  return Array.isArray(state.logs?.entries) ? state.logs.entries : []
}

function visibleLogs(limit = 420) {
  return logEntries().slice(-limit)
}

// 终端三视图（对齐原型 .term-tab）。原型只有高亮、没有过滤逻辑，这里做成真过滤。
function visibleTerminalLogs(limit = TERMINAL_VIEW_LOG_LIMIT) {
  return selectTerminalLogs(logEntries(), state.terminalTab || 'output', limit)
}

function renderLogRow(entry, className = 'terminal-row') {
  return `
    <div class="${className}">
      <span>${escapeHtml(shortTime(entry.at))}</span>
      <strong>${escapeHtml(entry.source || 'log')}</strong>
      <em>${escapeHtml(entry.line || '')}</em>
    </div>
  `
}

function renderSidebarLogs() {
  const logs = visibleLogs(80)
  if (!logs.length) {
    return '<div class="terminal-empty">还没有终端日志。启动服务后，这里会实时出现 llama.cpp 输出。</div>'
  }

  return logs
    .reverse()
    .map(entry => `
      <button type="button" class="terminal-item" data-action="open-log-settings">
        <span>${escapeHtml(shortTime(entry.at))}</span>
        <strong>${escapeHtml(entry.source || 'log')}</strong>
        <em>${escapeHtml(entry.line || '')}</em>
      </button>
    `)
    .join('')
}

function pill(ok, labelOk = '就绪', labelBad = '缺失') {
  return `<span class="pill ${ok ? 'good' : 'bad'}">${ok ? labelOk : labelBad}</span>`
}

function field(name, label, options = {}) {
  const directMode = (state.config?.launch_mode || 'direct') !== 'launcher'
  if (directMode && ['config_path', 'launcher_path', 'llama_server_path'].includes(name)) {
    return ''
  }

  const value = state.config?.[name] ?? ''
  const type = options.type || 'text'
  const picker = options.pick
    ? `<button class="icon-btn text-btn" type="button" data-pick="${name}" data-kind="${options.pick}">选择</button>`
    : ''
  const hint = options.hint ? `<div class="hint">${escapeHtml(options.hint)}</div>` : ''
  const warning = configWarning(options.warningId)
  const input = options.textarea
    ? `<textarea data-field="${name}" spellcheck="false">${escapeHtml(value)}</textarea>`
    : `<input data-field="${name}" type="${type}" value="${escapeHtml(value)}" ${options.min !== undefined ? `min="${options.min}"` : ''} />`

  return `
    <label class="field">
      <span>${escapeHtml(label)}</span>
      <div class="${picker ? 'field-row' : ''}">
        ${input}
        ${picker}
      </div>
      ${hint}
      ${warning}
    </label>
  `
}

function configWarning(id) {
  const warning = runtimeWarnings(state.config).find(item => item.id === id)
  return `<div class="settings-callout" data-config-warning="${escapeAttribute(id)}" role="alert" ${warning ? '' : 'hidden'}>${warning ? escapeHtml(warning.message) : ''}</div>`
}

function refreshConfigWarnings() {
  const warnings = runtimeWarnings(state.config)
  for (const element of appEl.querySelectorAll('[data-config-warning]')) {
    const warning = warnings.find(item => item.id === element.dataset.configWarning)
    element.hidden = !warning
    element.textContent = warning?.message || ''
  }
}

function selectField(name, label, choices, hint = '') {
  const value = state.config?.[name] ?? ''
  const directMode = (state.config?.launch_mode || 'direct') !== 'launcher'
  const extra = name === 'launch_mode' && directMode
    ? field('llama_bin_dir', 'llama.cpp 原文件目录', { pick: 'dir', hint: '选择包含 llama-server.exe 的目录（同目录需带 CUDA / ggml 运行库）。' })
    : ''
  const choiceLabel = choice => {
    if (name === 'chat_quality_mode') {
      if (choice === 'quality') return '质量模式'
      if (choice === 'fast') return '极速模式'
    }
    if (name === 'theme_mode') {
      if (choice === 'light') return '浅色'
      if (choice === 'dark') return '深色'
      if (choice === 'system') return '跟随系统'
    }
    if (name === 'chat_font') {
      if (choice === 'default') return '默认'
      if (choice === 'sans') return 'Sans'
      if (choice === 'system') return '系统'
      if (choice === 'readable') return '易读'
    }
    return choice || 'auto'
  }
  const options = choices
    .map(choice => `<option value="${escapeHtml(choice)}" ${String(choice) === String(value) ? 'selected' : ''}>${escapeHtml(choiceLabel(choice))}</option>`)
    .join('')
  return `
    <label class="field">
      <span>${escapeHtml(label)}</span>
      <select data-field="${name}">${options}</select>
      ${hint ? `<div class="hint">${escapeHtml(hint)}</div>` : ''}
    </label>
  ${extra}`
}

// 当前引擎不支持的字段：置灰 + 强制未勾选，避免"勾了但启动被拒"。
function engineBlockedKeys() {
  const id = state.engine?.engineId || 'llama-cpp'
  // 布尔键与非布尔参数分属两张表，语义不同不能混（见 preset-engine.mjs 注释）：
  // 布尔键会被 sanitize 置 false，非布尔键（type_k 等）只能清空。
  return [...engineIncompatibleConfigKeys(id), ...engineIncompatibleParamKeys(id)]
}

function engineBlockedLabels() {
  return engineIncompatibleLabels(state.engine?.engineId || 'llama-cpp')
}

function switchField(name, label, hint) {
  const blocked = engineBlockedKeys().includes(name)
  const hintText = blocked ? `当前引擎不支持，已禁用。` : hint
  return `
    <label class="switch ${blocked ? 'is-disabled' : ''}">
      <span>
        <strong>${escapeHtml(label)}</strong>
        <em>${escapeHtml(hintText)}</em>
      </span>
      <input data-field="${name}" type="checkbox" ${state.config?.[name] && !blocked ? 'checked' : ''} ${blocked ? 'disabled' : ''} />
    </label>
  `
}

// 主区那块「把本地大模型跑起来」引导只在真正首次使用时出现。
// 之前只要「聊天为空 + 服务没跑」就常驻 —— 每次打开都糊一大块，很吵。
// 用 localStorage 记住「已经用过」，用过就不再显示。
const ONBOARDING_DONE_KEY = 'llama-desktop:onboarding-done'
function markOnboardingDone() {
  if (state.onboardingDone) return
  state.onboardingDone = true
  try {
    window.localStorage?.setItem(ONBOARDING_DONE_KEY, '1')
  } catch {}
}

// 底部状态栏的资源指标条 —— 对齐原型 .res-metrics（VRAM / RAM 各一条）。
// 数据源：state.vramUsage（llama:vram-check）与 state.systemInfo（llama:get-system-info）。
function renderResMetrics() {
  const vram = state.vramUsage || null
  const info = state.systemInfo || null
  const metrics = []

  const vramTotal = Number(vram?.total) || 0
  if (vramTotal > 0) {
    const used = Number(vram.used) || 0
    const pct = Math.min(100, Math.round((used / vramTotal) * 100))
    metrics.push({
      label: 'VRAM',
      text: `${(used / 1024).toFixed(1)} / ${(vramTotal / 1024).toFixed(1)} GB`,
      pct,
      variant: 'vram',
    })
  } else {
    // 显存读数拿不到时也要占位。以前这一格直接不渲染，底栏就只剩 RAM，
    // 用户看到的是「程序根本没有显存这项」，而不是「这次没读到」。
    metrics.push({
      label: 'VRAM',
      text: '未检测到',
      pct: 0,
      variant: 'vram',
      muted: true,
    })
  }

  const ramTotal = Number(info?.totalMemoryGB) || 0
  const ramFree = Number(info?.freeMemoryGB)
  if (ramTotal > 0 && Number.isFinite(ramFree)) {
    const used = Math.max(0, ramTotal - ramFree)
    const pct = Math.min(100, Math.round((used / ramTotal) * 100))
    metrics.push({
      label: 'RAM',
      text: `${used.toFixed(1)} / ${ramTotal.toFixed(1)} GB`,
      pct,
      variant: 'ram',
    })
  }

  if (!metrics.length) return ''
  return `
    <div class="res-metrics">
      ${metrics.map(m => `
        <div class="metric ${m.muted ? 'muted' : ''}">
          <span class="metric-label">${m.label}</span>
          <div class="metric-content">
            <div class="bar"><div class="fill ${m.variant}" style="width:${m.pct}%"></div></div>
            <span class="metric-text">${escapeHtml(m.text)}</span>
          </div>
        </div>`).join('')}
    </div>
  `
}

// 模型文件名智能缩写：只截中间，保住「模型名开头」和「量化后缀」这两头。
// 单纯 text-overflow 会把量化信息（Q4_K_M / IQ2_XXS）一起吃掉，而它恰恰是
// 挑选模型时最需要看的一段，所以这里手动做中段省略。
function shortenModelName(name, max = 30) {
  const raw = String(name || '')
  if (raw.length <= max) return raw
  const ext = /\.gguf$/i.test(raw) ? raw.slice(-5) : ''
  const stem = ext ? raw.slice(0, -ext.length) : raw
  const budget = Math.max(8, max - ext.length - 1)
  const tail = Math.max(5, Math.floor(budget * 0.55))
  const head = Math.max(4, budget - tail)
  return `${stem.slice(0, head)}…${stem.slice(-tail)}${ext}`
}

// 当前生效的引擎：显式选过就用它，否则按 server 路径反推。
// 顶栏引擎徽章与参数页的「引擎支持哪些 KV 量化档」必须是同一个判断。
function currentEngineId() {
  return state.engine?.engineId || detectEngineByPath(state.config?.llama_server_path) || 'llama-cpp'
}

function currentModelPath() {
  return String(state.config?.model || '')
}

function currentModelName() {
  const full = currentModelPath()
  if (!full) return ''
  return full.split(/[\\/]/).filter(Boolean).pop() || full
}

// 顶栏「模型」折叠菜单。
// 收起时显示「当前预设对应的模型文件名」（过长按中段省略），
// 展开时列出本机扫描到的全部本地 gguf，可直接切换。
function renderModelMenu(open) {
  const models = state.modelList || []
  const currentPath = currentModelPath()
  const currentName = currentModelName()
  const isOpen = open === 'models'

  const items = models.length
    ? models.map(model => {
        const active = model.path === currentPath
        const meta = [model.folder, model.sizeGB ? `${model.sizeGB} GB` : '', model.quant].filter(Boolean).join(' · ')
        return `
          <div class="mf-item ${active ? 'on' : ''}" data-action="model-select" data-model-path="${escapeAttribute(model.path)}" title="${escapeAttribute(model.path)}">
            <div class="mf-item-main">
              <span class="mf-item-name">${escapeHtml(shortenModelName(model.label, 42))}</span>
              <span class="mf-item-meta">${escapeHtml(meta || model.dir || '')}</span>
            </div>
            ${active ? '<span class="mf-item-tick">当前</span>' : ''}
          </div>`
      }).join('')
    : `<div class="mf-empty">${state.modelListLoaded ? '没有扫描到本地 gguf 模型。可以手动选一个文件：' : '正在扫描本地模型…'}</div>`

  return `
    <div class="model-file ${isOpen ? 'open' : ''} ${currentName ? '' : 'unset'}" data-action="toggle-topbar-menu" data-menu="models" title="${escapeAttribute(currentPath || '未选择模型文件')}">
      <span class="mf-name">${escapeHtml(currentName ? shortenModelName(currentName, 26) : '未选择模型')}</span>
      ${state.dirty ? '<span class="mf-flag" title="有改动尚未保存">待保存</span>' : ''}
      <span class="arrow">&#9660;</span>
      <div class="model-file-dropdown ${isOpen ? 'show' : ''}">
        <div class="mf-head">
          <div>
            <strong>本地模型</strong>
            <span>${models.length ? `${models.length} 个 gguf · 点击切换` : '正在扫描'}</span>
          </div>
          <button type="button" class="mf-refresh" data-action="refresh-models">重新扫描</button>
        </div>
        <div class="mf-list">${items}</div>
        <!-- 常驻的手动选择入口：全新用户还没有任何已配置模型时，扫描根也是空的，
             只能靠它起步；已有模型的人也可能想选一个扫描范围外的文件。 -->
        <button type="button" class="mf-manual" data-pick="model" data-kind="gguf">选择模型文件…</button>
      </div>
    </div>
  `
}

// 顶栏：品牌 + 预设选择 + 终端/设置 + 引擎 —— 对齐 prototype/layout-demo.html
function renderTopbar() {
  // 顶栏不再有预设胶囊：它显示的内容和左侧「预设配置」列表完全重复，
  // 而左侧列表还能按当前模型过滤。预设入口统一收到左侧。
  const engines = state.engineList || []
  // 引擎徽章曾经「永远显示 llama.cpp」：state.engine 只有 {engineId, engines}，
  // 没有 label；而它在 engines 里找的键名是 engineId，真实字段却叫 id —— 两次都落空，
  // 于是无论加载哪个预设都退回兜底文案。这被当成「预设没有匹配后端引擎」。
  const engineId = state.engine?.engineId || detectEngineByPath(state.config?.llama_server_path)
  const engineEntry = engines.find(item => item.id === engineId)
  const engineLabel = engineEntry?.label || getEngineLabel(engineId)
  // 必须显示「实际会启动的那个 exe」，而不是引擎定义的规范路径：
  // KVMem 在本机有两个可执行文件（kvmem-gui\llama-server.exe 与
  // kvmem\bin\llama-kvmem-server.exe），预设选哪个就得显示哪个，
  // 否则用户看到的和真正跑起来的不是同一个文件。
  const enginePath = state.config?.llama_server_path || engineEntry?.path || ''
  const engineDetail = engineEntry?.desc || ''
  const open = state.topbarMenu

  return `
    <header class="topbar">
      <div class="brand">
        <button type="button" class="app-mark sidebar-brand-toggle" data-action="toggle-sidebar" title="${state.sidebarCollapsed ? '展开侧栏' : '收起侧栏'}" aria-label="${state.sidebarCollapsed ? '展开侧栏' : '收起侧栏'}">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
            <rect x="1" y="1" width="14" height="14" rx="2" stroke="currentColor" stroke-width="1.5"/>
            <rect x="4" y="9" width="8" height="5" rx="1" fill="currentColor"/>
          </svg>
        </button>
        <div class="brand-name">Llama Rig<small>本地多引擎推理控制台</small></div>
      </div>

      ${renderModelMenu(open)}

      <div class="topbar-spacer"></div>

      <button type="button" class="topbar-action ${state.view === 'params' ? 'on' : ''}" data-action="set-view" data-view="params">参数</button>
      <button type="button" class="topbar-action ${state.view === 'chat' ? 'on' : ''}" data-action="set-view" data-view="chat">聊天</button>
      <button type="button" class="topbar-action ${state.view === 'terminal' ? 'on' : ''}" data-action="set-view" data-view="terminal">终端</button>
      <button type="button" class="topbar-action" data-action="toggle-settings" title="打开设置" aria-label="打开设置">${renderGearIcon()}</button>

      <div class="engine-menu">
        <button type="button" class="engine-btn ${open === 'engine' ? 'open' : ''}" data-action="toggle-topbar-menu" data-menu="engine">
          <span style="width:8px;height:8px;border-radius:50%;background:var(--ok);flex-shrink:0"></span>
          <span>${escapeHtml(engineLabel)}</span>
          <span class="arrow">&#9660;</span>
        </button>
        <div class="engine-dropdown ${open === 'engine' ? 'show' : ''}">
          <div class="eng-info">
            <div class="eng-name">${escapeHtml(engineLabel)}</div>
            <div class="eng-ver">${enginePath ? '已就绪 · 由所选预设决定' : '未找到引擎可执行文件'}</div>
            ${engineDetail ? `<div style="margin-top:6px;font-size:11px;color:var(--text-3)">${escapeHtml(engineDetail)}</div>` : ''}
          </div>
        </div>
      </div>
    </header>
  `
}

// 侧栏：预设配置 + 对话历史 + 底部按钮 —— 对齐 prototype/layout-demo.html
function renderSide() {
  const query = state.historySearch.trim().toLowerCase()
  const sessions = state.sessions
    .filter(session => !query || String(session.title || '').toLowerCase().includes(query))
    .slice(0, 28)
    .map(session => `
      <div class="history-row ${session.id === state.currentSessionId ? 'active' : ''}">
        <button type="button" class="history-item" data-session="${escapeHtml(session.id)}" title="${escapeAttribute(session.title || '')}">
          <strong>${escapeHtml(session.title || '新聊天')}</strong>
          <span>${escapeHtml(shortTime(session.updatedAt))}</span>
        </button>
        <button type="button" class="history-more" data-action="toggle-history-menu" data-session-id="${escapeHtml(session.id)}" title="More">...</button>
        ${
          state.historyMenuId === session.id
            ? `<div class="history-menu">
                <button type="button" data-action="history-edit" data-session-id="${escapeHtml(session.id)}"><span class="history-menu-icon">&#9998;</span>Edit</button>
                <button type="button" data-action="history-export" data-session-id="${escapeHtml(session.id)}"><span class="history-menu-icon">&#8681;</span>Export</button>
                <button type="button" class="danger" data-action="history-delete" data-session-id="${escapeHtml(session.id)}"><span class="history-menu-icon">&#128465;</span>Delete</button>
              </div>`
            : ''
        }
      </div>
    `)
    .join('')

  const modelPresets = presetsForCurrentModel()
  const visiblePresets = modelPresets.names.slice(0, 60)
  const currentName = state.preset || ''
  const presetItems = visiblePresets.length
    ? visiblePresets.map(name => `
        <button type="button" class="item ${name === currentName ? 'on' : ''}" data-action="preset-load" data-preset-name="${escapeAttribute(name)}" title="${escapeAttribute(name)}">
          <span class="dot"></span>
          <span class="nm">${escapeHtml(name)}</span>
        </button>`).join('')
    : `<div class="side-empty">${modelPresets.filtered
        ? '这个模型还没有预设'
        : '还没有预设'}</div>`

  // 列表尾部：新建预设入口（复用既有的 preset-save 动作与对话框，
  // 对话框会按当前模型给出建议名，所以这里不用额外预填逻辑）。
  const presetFooter = `
    <button type="button" class="item side-item-add" data-action="preset-save" title="按当前模型与参数新建预设">
      <span class="plus">+</span>
      <span class="nm">新建预设</span>
    </button>
    ${modelPresets.filtered && modelPresets.matched === 0
      ? `<button type="button" class="item side-item-add side-item-stable" data-action="open-stable-preset" title="按本机显存与模型头部信息算一份能跑起来的参数">
          <span class="plus">&#9881;</span>
          <span class="nm">按硬件生成稳定预设</span>
        </button>`
      : ''}`

  return `
    <aside class="side">
      <div class="side-head">
        <h3>预设配置</h3>
        <button type="button" class="collapse-btn" data-action="toggle-sidebar" title="${state.sidebarCollapsed ? '展开侧栏' : '收起侧栏'}">${state.sidebarCollapsed ? '&#9654;' : '&#9664;'}</button>
      </div>
      <div class="side-list">
        ${presetItems}
        ${presetFooter}
        <div class="side-head" style="padding:14px 6px 8px"><h3>对话历史</h3></div>
        <input class="history-search" data-history-search placeholder="搜索对话..." value="${escapeHtml(state.historySearch)}" />
        <div class="history-list">
          ${sessions || '<div class="side-empty">还没有历史对话</div>'}
        </div>
      </div>
      <div class="side-foot">
        <button type="button" class="sbtn" data-action="new-chat">+ 新对话</button>
        <button type="button" class="sbtn" data-action="toggle-settings">&#9881; 设置</button>
      </div>
    </aside>
  `
}

function renderAttachmentChips(attachments, removable, role = 'composer') {
  if (!attachments || attachments.length === 0) {
    return ''
  }
  const mode = role === 'user' ? 'message-user' : removable ? 'composer' : 'message'

  return `
    <div class="attachment-row ${role === 'user' ? 'message-attachment-row' : ''}">
      ${attachments.map((item, index) => renderAttachmentItem(item, index, removable, mode)).join('')}
    </div>
  `
}

function renderTerminalPanel() {
  const terminalView = visibleTerminalLogs()
  const logs = terminalView.entries
  const logRows = logs.length
    ? logs.map(entry => `<div class="terminal-line">${escapeHtml(entry.line)}</div>`).join('')
    : '<div class="terminal-line terminal-muted">等待服务输出…</div>'
  const stats = state.logs || {}
  const terminalTab = state.terminalTab || 'output'
  const tabSummary = terminalTab === 'full'
    ? '显示全部已保存的日志。'
    : terminalTab === 'error'
      ? '只显示错误日志。'
      : '显示服务的主要输出。'
  const diagnosis = terminalDiagnosis({ status: state.status, logs: state.logs, terminalView })
  // 分项计数（过滤/排除/截断/丢弃）留在「复制诊断」的包里，
  // 界面上只在真的发生时给一句人话。数字为 0 就不占位。
  const ignoredCount = Number(stats.filtered || 0) + Number(terminalView.excluded || 0)
  const trimmedCount = Number(terminalView.hidden || 0) + Number(stats.truncated || 0) + Number(stats.dropped || 0)
  const lastMeaningfulEvent = logs.length
    ? logs[logs.length - 1].line
    : state.status?.message || '暂无终端输出'

  return `
    <section class="terminal-screen">
      <div class="terminal-head">
        <div>
          <span>终端日志</span>
          <strong>本地服务输出</strong>
        </div>
        <button type="button" class="outline-btn" data-action="return-chat">回到聊天</button>
      </div>
      <div class="term-tabs">
        <button type="button" class="term-tab ${terminalTab === 'output' ? 'on' : ''}" data-action="terminal-tab" data-terminal-tab="output">输出日志</button>
        <button type="button" class="term-tab ${terminalTab === 'full' ? 'on' : ''}" data-action="terminal-tab" data-terminal-tab="full">完整日志</button>
        <button type="button" class="term-tab ${terminalTab === 'error' ? 'on' : ''}" data-action="terminal-tab" data-terminal-tab="error">错误日志</button>
      </div>
      <div class="terminal-diagnostic terminal-diagnostic-${escapeAttribute(diagnosis.risk)}">
        <div class="terminal-diagnostic-main">
          <span>诊断摘要</span>
          <strong>${escapeHtml(diagnosis.label)}</strong>
          <em>${escapeHtml(diagnosis.detail)}</em>
        </div>
        <div class="terminal-diagnostic-meta">
          <div>
            <span>最近事件</span>
            <strong>${escapeHtml(lastMeaningfulEvent)}</strong>
          </div>
          <div>
            <span>下一步</span>
            <strong>${escapeHtml(diagnosis.nextAction)}</strong>
          </div>
        </div>
        <button type="button" class="outline-btn small-btn" data-action="copy-terminal-diagnostics">复制诊断</button>
      </div>
      <div class="terminal-summary">
        <span>${tabSummary}</span>
        ${ignoredCount ? `<strong class="log-stat">已忽略 ${ignoredCount} 条无关输出</strong>` : ''}
        ${trimmedCount ? `<strong class="log-stat">日志较多，仅显示最近 ${TERMINAL_VIEW_LOG_LIMIT} 行</strong>` : ''}
      </div>
      <div class="terminal-detail-label">日志明细</div>
      <div class="terminal-console" id="inlineLogBox">${logRows}</div>
    </section>
  `
}

function renderPreviewModal() {
  if (!state.preview) return ''
  const previewType = state.preview.type || 'code'
  const code = state.preview.code || ''
  const language = state.preview.language || 'html'
  const srcdoc = canPreviewCode(language, code)
    ? code
    : `<pre style="font: 14px/1.6 Consolas, monospace; white-space: pre-wrap;">${escapeHtml(code)}</pre>`
  const body = previewType === 'image'
    ? `
      <div class="preview-image-wrap">
        <img src="${escapeAttribute(state.preview.src || '')}" alt="${escapeAttribute(state.preview.title || '图片预览')}" />
      </div>
    `
    : `<iframe sandbox="allow-scripts allow-same-origin" srcdoc="${escapeAttribute(srcdoc)}"></iframe>`

  return `
    <div class="preview-backdrop" data-action="close-preview"></div>
    <section class="preview-panel">
      <div class="preview-head">
        <div>
          <span>预览</span>
          <strong>${escapeHtml(state.preview.title || (previewType === 'image' ? '图片预览' : language.toUpperCase()))}</strong>
        </div>
        <button type="button" class="icon-btn" data-action="close-preview">X</button>
      </div>
      ${body}
    </section>
  `
}

function renderHistoryDialog() {
  if (!state.historyDialog) return ''
  const session = state.sessions.find(item => item.id === state.historyDialog.sessionId)
  if (!session) return ''
  const title = session.title || '新聊天'

  if (state.historyDialog.type === 'edit') {
    return `
      <div class="dialog-backdrop" data-action="close-history-dialog"></div>
      <section class="history-dialog">
        <h2>编辑对话名称</h2>
        <input data-history-title-input value="${escapeAttribute(title)}" />
        <div class="dialog-actions">
          <button type="button" class="outline-btn" data-action="close-history-dialog">取消</button>
          <button type="button" class="primary-btn" data-action="history-save-title" data-session-id="${escapeHtml(session.id)}">保存</button>
        </div>
      </section>
    `
  }

  return `
    <div class="dialog-backdrop" data-action="close-history-dialog"></div>
    <section class="history-dialog">
      <h2><span class="danger-glyph">&#128465;</span>删除对话</h2>
      <p>你确定要删除“${escapeHtml(title)}”吗？此操作无法撤销，且会永久删除本次对话中的所有信息。</p>
      <div class="dialog-actions">
        <button type="button" class="outline-btn" data-action="close-history-dialog">取消</button>
        <button type="button" class="danger-solid-btn" data-action="history-confirm-delete" data-session-id="${escapeHtml(session.id)}">删除</button>
      </div>
    </section>
  `
}

function renderModelInfoModal() {
  if (!state.modelInfoOpen) return ''

  const info = state.modelInfo || {}
  const { rows, runtimeRows, templateText } = buildBetterModelInfoRows(info)
  const capability = modelCapability({ config: state.config || {}, modelInfo: info })
  const multimodal = multimodalAdvice({ config: state.config || {}, validation: state.validation || {} })
  const capabilityRows = buildCapabilityRows(info, capability)
  const body = info.loading
    ? '<div class="model-info-empty">正在读取当前模型信息...</div>'
    : info.error
      ? `<div class="model-info-empty error">${escapeHtml(info.error)}</div>`
      : `
        <div class="model-info-columns">
          <div class="model-info-card">
            <div class="model-template-head compact-head"><span>模型信息</span></div>
            <div class="model-info-grid">
              ${rows
                .map(row => `
                  <div class="model-info-row">
                    <span>${escapeHtml(row.label)}</span>
                    <strong title="${escapeAttribute(row.value)}">${escapeHtml(row.value)}</strong>
                    ${row.copy ? `<button type="button" class="icon-copy-btn" data-action="copy-model-info" data-copy="${escapeAttribute(row.copy)}" title="复制">${renderCopyIcon()}</button>` : '<div></div>'}
                  </div>
                `)
                .join('')}
            </div>
          </div>
          <div class="model-info-card">
            <div class="model-template-head compact-head"><span>本地运行参数</span></div>
            <div class="model-info-grid">
              ${runtimeRows
                .map(row => `
                  <div class="model-info-row">
                    <span>${escapeHtml(row.label)}</span>
                    <strong title="${escapeAttribute(row.value)}">${escapeHtml(row.value)}</strong>
                    ${row.copy ? `<button type="button" class="icon-copy-btn" data-action="copy-model-info" data-copy="${escapeAttribute(row.copy)}" title="复制">${renderCopyIcon()}</button>` : '<div></div>'}
                  </div>
                `)
                .join('')}
            </div>
          </div>
          <div class="model-info-card model-capability-card">
            <div class="model-template-head compact-head">
              <span>模型能力</span>
              <span class="capability-badge ${escapeHtml(capability.risk)}">${escapeHtml(capability.label)}</span>
            </div>
            <div class="model-info-grid">
              ${capabilityRows
                .map(row => `
                  <div class="model-info-row">
                    <span>${escapeHtml(row.label)}</span>
                    <strong title="${escapeAttribute(row.value)}">${escapeHtml(row.value)}</strong>
                    <div></div>
                  </div>
                `)
                .join('')}
            </div>
            <p class="capability-detail">${escapeHtml(capability.detail)}</p>
            <p class="capability-detail">${escapeHtml(`${multimodal.title}：${multimodal.action}`)}</p>
          </div>
        </div>
        <div class="model-template-card">
          <div class="model-template-head">
            <span>聊天模板</span>
            <button type="button" class="outline-btn small-btn" data-action="copy-model-info" data-copy="${escapeAttribute(templateText)}">复制</button>
          </div>
          <pre>${escapeHtml(templateText)}</pre>
        </div>
      `

  return `
    <div class="dialog-backdrop" data-action="close-model-info"></div>
    <section class="model-info-panel">
      <div class="model-info-head">
        <div>
          <span>模型信息</span>
          <strong>当前模型细节与本地运行参数</strong>
        </div>
        <button type="button" class="icon-btn" data-action="close-model-info">&times;</button>
      </div>
      <div class="model-info-body">${body}</div>
    </section>
  `
}

// ============================================================
// 主区参数面板 —— 结构/视觉对齐 prototype/layout-demo.html
//
// 契约：下面每个 field 都必须真实存在于主进程 defaultConfig()。
// 原型里的 type_k / type_v / kv_out_size / rope_freq_base / num_lora / mirostat
// 在本应用没有对应配置键，故「显存 & KV」「高级」两段改用语义等价的真实字段，
// 其余两段与原型字段一一对应（temperature→temp、gpu_layers→n_gpu_layers 为改名）。
// ============================================================
const PARAM_PANEL_SECTIONS = [
  {
    id: 'gen',
    tab: '生成控制',
    title: '生成控制 (Temperature/TopK/TopP/去重)',
    rows: [
      {
        field: 'temp', label: 'Temperature', min: 0, max: 2, step: 0.05,
        tip: {
          t: 'Temperature (随机性)',
          d: '控制模型输出的随机程度。值越低回答越确定，值越高越天马行空。',
          r: '推荐值: 0.7 (对话) | 0.0 (事实问答) | 1.0 (创意写作)',
        },
      },
      {
        field: 'top_k', label: 'Top-K', min: 0, max: 200, step: 1,
        tip: {
          t: 'Top-K 采样',
          d: '只考虑概率最高的 K 个词。值越大模型选择面越广。',
          r: '推荐值: 40-80 (平衡) | 10-20 (专注) | 0 (不过滤)',
        },
      },
      {
        field: 'top_p', label: 'Top-P (核采样)', min: 0, max: 1, step: 0.01,
        tip: {
          t: 'Top-P (核采样)',
          d: '只累积概率达到 P 的词。P 越大模型选择面越广。',
          r: '推荐值: 0.95 (默认) | 0.8-0.9 (专注) | 1.0 (发散)',
        },
      },
      {
        field: 'min_p', label: 'Min-P', min: 0, max: 1, step: 0.01,
        tip: {
          t: 'Min-P 采样',
          d: '按最高概率的一个比例来裁剪候选词，比 Top-P 更不容易跑偏。',
          r: '推荐值: 0.05-0.1 | 0 (关闭)',
        },
      },
      {
        field: 'repeat_penalty', label: '重复惩罚 (Repeat Penalty)', min: 0, max: 2, step: 0.01,
        tip: {
          t: '重复惩罚',
          d: '越高越抑制重复用词。过高会让语句变得不自然。',
          r: '推荐值: 1.0-1.15 | 长文生成可略高',
        },
      },
      {
        field: 'presence_penalty', label: '存在惩罚 (Presence)', min: 0, max: 2, step: 0.01,
        tip: {
          t: '存在惩罚',
          d: '只要出现过就惩罚，鼓励模型引入新话题。',
          r: '推荐值: 0 (默认) | 0.3-0.6 (减少复读)',
        },
      },
    ],
  },
  {
    id: 'ctx',
    tab: '上下文',
    title: '上下文 & 批处理 (ctx_size/gpu_layers/threads)',
    rows: [
      {
        field: 'ctx_size', label: '上下文长度 (ctx_size)', min: 512, max: 262144, step: 512,
        tip: {
          t: '上下文窗口',
          d: '一次能记住多少 token。越大越吃显存，8GB 卡要谨慎。',
          r: '推荐值: 8192 (8GB) | 16384-32768 (12GB+)',
        },
      },
      {
        field: 'n_gpu_layers', label: 'GPU 层数 (gpu_layers)', min: 0, max: 999, step: 1,
        tip: {
          t: '卸载到 GPU 的层数',
          d: '99 表示全部卸载。显存不足时会启动失败或回落到 CPU。',
          r: '推荐值: 99 (全卸载) | 不够显存就逐档下调',
        },
      },
      {
        field: 'threads', label: 'CPU 线程 (threads)', min: 0, max: 128, step: 1,
        tip: {
          t: 'CPU 线程数',
          d: '留空由 llama.cpp 自动决定，通常是最优解。',
          r: '推荐值: 留空自动 | 手动一般取物理核心数',
        },
      },
      {
        field: 'batch_size', label: '批大小 (batch_size)', min: 0, max: 8192, step: 64,
        tip: {
          t: '逻辑批大小',
          d: '一次处理的 token 批量。越大越快但越吃显存。',
          r: '推荐值: 512 (稳妥) | 1024-2048 (显存充裕)',
        },
      },
      {
        field: 'ubatch_size', label: '微批大小 (ubatch_size)', min: 0, max: 2048, step: 32,
        tip: {
          t: '物理微批大小',
          d: '真正一次进显存的批量，直接影响显存峰值。',
          r: '推荐值: 128 (8GB 稳妥) | 512 (显存充裕)',
        },
      },
      {
        field: 'n_predict', label: '最大生成长度 (n_predict)', min: -1, max: 65536, step: 1,
        tip: {
          t: '单次最大生成 token',
          d: '-1 表示不限制，由模型自行停止。',
          r: '推荐值: -1 (自动) | 需要控长时设上限',
        },
      },
    ],
  },
  {
    id: 'mem',
    tab: '显存 & KV',
    title: '显存 & KV 缓存 (type_k/type_v/kv_out_size/LoRA)',
    rows: [
      {
        field: 'type_k', label: '缓存 K (type_k)', kind: 'select',
        // 占位：真正的选项列表在渲染时按当前引擎生成（见 renderParamRow）。
        options: [{ value: '', label: '默认 (不指定)' }],
        tip: {
          t: 'KV 缓存 K 数据类型',
          d: '压掉 K 缓存的精度来换显存。可选项按当前引擎实测能力给出：llama.cpp / PrismML 支持 f32/f16/bf16/q8_0/q5_1/q5_0/q4_1/q4_0/iq4_nl。',
          r: '推荐值: f16 (平衡) | q8_0 (省显存) | q4_0 (最省显存，质量损失明显)',
        },
      },
      {
        field: 'type_v', label: '缓存 V (type_v)', kind: 'select',
        options: [{ value: '', label: '默认 (不指定)' }],
        tip: {
          t: 'KV 缓存 V 数据类型',
          d: 'V 缓存量化通常比 K 更伤质量，显存够就保持 f16。KVMem 引擎的 V 缓存只支持 q8_0 / q5_0 / q4_0，其余档位会置灰。',
          r: '推荐值: f16 (平衡) | q8_0 (省显存) | q4_0 (最省显存)',
        },
      },
      {
        field: 'kv_out_size', label: 'KV 上限 (kv_out_size)', min: 0, max: 32768, step: 256, fallback: 0,
        tip: {
          t: 'KV 上限（每并行槽上下文上限）',
          d: '对应 --kv-unified-per-slot。0 = 不设，行为与默认一致。',
          r: '推荐值: 0 (自动) | 4096 (显存大) | 2048 (更省)',
        },
      },
      {
        field: 'rope_freq_base', label: 'Rope Frequency Base', min: 100, max: 100000, step: 100, fallback: 10000,
        tip: {
          t: 'RoPE 频率基数',
          d: 'NTK 外推用。改动会影响长上下文表现，非必要别动。',
          r: '推荐值: 10000 (默认) | 100000 (极长上下文)',
        },
      },
      {
        field: 'num_lora', label: 'Num LoRA', min: 0, max: 32, step: 1, fallback: 0,
        tip: {
          t: 'LoRA 适配器数量',
          d: '从下方「LoRA 路径」里按顺序取前 N 个加载。0 = 不加载。',
          r: '推荐值: 0 (不用) | 1 (单 LoRA) | 2+ (多 LoRA 切换)',
        },
      },
      {
        field: 'lora_paths', label: 'LoRA 路径（逗号分隔）', kind: 'text',
        tip: {
          t: 'LoRA 适配器路径',
          d: '多个用逗号分隔。实际加载几个由上面的 Num LoRA 决定。',
          r: '示例: D:/lora/a.gguf,D:/lora/b.gguf',
        },
      },
      {
        field: 'split_mode', label: '多卡切分模式', kind: 'select', options: ['', 'layer', 'row', 'none'],
        tip: {
          t: 'Split mode',
          d: '多 GPU 时按层切分还是按行切分。单卡无影响。',
          r: '推荐值: layer (默认) | 单卡可留空',
        },
      },
      {
        field: 'tensor_split', label: '张量切分比例', kind: 'text',
        tip: {
          t: 'Tensor split',
          d: '多卡各自分到的比例，逗号分隔。单卡留空。',
          r: '示例: 0.7,0.3 | 单卡留空',
        },
      },
      {
        field: 'main_gpu', label: '主 GPU (main_gpu)', min: 0, max: 16, step: 1,
        tip: {
          t: '主 GPU 编号',
          d: '指定用哪块卡作为主设备。单卡留空。',
          r: '推荐值: 留空 (自动) | 多卡填 0/1/…',
        },
      },
      {
        field: 'device', label: '设备 (device)', kind: 'text',
        tip: {
          t: '设备指定',
          d: '强制使用某类后端设备，一般留空由 llama.cpp 决定。',
          r: '推荐值: 留空',
        },
      },
      {
        field: 'mlock', label: '锁定内存 (mlock)', kind: 'toggle',
        tip: {
          t: 'mlock（锁定内存）',
          d: '把模型钉在物理内存里，避免被换出或压缩。内存不够时不要开。本 build 已标记 DEPRECATED，推荐改用 --load-mode。',
          r: '推荐值: 关 | 内存充足且在意换页时开',
        },
      },
      {
        field: 'no_map', label: '禁用 mmap (no_map)', kind: 'toggle',
        tip: {
          t: 'no-mmap（禁用内存映射）',
          d: '加载更慢，但在不用 mlock 时能减少 pageout。与「启用 mmap」互斥，本项优先。',
          r: '推荐值: 关 | 机械盘或内存紧张时可试',
        },
      },
    ],
  },
  {
    id: 'adv',
    tab: '高级',
    title: '高级选项 (Mirostat / MoE / embeddings / 日志)',
    rows: [
      {
        field: 'mirostat', label: 'Mirostat', kind: 'select',
        options: [
          { value: '', label: '关 (默认)' },
          { value: '1', label: 'v1 (Mirostat)' },
          { value: '2', label: 'v2 (Mirostat 2.0)' },
        ],
        tip: {
          t: 'Mirostat (自适应采样)',
          d: '开启后会接管 Top-K / Top-P / 典型采样。留空即关闭（llama.cpp 默认 0）。',
          r: '关 (默认) | v1 (经典) | v2 (更快收敛)',
        },
      },
      {
        field: 'cpu_moe', label: 'MoE 卸载到 CPU', kind: 'toggle',
        tip: {
          t: 'CPU MoE',
          d: '把 MoE 专家层放 CPU，省显存但会更慢。',
          r: '推荐值: 关 | 显存吃紧的 MoE 模型可开',
        },
      },
      {
        field: 'embeddings', label: '启用 embeddings', kind: 'toggle',
        tip: {
          t: 'Embeddings 接口',
          d: '开启后 /v1/embeddings 可用，可做向量检索。',
          r: '推荐值: 关 (纯对话) | 需要 RAG 时开',
        },
      },
      {
        field: 'continuous_batching', label: '连续批处理', kind: 'toggle',
        tip: {
          t: 'Continuous batching',
          d: '并发请求时动态合批，多用户场景吞吐更好。',
          r: '推荐值: 开 (默认)',
        },
      },
      {
        field: 'flash_attn', label: 'Flash Attention', kind: 'toggle',
        tip: {
          t: 'Flash Attention',
          d: '开 = 强制 --flash-attn on；关 = 不传该参数，交给引擎 auto 决定（默认 auto）。',
          r: '推荐值: 关 (auto) | 确认显卡支持时可强制 on',
        },
      },
      {
        field: 'no_perf', label: '关闭性能计时 (no_perf)', kind: 'toggle',
        tip: {
          t: 'libllama 内部计时',
          d: '关掉内部性能计时可以略微降低开销。KVMem 引擎不支持该项。',
          r: '推荐值: 关 | 追求极低开销时开',
        },
      },
      {
        field: 'use_mmap', label: '启用 mmap (use_mmap)', kind: 'toggle',
        tip: {
          t: 'mmap（内存映射加载）',
          d: '与「禁用 mmap」互斥；若同时也开了「禁用 mmap」，以那一项为准。',
          r: '推荐值: 跟随引擎默认 | 需要显式启用时开',
        },
      },
      {
        field: 'verbose', label: '详细日志 (verbose)', kind: 'toggle',
        tip: {
          t: 'Verbose',
          d: '让 llama-server 输出更啰嗦的日志，排查问题时用。',
          r: '推荐值: 关 | 排查启动失败时开',
        },
      },
    ],
  },
]

function paramTipHtml(tip) {
  if (!tip) return ''
  return `<span class="tip-icon">?</span>
    <div class="tip-popup">
      <div class="tp-title">${escapeHtml(tip.t)}</div>
      <div class="tp-desc">${escapeHtml(tip.d)}</div>
      <div class="tp-recommended">${escapeHtml(tip.r)}</div>
    </div>`
}

function renderParamRow(row) {
  const value = state.config?.[row.field]
  const blocked = engineBlockedKeys().includes(row.field)
  const label = `<div class="param-label">${escapeHtml(row.label)}${paramTipHtml(row.tip)}</div>`

  if (row.kind === 'toggle') {
    const on = Boolean(value)
    return `
      <div class="param-row">
        ${label}
        <div class="param-control">
          <label class="param-toggle ${on ? 'on' : ''}">
            <input type="checkbox" data-field="${row.field}" ${on ? 'checked' : ''} ${blocked ? 'disabled' : ''} />
            <span class="knob"></span>
          </label>
        </div>
      </div>`
  }

  if (row.kind === 'select') {
    const currentValue = value === undefined || value === null ? '' : String(value)
    // KV 缓存类型不是固定四个选项：各引擎认的档位不同（实测 --help）。
    // 这里按当前引擎生成，并把引擎不认的档标注出来，而不是让用户选完启动失败。
    const kvField = row.field === 'type_k' ? 'k' : row.field === 'type_v' ? 'v' : ''
    const kvEngine = kvField ? currentEngineId() : ''
    const kvTable = kvField ? engineCacheTypes(kvEngine)[kvField] : []
    const kvOptions = kvField
      ? [
          { value: '', label: '默认 (不指定)' },
          // 配置里已经存着、但当前引擎不认的档位也要列出来，
          // 否则下拉会找不到匹配项而显示成空白，用户看不出自己到底配了什么。
          ...(currentValue && !kvTable.includes(currentValue)
            ? [{ value: currentValue, label: `${currentValue} (当前引擎不支持)`, disabled: true }]
            : []),
          ...kvTable.map(type => ({
            value: type,
            label: type + (type === 'f16' ? ' (推荐)' : type === 'f32' ? ' (最高精度)' : ''),
            // 引擎能力表已经决定了可选集合，这里的置灰是给「已存在的非法值」留的；
            // 两者都不满足时不允许选中，避免选完才在启动阶段被引擎拒绝。
            disabled: !cacheTypeSupported(kvEngine, kvField, type),
          })),
        ]
      : row.options
    const options = kvOptions
      .map(opt => {
        const isObj = opt !== null && typeof opt === 'object'
        const optValue = String(isObj ? opt.value : opt)
        const optLabel = isObj ? opt.label : (opt || '默认')
        const optBlocked = isObj && opt.disabled ? ' disabled' : ''
        return `<option value="${escapeHtml(optValue)}" ${optValue === currentValue ? 'selected' : ''}${optBlocked}>${escapeHtml(optLabel)}</option>`
      })
      .join('')
    return `
      <div class="param-row">
        ${label}
        <div class="param-control">
          <select class="param-select" data-field="${row.field}" ${blocked ? 'disabled' : ''}>${options}</select>
        </div>
      </div>`
  }

  if (row.kind === 'text') {
    return `
      <div class="param-row">
        ${label}
        <div class="param-control">
          <input class="param-input" style="width:100%;text-align:left" type="text" data-field="${row.field}" value="${escapeAttribute(value ?? '')}" ${blocked ? 'disabled' : ''} />
        </div>
      </div>`
  }

  // 未设置时显示业务默认（如 rope_freq_base 回退 10000），而不是滑条下限。
  const rawValue = String(value ?? '').trim()
  const current = rawValue !== '' && Number.isFinite(Number(rawValue))
    ? Number(rawValue)
    : (row.fallback !== undefined ? row.fallback : row.min)
  return `
    <div class="param-row">
      ${label}
      <div class="param-control">
        <input type="range" class="param-slider" min="${row.min}" max="${row.max}" step="${row.step}" value="${current}" data-param="${row.field}" ${blocked ? 'disabled' : ''} />
        <input type="number" class="param-input" min="${row.min}" max="${row.max}" step="${row.step}" value="${current}" data-param="${row.field}" data-field="${row.field}" ${blocked ? 'disabled' : ''} />
      </div>
    </div>`
}

function renderParamPanel() {
  const active = state.paramTab || PARAM_PANEL_SECTIONS[0].id
  const tabs = PARAM_PANEL_SECTIONS
    .map(sec => `<button type="button" class="pt ${sec.id === active ? 'on' : ''}" data-action="param-tab" data-param-tab="${sec.id}">${escapeHtml(sec.tab)}</button>`)
    .join('')
  const sections = PARAM_PANEL_SECTIONS
    .map(sec => `
      <div class="param-section" id="sec-${sec.id}"${sec.id === active ? '' : ' style="display:none"'}>
        <h4>${escapeHtml(sec.title)}</h4>
        ${sec.rows.map(renderParamRow).join('')}
      </div>`)
    .join('')

  // 引擎不支持的参数在面板里是置灰的，这里给一句总的解释，
  // 免得用户只看到「点了没反应」。（原设置页那条提示随页签一起去掉了。）
  const blockedLabels = engineBlockedLabels()

  // KV 量化档位选错时，原本要等启动被引擎拒绝才发现，这里提前说清楚。
  const kvIssues = cacheTypeIssues(state.config || {})

  return `
    <div class="param-panel">
      <div class="param-tabs">${tabs}</div>
      <div class="param-body">
        ${blockedLabels.length
          ? `<div class="param-engine-warning">当前引擎不支持 ${escapeHtml(blockedLabels.join('、'))}，相关参数已置灰。</div>`
          : ''}
        ${kvIssues.map(issue => `
          <div class="param-engine-warning param-kv-note ${escapeHtml(issue.level)}">${escapeHtml(issue.message)}</div>
        `).join('')}
        ${sections}
      </div>
    </div>
  `
}

function renderChat() {
  const cancelling = Boolean(assistantForRequest(state.streamRequestId)?.cancelRequested)
  const isEmptyChat = state.chatMessages.length === 0
  // 首次用过（起过服务 / 发过消息 / 关过向导）之后就不再占用主区。
  const isSetupOnboarding = isEmptyChat
    && !state.onboardingDone
    && state.status.state !== 'running'
    && !state.chatBusy
  const messages = state.chatMessages.length
    ? state.chatMessages
        .map((message, index) => {
          const content = renderMessageContent(message, index)
          const attachments = renderAttachmentChips(message.attachments || [], false, message.role)
          const body = message.role === 'user'
            ? `
              ${attachments}
              ${content ? `<div class="bubble">${content}</div>` : ''}
            `
            : `
              <div class="bubble">
                ${content}
              </div>
              ${attachments}
            `

          return `
            <article class="message ${escapeHtml(message.role)}" data-message-index="${index}">
              <div class="avatar">${message.role === 'user' ? '你' : message.role === 'assistant' ? 'll' : 'sys'}</div>
              <div class="message-body">
                ${body}
                ${renderMessageMeta(message)}
                ${renderMessageActions(index, message)}
              </div>
            </article>
          `
        })
        .join('')
    : `
      <div class="empty-state">
        ${renderOnboardingActionPanel(isSetupOnboarding)}
      </div>
    `
  const composer = isSetupOnboarding
    ? ''
    : `
      <div class="composer-wrap">
        ${renderReadinessStrip()}
        ${renderAttachmentChips(state.attachments, true, 'composer')}
        <div class="composer">
          <div class="attach-wrap">
            <button class="round-btn" type="button" data-action="toggle-attachment-menu" title="添加内容">+</button>
          </div>
          <textarea data-chat-input spellcheck="false" placeholder="输入一条消息……">${escapeHtml(state.chatInput)}</textarea>
          <button class="model-chip model-trigger" type="button" data-action="open-model-info" title="${escapeHtml(state.config?.model || '')}">
            <span class="model-chip-icon">${renderModelChipIcon()}</span>
            <span class="model-chip-label">${escapeHtml(modelName())}</span>
          </button>
          ${state.chatBusy
            ? `<button class="send-btn stop-chat" type="button" data-action="cancel-chat" title="停止生成" aria-label="停止生成" ${cancelling ? 'disabled' : ''}><span class="stop-icon"></span></button>`
            : '<button class="send-btn" type="button" data-action="send-chat" title="发送" aria-label="发送">↑</button>'}
        </div>
        <div class="composer-hint">按住 Enter 发送，Shift + Enter 换行</div>
      </div>
    `

  return `
    <section class="chat-screen ${isEmptyChat ? 'empty-chat' : ''} ${isSetupOnboarding ? 'setup-onboarding' : ''} ${state.draggingFiles ? 'drag-over' : ''}" data-drop-zone="chat">
      <div class="chat-feed" id="chatFeed">${messages}</div>
      ${composer}
      ${state.draggingFiles ? '<div class="chat-drop-overlay"><strong>松手添加文件</strong><span>图片、音频、PDF、文本和其他文件都会进入当前消息附件。</span></div>' : ''}
    </section>
  `
}

function attachmentMenuItems() {
  return renderAttachmentMenu(undefined, escapeHtml)
}

function renderAttachmentMenuPortal() {
  if (!state.attachmentMenuOpen) return ''
  const fallback = { left: 0, top: 0 }
  const position = state.attachmentMenuPosition || fallback
  return `
    <div class="attach-menu-backdrop" data-action="close-attachment-menu"></div>
    <div class="attach-menu floating" style="left: ${Number(position.left) || 0}px; top: ${Number(position.top) || 0}px;">
      ${attachmentMenuItems()}
    </div>
  `
}

function openAttachmentMenu(button) {
  const rect = button.getBoundingClientRect()
  const { left, top } = attachmentMenuPosition({
    triggerRect: rect,
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
  })

  state.attachmentMenuOpen = true
  state.attachmentMenuPosition = {
    left: Math.round(left),
    top: Math.round(top),
  }
}

function renderModernSettingsCard(title, text, body) {
  return `
    <section class="settings-stack-card">
      <header>
        <strong>${escapeHtml(title)}</strong>
        ${text ? `<span>${escapeHtml(text)}</span>` : ''}
      </header>
      ${body}
    </section>
  `
}

function renderOnboardingActionPanel(showRunCheck = false) {
  const guide = downloadGuidance()
  const repair = startupDiagnosis({
    config: state.config || {},
    validation: state.validation || {},
    status: state.status || {},
    dirty: state.dirty,
  })
  return `
    <div class="onboarding-action-panel">
      <div class="onboarding-primary">
        <div class="onboarding-copy">
          <span>Release Candidate · 本地验收版</span>
          <h1>把本地大模型跑起来</h1>
          <p>先选完整 llama.cpp 包和 GGUF 模型，再启动服务并检查端口。服务可用后，复制到第三方客户端。</p>
        </div>
        <div class="onboarding-status ${escapeHtml(repair.level)}">
          ${repairBadge(repair.level)}
          <strong>${escapeHtml(repair.title)}</strong>
          <em>${escapeHtml(repair.action)}</em>
        </div>
        ${showRunCheck ? `<div class="onboarding-run-check">${renderReadinessStrip()}</div>` : ''}
        <div class="onboarding-actions">
          <button type="button" class="primary-btn" data-action="open-downloads">官方下载</button>
          <button type="button" class="outline-btn" data-section="io">选择目录</button>
          <button type="button" class="outline-btn" data-action="open-first-run-wizard">启动向导</button>
          <button type="button" class="outline-btn" data-action="copy-feedback-bundle">复制诊断</button>
        </div>
      </div>
      <div class="onboarding-roadmap">
        <div class="onboarding-steps">
          ${['选择运行包', '选择 GGUF 模型', '检测硬件并推荐参数', '启动并检查端口', '复制到第三方客户端']
            .map((item, index) => `<div><span>${index + 1}</span><strong>${escapeHtml(item)}</strong></div>`)
            .join('')}
        </div>
        <p class="onboarding-footnote">${escapeHtml(guide.detail)}</p>
      </div>
    </div>
  `
}

function repairBadge(level, label) {
  const text = label || {
    good: '可用',
    ready: '就绪',
    normal: '提醒',
    pending: '待处理',
    warning: '注意',
    blocked: '阻塞',
  }[level] || level || '提醒'
  return `<span class="repair-badge ${escapeHtml(level || 'normal')}">${escapeHtml(text)}</span>`
}

function renderStartupRepairBox(diagnosis) {
  return `
    <div class="repair-hero ${escapeHtml(diagnosis.level)}">
      <div>
        ${repairBadge(diagnosis.level)}
        <strong>${escapeHtml(diagnosis.title)}</strong>
        <p>${escapeHtml(diagnosis.detail)}</p>
      </div>
      <em>${escapeHtml(diagnosis.action)}</em>
    </div>
  `
}

function renderFirstRunStepList(steps) {
  return `
    <div class="repair-step-list">
      ${steps
        .map((step, index) => `
          <div class="repair-step ${escapeHtml(step.state)}">
            <span>${index + 1}</span>
            <div>
              <strong>${escapeHtml(step.title)}</strong>
              <em>${escapeHtml(step.detail)}</em>
            </div>
            ${repairBadge(step.state)}
          </div>
        `)
        .join('')}
    </div>
  `
}

function renderPathSnapshot(config, validation) {
  const rows = [
    ['llama.cpp 原文件目录', validation.serverDir || config.llama_bin_dir || '未选择', validation.serverDirExists],
    ['llama-server.exe', config.llama_server_path || '未选择', validation.serverExists],
    ['GGUF 模型文件', config.model || '未选择', validation.modelExists],
    ['mmproj 投影文件', config.mmproj || '未选择', !config.mmproj || validation.mmprojExists],
  ]

  const missing = rows.filter(([, , ok]) => !ok).length
  const summary = missing ? `${missing} 项未找到` : '全部就绪'

  return `
    <div class="path-snapshot${state.pathSnapshotOpen ? ' open' : ''}">
      <button type="button" class="path-snapshot-toggle" data-action="toggle-path-snapshot">
        <span>文件路径</span>
        <strong>${summary}</strong>
        <em>${state.pathSnapshotOpen ? '收起' : '展开'}</em>
      </button>
      ${state.pathSnapshotOpen
        ? rows
            .map(([label, value, ok]) => `
              <div>
                <span>${escapeHtml(label)}</span>
                <code title="${escapeAttribute(value)}">${escapeHtml(value)}</code>
                ${pill(ok, '已找到', '未找到')}
              </div>
            `)
            .join('')
        : ''}
    </div>
    <div class="settings-inline-actions">
      <button type="button" class="outline-btn" data-section="overview">打开概述参数</button>
      <button type="button" class="outline-btn" data-section="display">打开模型设置</button>
      <button type="button" class="outline-btn" data-section="logs">打开日志</button>
    </div>
  `
}

function renderIntegrationRows(guide) {
  return `
    <div class="integration-grid">
      <div>
        <span>第三方客户端填写</span>
        <strong>OpenAI Base URL</strong>
        <code>${escapeHtml(guide.baseUrl)}</code>
      </div>
      <div>
        <span>不要填错成 Base URL 的场景</span>
        <strong>Chat Completions URL</strong>
        <code>${escapeHtml(guide.chatCompletionsUrl)}</code>
      </div>
      <div>
        <span>模型名</span>
        <strong>${escapeHtml(guide.modelName)}</strong>
        <code>API Key: ${escapeHtml(guide.apiKeyHint)}</code>
      </div>
    </div>
    <div class="settings-inline-actions">
      <button type="button" class="outline-btn" data-action="copy-integration-guide">复制第三方接入信息</button>
      <button type="button" class="outline-btn" data-action="health">检查端口</button>
    </div>
    <div class="settings-callout">Cherry Studio、Open WebUI、One API 等通常填 Base URL，也就是以 /v1 结尾的地址；/v1/chat/completions 是单个接口地址。</div>
  `
}

function renderPerformanceHintList(hints) {
  if (!hints.length) {
    return '<div class="repair-empty">暂无明显高风险参数。遇到卡顿时优先看终端日志和系统资源占用。</div>'
  }

  return `
    <div class="repair-hint-list">
      ${hints
        .map(hint => `
          <div class="repair-hint ${escapeHtml(hint.level)}">
            ${repairBadge(hint.level)}
            <div>
              <strong>${escapeHtml(hint.title)}</strong>
              <p>${escapeHtml(hint.detail)}</p>
              <em>${escapeHtml(hint.action)}</em>
            </div>
          </div>
        `)
        .join('')}
    </div>
  `
}

function renderEnvironmentIntegrityCard(integrity) {
  return `
    <div class="repair-hero ${escapeHtml(integrity.summary.level)}">
      <div>
        ${repairBadge(integrity.summary.level)}
        <strong>${escapeHtml(integrity.summary.title)}</strong>
        <p>${escapeHtml(integrity.summary.detail)}</p>
      </div>
      <em>${escapeHtml(integrity.summary.action)}</em>
    </div>
    <div class="repair-hint-list">
      ${integrity.rows
        .map(row => `
          <div class="repair-hint ${escapeHtml(row.state)}">
            ${repairBadge(row.state)}
            <div>
              <strong>${escapeHtml(row.label)}</strong>
              <p>${escapeHtml(row.detail)}</p>
              <em>${escapeHtml(row.action)}</em>
            </div>
          </div>
        `)
        .join('')}
    </div>
  `
}

function renderPortDiagnosisCard(diagnosis) {
  const checks = Array.isArray(diagnosis.checks) ? diagnosis.checks : []
  return `
    <div class="repair-hero ${escapeHtml(diagnosis.level)}">
      <div>
        ${repairBadge(diagnosis.level)}
        <strong>${escapeHtml(diagnosis.title)}</strong>
        <p>${escapeHtml(diagnosis.detail)}</p>
      </div>
      <em>${escapeHtml(diagnosis.action)}</em>
    </div>
    <div class="endpoint-checks">
      ${
        checks.length
          ? checks.map(check => `
              <div>
                <span>${escapeHtml(check.id || 'check')}</span>
                <code>${escapeHtml(check.url || '')}</code>
                ${pill(Boolean(check.ok), `HTTP ${check.status || 200}`, check.status ? `HTTP ${check.status}` : '失败')}
              </div>
            `).join('')
          : '<div><span>尚未检查</span><code>点击“检查端口”后显示 /v1/models 和 chat 路由结果。</code><span class="pill warn">待检查</span></div>'
      }
    </div>
  `
}

function renderRecommendationCard(recommendation) {
  return `
    <div class="recommendation-grid">
      <div><span>模型规模</span><strong>${escapeHtml(recommendation.sizeClass)}</strong></div>
      <div><span>ctx_size</span><strong>${escapeHtml(recommendation.profile.ctxSize)}</strong></div>
      <div><span>n_gpu_layers</span><strong>${escapeHtml(recommendation.profile.gpuLayers)}</strong></div>
      <div><span>batch_size</span><strong>${escapeHtml(recommendation.profile.batchSize)}</strong></div>
    </div>
    <div class="settings-callout">${escapeHtml(recommendation.reason)}</div>
    ${recommendation.warnings.length ? renderPerformanceHintList(recommendation.warnings.map((warning, index) => ({
      id: `recommendation-${index}`,
      level: 'warning',
      title: '推荐参数提醒',
      detail: warning,
      action: '先应用保守参数跑通，再逐步加大。',
    }))) : ''}
    <div class="settings-inline-actions">
      <button type="button" class="outline-btn" data-action="apply-recommended-params">应用推荐参数</button>
    </div>
  `
}

function renderSimpleRows(rows) {
  return `
    <div class="closure-rows">
      ${rows.map(row => `
        <div class="${escapeHtml(row.state || 'normal')}">
          <span>${escapeHtml(row.label || row.id)}</span>
          <strong>${escapeHtml(row.value || row.detail || row.action || '')}</strong>
          ${row.action ? `<em>${escapeHtml(row.action)}</em>` : ''}
        </div>
      `).join('')}
    </div>
  `
}

function renderPortRepairCard(plan) {
  return `
    <div class="repair-hero ${escapeHtml(plan.level)}">
      <div>
        ${repairBadge(plan.level)}
        <strong>${escapeHtml(plan.title)}</strong>
        <p>${escapeHtml(plan.detail)}</p>
      </div>
      <em>${escapeHtml(plan.action)}</em>
    </div>
    ${plan.processes?.length ? renderSimpleRows(plan.processes.map(item => ({
      id: `pid-${item.pid}`,
      label: `PID ${item.pid}`,
      value: item.name || 'unknown',
      action: item.state || item.localAddress || '',
    }))) : '<div class="settings-callout">还没有检测到占用进程；点击“检测端口占用”后显示本机线索。</div>'}
    <div class="settings-inline-actions">
      <button type="button" class="outline-btn" data-action="inspect-port">检测端口占用</button>
      <button type="button" class="outline-btn" data-action="apply-port-fix" ${plan.canApply ? '' : 'disabled'}>改用 ${escapeHtml(plan.suggestedPort || '')}</button>
    </div>
  `
}

function renderDownloadCard(guidance) {
  return `
    <div class="repair-hero warning">
      <div>
        ${repairBadge('warning', '手动确认')}
        <strong>${escapeHtml(guidance.title)}</strong>
        <p>${escapeHtml(guidance.detail)}</p>
      </div>
      <em>${escapeHtml(guidance.action)}</em>
    </div>
    <div class="settings-inline-actions">
      <button type="button" class="outline-btn" data-action="open-downloads">打开官方下载页</button>
      <button type="button" class="outline-btn" data-action="copy-download-guidance">复制下载说明</button>
    </div>
    ${renderSimpleRows(guidance.keywords.map(keyword => ({ label: '关键词', value: keyword })))}
  `
}

function renderClientSmokeCard(plan) {
  return `
    <div class="repair-hero ${escapeHtml(plan.level)}">
      <div>
        ${repairBadge(plan.level)}
        <strong>${escapeHtml(plan.title)}</strong>
        <p>${escapeHtml(plan.detail)}</p>
      </div>
      <em>${escapeHtml(plan.action)}</em>
    </div>
    <div class="command-preview compact">
      <pre>${escapeHtml(plan.templateText)}</pre>
      <button type="button" class="outline-btn small-btn" data-action="copy-integration-guide">复制</button>
    </div>
    <div class="settings-inline-actions">
      <button type="button" class="outline-btn" data-action="client-smoke-test">本机联调 smoke test</button>
    </div>
  `
}

// renderFeedbackCard() 已删除：它是「设置 → 启动救援 → 反馈入口」那张卡，
// 与「性能与卡顿风险」里的「复制支持诊断」（copy-support-bundle）功能重复，
// 两个按钮做同一件事，用户不知道该点哪个。
// 它用到的两个动作没有丢：open-downloads 仍在首次向导与「完整包下载」卡里，
// copy-feedback-bundle 的分发分支也保留（首次向导在用）。

// 启动救援：只保留「用户真的能据此动手」的卡片。
//
// 2026-09-29 瘦身（13 张 → 7 张），删掉/合并的原因：
//   · 反馈入口   —— 为「排查人员」准备的支持诊断卡，不是给用户的；
//   · 发布候选包 —— 发布工程清单（候选包/桌面入口/视觉验收/不 push 不 tag），
//                   与「我的服务为什么起不来」毫无关系，纯噪音；
//   · 模型能力库 —— 与「图片理解」回答同一个问题（这模型能不能看图），两卡并一卡。
// 另把「第三方接入 / 联调验证」「端口诊断 / 端口占用修复」「环境完整性 / 完整包下载」
// 各并成一张。
// 「复制支持诊断」按钮挪到「性能与卡顿风险」卡内，功能入口没有丢。
function renderRescueSettingsContent() {
  const config = state.config || {}
  const validation = state.validation || {}
  const repair = startupDiagnosis({ config, validation, status: state.status, dirty: state.dirty })
  const steps = firstRunSteps({ config, validation, status: state.status, dirty: state.dirty })
  const guide = integrationGuide({ config, status: state.status })
  const hints = performanceHints({ config })
  const multimodal = multimodalAdvice({ config, validation })
  const integrity = environmentIntegrity({ config, validation })
  const endpointDiagnosis = portDiagnosis(state.health || { ok: null, kind: 'unchecked', url: state.status?.url, message: '尚未检查端口' })
  const recommendation = modelRecommendation({ config })
  const download = downloadGuidance()
  const portRepair = portRepairPlan({ config, status: state.status, inspection: state.portInspection, health: state.health })
  const hardware = hardwareRecommendation({ config, systemInfo: state.systemInfo || {} })
  const clientPlan = clientSmokePlan({ config, status: state.status, smoke: state.clientSmoke })
  const capability = modelCapabilityCatalog({ config, modelInfo: state.modelInfo || {} })
  return `
    <div class="settings-stack rescue-stack">
      ${renderModernSettingsCard('启动救援', '把“为什么启动不了”和“下一步点哪里”集中到这一页。', `
        ${renderStartupRepairBox(repair)}
        ${renderPathSnapshot(config, validation)}
        ${renderFirstRunStepList(steps)}
        <div class="settings-inline-actions">
          <button type="button" class="outline-btn" data-action="open-first-run-wizard">重新打开首次启动向导</button>
        </div>
      `)}
      ${renderModernSettingsCard('环境完整性', '区分真正阻塞和只是需要留意的运行包问题。', `
        ${renderEnvironmentIntegrityCard(integrity)}
        ${renderDownloadCard(download)}
      `)}
      ${renderModernSettingsCard('端口', '先诊断再修复：不杀进程，优先切换到可用端口。', `
        ${renderPortDiagnosisCard(endpointDiagnosis)}
        ${renderPortRepairCard(portRepair)}
      `)}
      ${renderModernSettingsCard('本机硬件读数', 'CPU / 内存 / GPU 的实测读数与对应动作。上面的「参数推荐」才是结论。', `
        ${renderRecommendationCard(recommendation)}
        ${renderSimpleRows(hardware.rows)}
      `)}
      ${renderModernSettingsCard('第三方接入', '给 Cherry Studio、Open WebUI 等 OpenAI 兼容客户端使用。', `
        ${renderIntegrationRows(guide)}
        ${renderClientSmokeCard(clientPlan)}
      `)}
      ${renderModernSettingsCard('图片理解', '图片上传不等于模型一定能看图。', `
        <div class="repair-hero ${escapeHtml(multimodal.level)}">
          <div>
            ${repairBadge(multimodal.level)}
            <strong>${escapeHtml(multimodal.title)}</strong>
            <p>${escapeHtml(multimodal.detail)}</p>
          </div>
          <em>${escapeHtml(multimodal.action)}</em>
        </div>
        <div class="settings-callout">${escapeHtml(capability.title)} · ${escapeHtml(capability.action)}</div>
        ${renderSimpleRows(capability.rows)}
        <div class="settings-inline-actions">
          <button type="button" class="outline-btn" data-action="open-model-info">查看模型信息</button>
        </div>
      `)}
      ${renderModernSettingsCard('性能与卡顿风险', '把最常见的内存、显存、超时问题提前摊开。', `
        ${renderPerformanceHintList(hints)}
        <div class="settings-callout">如果启动像卡住，先降 ctx_size、n_gpu_layers 或 batch；需要进一步排查时，复制下面这份支持诊断。</div>
        <div class="settings-inline-actions">
          <button type="button" class="outline-btn" data-action="copy-support-bundle">复制支持诊断</button>
        </div>
      `)}
    </div>
  `
}

function renderFirstRunWizard() {
  if (!state.firstRunWizardOpen) return ''
  const config = state.config || {}
  const validation = state.validation || {}
  const integrity = environmentIntegrity({ config, validation })
  const endpointDiagnosis = portDiagnosis(state.health || { ok: null, kind: 'unchecked', url: state.status?.url, message: '尚未检查端口' })
  const recommendation = modelRecommendation({ config })
  const guide = integrationGuide({ config, status: state.status })
  return `
    <div class="dialog-backdrop first-run-backdrop" data-action="close-first-run-wizard"></div>
    <section class="first-run-panel">
      <div class="first-run-head">
        <div>
          <span>首次启动向导</span>
          <strong>按顺序跑通本地 llama.cpp 服务</strong>
        </div>
        <button type="button" class="icon-btn" data-action="close-first-run-wizard">&times;</button>
      </div>
      <div class="first-run-body">
        ${renderModernSettingsCard('1. 环境完整性', '先确认你选的是完整 llama.cpp 包，不是 cudart 运行库包。', renderEnvironmentIntegrityCard(integrity))}
        ${renderModernSettingsCard('2. 模型文件', '没有 GGUF 模型，端口启动了也无法聊天。', renderPathSnapshot(config, validation))}
        ${renderModernSettingsCard('3. 推荐参数', '先用保守参数跑通，不要一上来拉满上下文和 GPU 层数。', renderRecommendationCard(recommendation))}
        ${renderModernSettingsCard('4. 端口诊断', '启动后检查 OpenAI 兼容接口是否真的可用。', renderPortDiagnosisCard(endpointDiagnosis))}
        ${renderModernSettingsCard('5. 第三方接入', '复制到 Cherry Studio、Open WebUI 或其他 OpenAI 兼容客户端。', renderIntegrationRows(guide))}
      </div>
      <div class="first-run-foot">
        <button type="button" class="outline-btn" data-action="close-first-run-wizard">稍后再说</button>
        <button type="button" class="outline-btn" data-action="health">检查端口</button>
        <button type="button" class="primary-btn" data-action="wizard-start">保存并启动</button>
      </div>
    </section>
  `
}

function renderModernSettingsContent() {
  const tab = currentSettingsTabId()
  const v = state.validation || {}
  const launch = state.launch || {}
  const checks = `
    <div class="checks">
      <div><span>配置文件</span>${pill(v.configExists)}</div>
      <div><span>启动器</span>${pill(v.launcherExists)}</div>
      <div><span>llama-server</span>${pill(v.serverExists)}</div>
      <div><span>模型文件</span>${pill(v.modelExists)}</div>
      <div><span>保存状态</span>${state.dirty ? '<span class="pill warn">未保存</span>' : '<span class="pill good">已保存</span>'}</div>
    </div>
  `

  if (tab === 'overview') {
    return `
      <div class="settings-stack">
        ${renderModernSettingsCard('当前接入状态', '这里集中放服务入口、上下文和启动模式。', `
          ${checks}
          <div class="endpoint-box">
            <span>OpenAI Base URL</span>
            <strong>${escapeHtml(state.localBaseUrl || state.status.url || '')}/v1</strong>
          </div>
          <div class="endpoint-box">
            <span>Chat Completions</span>
            <strong>${escapeHtml(state.chatCompletionsUrl || `${state.status.url || ''}/v1/chat/completions`)}</strong>
          </div>
        `)}
        ${renderModernSettingsCard('服务入口', '监听地址、端口与超时。模型参数请到主界面「参数」视图。', `
          <div class="form-grid two">
            ${selectField('launch_mode', '启动方式', ['direct', 'launcher'], 'direct = 直接调用 llama-server.exe；launcher = 兼容旧启动器')}
            ${field('host', 'Host', { warningId: 'public-host' })}
            ${field('port', 'Port', { type: 'number', min: 1 })}
            ${field('request_timeout_ms', '请求超时 ms', { type: 'number', min: 30000, warningId: 'short-timeout' })}
          </div>
          <div class="settings-callout">上下文、GPU 层数、采样等模型参数已集中在主界面「参数」视图，这里只留服务入口类设置，避免两处各改一半。</div>
        `)}
        ${renderModernSettingsCard('最终启动命令', '速度或参数不对时，先复制这里和原生命令行对比。', `
          <div class="command-preview ${launch.error ? 'has-error' : ''}">
            <pre>${escapeHtml(launch.error || launch.preview || '保存配置后会在这里生成完整命令。')}</pre>
            <button type="button" class="outline-btn small-btn" data-action="copy-launch-command" ${launch.preview && !launch.error ? '' : 'disabled'}>复制命令</button>
          </div>
        `)}
      </div>
    `
  }

  if (tab === 'rescue') {
    return renderRescueSettingsContent()
  }

  if (tab === 'display') {
    return `
      <div class="settings-stack">
        ${renderModernSettingsCard('当前模型', '这里补上了网页端那种可查看详情的模型入口。', `
          <div class="settings-inline-actions">
            <button type="button" class="model-chip model-trigger wide" data-action="open-model-info" title="${escapeHtml(state.config?.model || '')}">
              <span class="model-chip-icon">${renderModelChipIcon()}</span>
              <span class="model-chip-label">${escapeHtml(modelName())}</span>
            </button>
            <button type="button" class="outline-btn" data-action="open-model-info">查看模型信息</button>
          </div>
        `)}
        ${renderModernSettingsCard('模型与模板', '切换 GGUF、视觉投影和模板参数。', `
          <div class="form-grid single">
            ${field('model', '模型文件', { pick: 'gguf', hint: '例如 Qwen3.5-9B.Q4_K_M.gguf' })}
            ${field('mmproj', 'mmproj 投影文件', { pick: 'gguf', hint: '视觉或多模态模型才需要' })}
            ${selectField('chat_quality_mode', '对话质量模式', ['quality', 'fast'], '质量模式 = 对齐网页端 Reasoning；极速模式 = 关闭 thinking 换取更短延迟。')}
            ${field('chat_template_kwargs', 'Chat Template Kwargs', { textarea: true, hint: '质量模式留空，使用模型默认 Reasoning；极速模式会写入 {"enable_thinking":false}。也兼容 --chat-template-kwargs \'{\\"enable_thinking\\":false}\'。' })}
          </div>
          <div class="settings-callout">质量模式会优先保证创意代码、复杂推理和长答案质量；下面的“显示思考过程”只是控制桌面端是否把已返回的 <think> 展示出来。图片理解需要视觉模型和 mmproj。</div>
        `)}
        ${renderModernSettingsCard('展示开关', '把网页端常见的显示项集中到一起。', `
          <div class="switch-grid">
            ${switchField('show_thinking', '显示思考过程', '解析模型返回的 <think> 区块。')}
            ${switchField('expand_thinking', '默认展开思考', '关闭时会折叠成一行。')}
            ${switchField('show_raw_output', '显示原始输出', '排查模板和思考模式时使用。')}
            ${switchField('webui', '保留 llama.cpp Web UI', '保留浏览器页入口，方便双开调试。')}
          </div>
        `)}
      </div>
    `
  }


  // 「进出口」（io）与「MCP」两个页签已删除，原因见 settingsTabs 上方注释。
  // io 原本只渲染 config_path / launcher_path / llama_server_path 三个字段，
  // 而 field() 在 direct 模式下把它们全部吞掉 → 整页空白。
  // 这里把这三个字段收进「高级」，并把 llama_bin_dir 也显式摆出来 ——
  // 它才是决定「用哪个后端引擎」的那个路径。

  if (tab === 'developer') {
    const engineId = state.engine?.engineId || detectEngineByPath(state.config?.llama_server_path)
    const engineEntry = (state.engineList || []).find(item => item.id === engineId)
    const resolvedServer = state.config?.llama_server_path || engineEntry?.path || ''
    return `
      <div class="settings-stack">
        ${renderModernSettingsCard('后端引擎', '引擎跟着所选预设走，切换预设时自动跟随。', `
          ${renderEngineSelector()}
          <div class="engine-path-readout">
            <span>当前识别</span>
            <strong>${escapeHtml(getEngineLabel(engineId))}</strong>
          </div>
          <div class="engine-path-readout">
            <span>实际调用</span>
            <!-- 只给文件名：完整路径属于实现细节，退到悬停提示（有意保留的按需查看渠道）。
                 用户真正需要确认的是「用的是哪个可执行文件」，不是它在哪个盘。 -->
            <strong title="${escapeAttribute(resolvedServer)}">${escapeHtml(resolvedServer ? resolvedServer.split(/[\\/]/).pop() : '未找到可执行文件')}</strong>
          </div>
          <div class="form-grid single">
            ${field('llama_bin_dir', 'llama-server 所在目录', { pick: 'dir', hint: '目录里要有 llama-server.exe 以及同版本的 DLL。' })}
          </div>
        `)}
        ${renderModernSettingsCard('本页独有', '这几个参数没放进主面板，所以留在这里。', `
          <div class="form-grid two">
            ${field('threads_batch', 'Threads batch', { type: 'number' })}
            ${field('n_cpu_moe', 'n_cpu_moe', { type: 'number' })}
            ${field('log_verbosity', '日志等级', { type: 'number' })}
          </div>
          <div class="settings-callout">线程、批处理、GPU 分配、采样与显存相关参数集中在主界面「参数」视图；多 GPU 切分见「参数」→「显存 &amp; KV」。</div>
          <div class="settings-inline-actions">
            <button type="button" class="btn btn-secondary" data-action="goto-params">前往「参数」视图</button>
          </div>
        `)}
        ${renderModernSettingsCard('兼容旧启动器（一般不用改）', '仅 launch_mode = launcher（走启动器）时需要这两个路径。', `
          <div class="form-grid single">
            ${field('config_path', '配置文件', { pick: 'toml', hint: '仅在兼容旧启动器时使用' })}
            ${field('launcher_path', '启动器 EXE', { pick: 'exe', hint: '仅在 launcher 模式下需要' })}
          </div>
        `)}
        ${renderModernSettingsCard('自定义附加参数', '临时放 ngram、多卡、speculative decoding 等高级参数。', `
          <div class="form-grid single">
            ${field('extra_args', '追加到 llama-server 的参数', { textarea: true, warningId: 'reasoning-budget', hint: '例如 --flash-attn --no-mmap。参数会追加到最终启动命令末尾，需要与你本机 llama.cpp 版本匹配。' })}
          </div>
          <div class="command-preview compact ${launch.error ? 'has-error' : ''}">
            <pre>${escapeHtml(launch.error || launch.preview || '保存配置后会在这里生成完整命令。')}</pre>
            <button type="button" class="outline-btn small-btn" data-action="copy-launch-command" ${launch.preview && !launch.error ? '' : 'disabled'}>复制命令</button>
          </div>
        `)}

      </div>
    `
  }

  if (tab === 'presets') {
    return `
      <div class="settings-stack">
        ${renderModernSettingsCard('按硬件生成稳定预设', '给陌生模型配预设不用再猜：读模型自己的 GGUF 头部（层数、训练上下文、KV 头数）加本机显存，算出一份「一定能起来」的参数，并把每项依据摊开给你看。', `
          <div class="settings-inline-actions">
            <button type="button" class="outline-btn" data-action="open-stable-preset">按本机硬件计算</button>
          </div>
        `)}
        ${renderModernSettingsCard('预设', '一键换整套配置：模型、引擎、上下文与采样参数。', `
          <div class="preset-area">
            <div class="preset-controls">
              <select id="presetSelect" class="preset-select">
                <option value="">-- 选择预设 --</option>
                ${state.presetList.map(name => {
                  // 必须回填选中项：每次 render() 都会重建下拉框，不写 selected 的话
                  // 用户刚选中的预设会被立刻冲掉，接着点「加载预设」就会因为读到空值而毫无反应。
                  const chosen = name === (state.presetPreview || state.preset)
                  return `<option value="${escapeAttribute(name)}"${chosen ? ' selected' : ''}>${escapeHtml(name)}</option>`
                }).join('')}
              </select>
              <button type="button" class="btn btn-primary" data-action="preset-apply">加载预设</button>
              <button type="button" class="btn btn-secondary" data-action="preset-edit">编辑参数…</button>
              <button type="button" class="btn btn-secondary" data-action="preset-save">另存为…</button>
              <button type="button" class="btn btn-secondary" data-action="preset-rename">重命名…</button>
              <button type="button" class="btn btn-secondary" data-action="preset-duplicate">复制为…</button>
              <button type="button" class="btn btn-danger" data-action="preset-delete">删除预设</button>
              <button type="button" class="btn btn-secondary" data-action="preset-refresh">刷新</button>
            </div>
            ${state.preset ? `<div class="preset-info">当前已加载: <strong>${escapeHtml(state.preset)}</strong></div>` : ''}
            ${state.presetPreview && state.presetPreview !== state.preset ? `<div class="preset-info">下拉框选中: <strong>${escapeHtml(state.presetPreview)}</strong>（点「加载预设」生效）</div>` : ''}
            ${state.presetMeta ? renderPresetMeta(state.presetMeta) : ''}
          </div>
        `)}
        ${renderModernSettingsCard('引擎与显存', 'KVMem / PrismML 不支持 MoE 卸载、embeddings 与 continuous batching，加载预设后会自动识别。', `
          ${renderEngineSelector()}
          ${state.vramWarning ? '<div class="preset-warning">⚠️ 可用显存不足 1000 MiB，大模型可能加载失败</div>' : ''}
          ${state.vramUsage ? `<div class="preset-vram">可用显存: ${Math.round(state.vramUsage.available)} MiB / ${Math.round(state.vramUsage.total)} MiB</div>` : ''}
        `)}
      </div>
    `
  }

  if (tab === 'appearance') {
    return `
      <div class="settings-stack">
        ${renderModernSettingsCard('外观', '把最影响观感的几项集中到一起，顺手做一轮界面收紧。', `
          <div class="form-grid single">
            ${selectField('theme_mode', '界面主题', ['system', 'light', 'dark'], '跟随系统会读取 Windows 当前深浅色。')}
          </div>
          <div class="appearance-preview">
            <div class="appearance-preview-sidebar">
              <span></span>
              <strong>llama.cpp</strong>
              <em>Local endpoint</em>
            </div>
            <div class="appearance-preview-chat">
              <p>你好，我可以直接读取本地附件，也能把网页代码做成可预览结果。</p>
              <code>http://127.0.0.1:8080/v1</code>
            </div>
          </div>
        `)}
        ${renderModernSettingsCard('聊天字体', '只影响对话内容，不改变设置面板和按钮尺寸。', `
          <div class="form-grid single">
            ${selectField('chat_font', '聊天字体', ['default', 'sans', 'system', 'readable'], '易读模式会使用更宽松的行高和更稳的中文字体栈。')}
          </div>
        `)}
        ${renderModernSettingsCard('设置页签顺序', `左栏 ${settingsTabs.length} 个页签的顺序可以自己排，改完自动记住（恢复默认也不丢配置）。`, renderTabOrderList())}
        ${renderModernSettingsCard('关于', '应用标识与版本信息。', `
          <div class="about-card">
            <strong>Llama Rig</strong>
            <span>本地多引擎 LLM 推理控制台</span>
            <em class="about-version" data-version>加载中…</em>
            <div class="about-credit">基于 llama-cpp-desktop 改造 (MIT)</div>
          </div>
        `)}
      </div>
    `
  }

  return renderModernSettingsCard('日志', 'ANSI 颜色码已被过滤，方便直接看真正的 llama.cpp 输出。', `
    <div class="log-box" id="logBox">
      ${
        visibleLogs().length
          ? visibleLogs().map(entry => renderLogRow(entry, 'log-entry')).join('')
          : '<div class="empty-log">还没有日志。启动服务后会在这里实时显示。</div>'
      }
    </div>
  `)
}

function renderModernSettingsPanel() {
  const v = state.validation || {}
  const [activeId, activeIcon, activeLabel, activeHint] = currentSettingsTabMeta()
  return `
    <div class="settings-backdrop ${state.settingsOpen ? 'show' : ''}" data-action="close-settings"></div>
    <aside class="settings-panel ${state.settingsOpen ? 'show' : ''}">
      <div class="settings-rail">
        <div class="settings-badge">独立设置</div>
        <h2>把模型、参数和调试页收进一个桌面端设置中心。</h2>
        <p>这里继续沿用你的本地 llama.cpp 服务，但交互和分栏会尽量往网页端那种设置面板去靠。</p>
        <nav class="settings-rail-tabs">
          ${orderedSettingsTabs()
            .map(([id, _icon, label, hint]) => `
              <button type="button" class="${activeId === id ? 'active' : ''}" data-section="${id}">
                <span class="settings-tab-icon">${renderSettingsTabIcon(id)}</span>
                <span class="settings-tab-copy">
                  <strong>${escapeHtml(label)}</strong>
                  <span>${escapeHtml(hint)}</span>
                </span>
              </button>
            `)
            .join('')}
        </nav>
        <div class="progress-card">
          <strong>当前进度</strong>
          <div><span>配置文件</span>${pill(v.configExists)}</div>
          <div><span>启动器</span>${pill(v.launcherExists)}</div>
          <div><span>llama-server</span>${pill(v.serverExists)}</div>
          <div><span>模型文件</span>${pill(v.modelExists)}</div>
        </div>
      </div>
      <div class="settings-main">
        <div class="settings-head">
          <div>
            <span>设置</span>
            <strong>${escapeHtml(activeLabel)}</strong>
            <em>${escapeHtml(activeHint)}</em>
          </div>
          <button type="button" class="icon-btn" data-action="close-settings">×</button>
        </div>
        <div class="settings-body">${renderSettingsBodySafe()}</div>
        <div class="settings-foot">
          <button class="outline-btn" type="button" data-action="save">保存</button>
          <button class="primary-btn" type="button" data-action="close-settings">完成</button>
        </div>
      </div>
    </aside>
  `
}

// ============================================================
// 渲染错误隔离
//
// 真实事故(2026-09-29)：portRepairPlan 读了 null.suggestedPort 抛 TypeError，
// 它在 render() 的模板字符串里被求值 —— 异常冒泡出去后 appEl.innerHTML
// 那一行**根本不会执行**。用户看到的现象是「点某个设置页，界面卡住、
// 点什么都没反应」，而且没有任何错误提示，排查只能靠猜。
//
// 这里加两道防线，原则是「坏掉的最小化」而不是整屏陪葬：
//   1. 设置正文按页签单独兜住 —— 只有当前这一页显示错误卡，其余页签照常；
//   2. 整屏渲染兜底 —— 失败时保留上一帧 DOM（而不是清空），并浮出一条提示。
// 两处都把原始错误写进 console 与卡片，避免再次出现「无声白屏」。
// ============================================================

function renderFailureCard(label, error) {
  return renderModernSettingsCard(`${label} · 这一页渲染失败`, '已隔离：其余设置页和主界面不受影响。把下面这句反馈给维护者即可定位。', `
    <div class="settings-callout" role="alert">${escapeHtml(readableError(error))}</div>
  `)
}

function renderSettingsBodySafe() {
  try {
    return renderModernSettingsContent()
  } catch (error) {
    const [, , label] = currentSettingsTabMeta()
    console.error(`[Llama Rig] 设置页「${label}」渲染失败:`, error)
    try {
      return renderFailureCard(label, error)
    } catch {
      // 连错误卡都渲染不出来时，至少给一句纯文本，绝不再抛。
      return `<div class="settings-callout" role="alert">这一页渲染失败：${escapeHtml(readableError(error))}</div>`
    }
  }
}

// 整屏渲染失败时的提示条：不动既有 DOM，只在最上面浮一条可关闭的提示。
function showRenderFailureBanner(error) {
  const existing = document.getElementById('renderFailureBanner')
  if (existing) existing.remove()
  const banner = document.createElement('div')
  banner.id = 'renderFailureBanner'
  banner.setAttribute('role', 'alert')
  banner.className = 'render-failure-banner'
  banner.innerHTML = `<strong>界面刷新失败</strong><span>${escapeHtml(readableError(error))}</span><button type="button" aria-label="关闭">×</button>`
  banner.querySelector('button')?.addEventListener('click', () => banner.remove())
  document.body.appendChild(banner)
}

// ---------------------------------------------------------------
// 滚动位置保持
//
// renderScreen() 是整屏 innerHTML 重建：所有滚动容器都被销毁重建，
// scrollTop 一律归零。于是「在设置里往下滚 → 点一个开关 → 页面跳回顶部」。
// 原先只有聊天区、日志框手写了还原，每多一个可滚动区域就要再补一行，
// 漏掉就是这次的现象（设置区、参数区、侧栏列表全都漏了）。
//
// 这里改成通用做法：重建前把「所有 scrollTop != 0 的元素」按 DOM 路径记下来，
// 重建后按同一路径还原。路径用「标签名 + 同级同标签序号」构成，
// 不依赖类名或文本，重新渲染后结构一致即能对上。
// ---------------------------------------------------------------

// 深度优先遍历，同时产出每个元素的稳定路径（O(n)，不做重复的祖先回溯）。
function walkWithScrollKeys(node, path, visit) {
  const counters = new Map()
  const children = node.children
  for (let i = 0; i < children.length; i++) {
    const child = children[i]
    const seen = counters.get(child.tagName) || 0
    counters.set(child.tagName, seen + 1)
    const childPath = `${path}>${child.tagName}${seen}`
    visit(child, childPath)
    walkWithScrollKeys(child, childPath, visit)
  }
}

function captureScrollPositions() {
  const snapshot = new Map()
  walkWithScrollKeys(appEl, '', (el, key) => {
    if (el.scrollTop > 0) snapshot.set(key, el.scrollTop)
  })
  return snapshot
}

function restoreScrollPositions(snapshot) {
  if (!snapshot || !snapshot.size) return
  walkWithScrollKeys(appEl, '', (el, key) => {
    const top = snapshot.get(key)
    if (top !== undefined) el.scrollTop = top
  })
}

// 判断「这次渲染是不是换了内容」。换页签/换视图时回到顶部才是对的，
// 同一个页面内的重渲染（点开关、改数值）则必须原地不动。
let lastRenderedSettingsTab = ''
let lastRenderedView = ''

function render(options = {}) {
  try {
    renderScreen(options)
    document.getElementById('renderFailureBanner')?.remove()
  } catch (error) {
    // 保留上一帧界面：清空 innerHTML 会让用户彻底没法操作，比留下旧界面更糟。
    console.error('[Llama Rig] 整屏渲染失败，已保留上一帧界面:', error)
    showRenderFailureBanner(error)
  }
}

function renderScreen(options = {}) {
  if (!state.config) {
    appEl.innerHTML = '<div class="boot">正在读取配置...</div>'
    return
  }

  applyAppearancePreferences()
  const previousFeed = document.getElementById('chatFeed')
  const previousFeedTop = previousFeed?.scrollTop || 0
  const previousFeedHeight = previousFeed?.scrollHeight || 0
  const hasChatMessages = state.chatMessages.length > 0
  const shouldStick = hasChatMessages && (options.stickToBottom ?? isNearBottom(previousFeed))
  const running = state.status.state === 'running' || state.status.state === 'starting'
  // 内容是否换了：换页签 / 换视图 => 该回到顶部；否则保持原位。
  const settingsTabChanged = lastRenderedSettingsTab !== '' && lastRenderedSettingsTab !== state.active
  const viewChanged = lastRenderedView !== '' && lastRenderedView !== state.view
  const scrollSnapshot = captureScrollPositions()
  appEl.innerHTML = `
    <div class="app-shell ${state.sidebarCollapsed ? 'sidebar-collapsed' : ''}">
      ${renderTopbar()}
      <div class="body">
        ${renderSide()}
        <main class="main-area">
        ${state.view === 'params'
          ? renderParamPanel()
          : state.view === 'terminal'
            ? renderTerminalPanel()
            : renderChat()}
        <footer class="status">
          <div class="status-left">
            <span class="led ${statusClass() === 'running' ? '' : statusClass() === 'error' ? 'bad' : 'warn'}"></span>
            <span class="st-txt">${statusLabel()}</span>
            <span class="st-url">${escapeHtml(state.status.url || '')}</span>
          </div>
          ${renderResMetrics()}
          <div class="acts">
            <button class="abtn ghost" type="button" data-action="health">检查端口</button>
            ${
              running
                ? `<button class="abtn no" type="button" data-action="stop" ${state.busy ? 'disabled' : ''}>&#9632; 停止</button>`
                : `<button class="abtn go" type="button" data-action="start" ${state.busy ? 'disabled' : ''}>&#9654; 启动</button>`
            }
            <button class="abtn ghost" type="button" data-action="save" ${state.busy ? 'disabled' : ''}>&#128190; 保存</button>
          </div>
        </footer>
        </main>
      </div>
      ${renderModernSettingsPanel()}
    </div>
    ${renderPreviewModal()}
    ${renderModelInfoModal()}
    ${renderHistoryDialog()}
    ${renderPresetDialog()}
    ${renderPresetEditor()}
    ${renderVramGuardDialog()}
    ${renderStablePresetDialog()}
    ${renderFirstRunWizard()}
    ${renderAttachmentMenuPortal()}
    <div class="toast ${state.toast ? 'show' : ''}">${escapeHtml(state.toast)}</div>
  `

  // 先还原通用滚动位置，再走下面聊天区/日志框各自的既有逻辑
  // （那两处有「贴底/跟随」的语义，会覆盖这里的值，顺序不能反）。
  restoreScrollPositions(scrollSnapshot)
  const settingsBody = document.querySelector('.settings-body')
  if (settingsBody && (settingsTabChanged || viewChanged)) settingsBody.scrollTop = 0

  const chatFeed = document.getElementById('chatFeed')
  if (chatFeed) {
    if (!hasChatMessages) {
      chatFeed.scrollTop = options.preserveChatScroll && previousFeed ? previousFeedTop : 0
    } else if (options.jumpToBottom) {
      chatFeed.scrollTop = chatFeed.scrollHeight
    } else if (options.preserveChatScroll && previousFeed) {
      chatFeed.scrollTop = shouldStick ? chatFeed.scrollHeight : previousFeedTop + (chatFeed.scrollHeight - previousFeedHeight)
    } else if (shouldStick) {
      chatFeed.scrollTop = chatFeed.scrollHeight
    }
    scrollOpenRawOutputs(chatFeed)
  }
  const logBox = document.getElementById('logBox')
  if (logBox) logBox.scrollTop = logBox.scrollHeight
  const inlineLogBox = document.getElementById('inlineLogBox')
  if (inlineLogBox) inlineLogBox.scrollTop = inlineLogBox.scrollHeight
  const historyList = document.querySelector('.history-list')
  if (historyList && options.resetHistoryScroll) historyList.scrollTop = 0

  lastRenderedSettingsTab = state.active
  lastRenderedView = state.view
}

function setToast(message) {
  state.toast = message
  render()
  window.clearTimeout(setToast.timer)
  setToast.timer = window.setTimeout(() => {
    state.toast = ''
    render()
  }, 2800)
}

function patchFromBackend(payload) {
  // 服务真跑起来过 = 用户已经用过，引导可以让位了。
  if (payload.config) state.config = payload.config
  if (payload.configWarnings) state.configWarnings = payload.configWarnings
  if (payload.listenBaseUrl) state.listenBaseUrl = payload.listenBaseUrl
  if (payload.localBaseUrl) state.localBaseUrl = payload.localBaseUrl
  if (payload.chatCompletionsUrl) state.chatCompletionsUrl = payload.chatCompletionsUrl
  if (payload.validation) state.validation = payload.validation
  if (payload.status) {
    state.status = payload.status
    if (payload.status.state === 'running') markOnboardingDone()
  }
  if (Array.isArray(payload.logs)) state.logs = { ...state.logs, entries: payload.logs }
  if (payload.logStats) state.logs = { ...state.logs, ...payload.logStats }
  if (payload.launch) state.launch = payload.launch
  state.dirty = false
}

function localNumberValue(input) {
  if (input.value === '') return ''
  const next = Number(input.value)
  return Number.isFinite(next) ? next : input.value
}

function applyStreamDelta(payload) {
  if (!payload || payload.requestId !== state.streamRequestId) return
  const last = state.chatMessages[state.chatMessages.length - 1]
  if (!last || last.role !== 'assistant') return
  const lastIndex = state.chatMessages.length - 1
  if (payload.delta) {
    last.content = `${last.content || ''}${payload.delta}`
    scheduleStreamRender(lastIndex)
  }
  if (payload.thinkingDelta) {
    last.thinking = `${last.thinking || ''}${payload.thinkingDelta}`
    scheduleStreamRender(lastIndex)
  }
  if (payload.done) {
    flushStreamRender()
    last.thinking = payload.thinking || last.thinking || ''
    last.content = payload.content || last.content || (last.thinking ? '' : '模型返回了空内容。')
    updateLiveStats(last)
    last.streaming = false
    saveCurrentSession()
    updateMessageDom(lastIndex)
  }
}

async function save() {
  state.busy = true
  render()
  try {
    patchFromBackend(await window.llamaDesktop.saveConfig({ config: state.config }))
    setToast('配置已保存')
  } catch (error) {
    setToast(error.message || String(error))
  } finally {
    state.busy = false
    render()
  }
}

// 验收 #9：点「启动」前重新查一次显存，低于警戒线就拦下来问一次。
// 8GB 卡同一时刻只能跑一个模型，显存被别人占了直接启动会 OOM 或长时间卡死。
async function start() {
  state.busy = true
  render()
  try {
    await checkVram()
  } catch (error) {
    // 查不到显存（非 Windows / 没有 nvidia-smi）不阻塞启动，照旧放行。
  }
  if (state.vramWarning) {
    state.busy = false
    state.vramGuard = { ...(state.vramUsage || {}) }
    render()
    return
  }
  await doStartServer()
}

async function doStartServer() {
  state.busy = true
  render()
  try {
    patchFromBackend(await window.llamaDesktop.startServer({ config: state.config }))
    state.active = 'chat'
    setToast('服务正在启动。关闭窗口后会继续在托盘运行。')
  } catch (error) {
    setToast(readableError(error))
  } finally {
    state.busy = false
    render()
  }
}

async function stop() {
  state.busy = true
  render()
  try {
    patchFromBackend(await window.llamaDesktop.stopServer())
    setToast('服务已停止')
  } catch (error) {
    setToast(error.message || String(error))
  } finally {
    state.busy = false
    render()
  }
}

async function health() {
  const result = await window.llamaDesktop.testHealth({ config: state.config })
  state.health = result
  const diagnosis = portDiagnosis(result)
  setToast(result.ok ? `端口正常：${result.endpointBase || `${result.url}/v1`}` : `${diagnosis.title}：${diagnosis.action}`)
  render({ preserveChatScroll: true })
}

async function inspectPort() {
  state.busy = true
  render({ preserveChatScroll: true })
  try {
    state.portInspection = await window.llamaDesktop.inspectPort({ config: state.config })
    const plan = portRepairPlan({ config: state.config || {}, status: state.status, inspection: state.portInspection, health: state.health })
    setToast(`${plan.title}：${plan.action}`)
  } catch (error) {
    setToast(error?.message || String(error))
  } finally {
    state.busy = false
    render({ preserveChatScroll: true })
  }
}

async function clientSmokeTest() {
  state.busy = true
  render({ preserveChatScroll: true })
  try {
    state.clientSmoke = await window.llamaDesktop.clientSmokeTest({ config: state.config })
    const plan = clientSmokePlan({ config: state.config || {}, status: state.status, smoke: state.clientSmoke })
    setToast(`${plan.title}：${plan.action}`)
  } catch (error) {
    state.clientSmoke = { ok: false, message: error?.message || String(error) }
    setToast(error?.message || String(error))
  } finally {
    state.busy = false
    render({ preserveChatScroll: true })
  }
}

async function openModelInfo() {
  state.modelInfoOpen = true
  state.modelInfo = { loading: true }
  render({ preserveChatScroll: true })
  try {
    state.modelInfo = await window.llamaDesktop.getModelInfo({ config: state.config })
  } catch (error) {
    state.modelInfo = { error: error?.message || String(error) }
  }
  render({ preserveChatScroll: true })
}

function makeChatRequestId() {
  return `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function createPendingAssistant(requestId) {
  const assistant = {
    role: 'assistant',
    content: '',
    thinking: '',
    createdAt: Date.now(),
    startedAt: Date.now(),
    model: modelName(),
    tokens: 0,
    estimatedTokens: 0,
    latencyMs: 0,
    speed: '',
    streaming: true,
  }
  assistant.requestId = requestId
  return assistant
}

function assistantForRequest(requestId) {
  if (!requestId) return null
  return state.chatMessages.find(message => message.role === 'assistant' && message.requestId === requestId) || null
}

function markAssistantFailed(requestId, error, retry = false) {
  const assistant = assistantForRequest(requestId)
  if (!assistant) return
  const errorText = String(error?.message || error || '')
  const cancelled = Boolean(assistant.cancelRequested) || /cancelled|canceled|request cancelled/i.test(errorText)
  const displayError = friendlyErrorMessage(error).replace(/^发送失败/, retry ? '重试失败' : '发送失败')
  assistant.streaming = false
  assistant.localOnly = true
  assistant.state = cancelled ? 'cancelled' : 'failed'
  assistant.error = displayError
  if (!assistant.content && !assistant.thinking) {
    assistant.content = cancelled ? '已停止生成。' : displayError
  }
}

async function cancelChat() {
  const requestId = state.streamRequestId
  const assistant = assistantForRequest(requestId)
  if (!state.chatBusy || !requestId || !assistant || assistant.cancelRequested) return
  assistant.cancelRequested = true
  assistant.state = 'cancelling'
  render({ preserveChatScroll: true })
  try {
    const result = await window.llamaDesktop.cancelChat(requestId)
    if (!result?.ok && state.chatBusy) {
      assistant.cancelRequested = false
      assistant.state = ''
      setToast('当前请求已结束，无法停止')
    }
  } catch (error) {
    assistant.cancelRequested = false
    assistant.state = ''
    setToast(error?.message || String(error))
  }
}

async function sendChat() {
  markOnboardingDone()
  const content = state.chatInput.trim()
  if ((!content && state.attachments.length === 0) || state.chatBusy) return

  if (!state.currentSessionId) state.currentSessionId = makeSessionId()
  const attachments = state.attachments
  state.chatMessages.push({ role: 'user', content, attachments, createdAt: Date.now() })
  const requestId = makeChatRequestId()
  state.chatMessages.push(createPendingAssistant(requestId))
  state.streamRequestId = requestId
  state.chatInput = ''
  state.attachments = []
  state.attachmentMenuOpen = false
  state.chatBusy = true
  state.view = 'chat'
  saveCurrentSession()
  render()

  try {
    const startedAt = performance.now()
    const result = await window.llamaDesktop.streamChat({
      requestId,
      config: state.config,
      messages: buildApiMessages(state.chatMessages.slice(0, -1)),
    })
    const latencyMs = Math.round(performance.now() - startedAt)
    const assistant = assistantForRequest(requestId)
    if (assistant?.role === 'assistant') {
      assistant.thinking = result.thinking || assistant.thinking || ''
      assistant.content = result.content || assistant.content || (assistant.thinking ? '' : '模型返回了空内容。')
      const estimatedTokens = estimateTokens(generatedTextForStats(assistant))
      const stats = responseStats(result.raw, generatedTextForStats(assistant), latencyMs)
      assistant.tokens = stats.tokens || estimatedTokens
      assistant.estimatedTokens = estimatedTokens
      assistant.latencyMs = latencyMs
      assistant.speed = stats.speed || ''
      assistant.speedSource = stats.speedSource || ''
      if (!assistant.speed && assistant.tokens) {
        assistant.liveSpeed = `${(Number(assistant.tokens) / (latencyMs / 1000)).toFixed(2)} t/s`
        assistant.liveSpeedSource = 'estimate'
      }
      assistant.streaming = false
      assistant.state = ''
    }
    saveCurrentSession()
  } catch (error) {
    markAssistantFailed(requestId, error)
    saveCurrentSession()
  } finally {
    state.chatBusy = false
    state.streamRequestId = ''
    render({ preserveChatScroll: true })
  }
}

async function retryMessage(index) {
  if (state.chatBusy) return
  const previousUserIndex = state.chatMessages
    .slice(0, index)
    .map((message, itemIndex) => ({ message, itemIndex }))
    .reverse()
    .find(item => item.message.role === 'user')?.itemIndex

  if (previousUserIndex === undefined) {
    setToast('没有找到可以重试的用户消息')
    return
  }

  const userMessage = state.chatMessages[previousUserIndex]
  state.chatMessages = state.chatMessages.slice(0, index)
  const requestId = makeChatRequestId()
  state.chatMessages.push(createPendingAssistant(requestId))
  state.streamRequestId = requestId
  state.chatBusy = true
  render()

  try {
    const startedAt = performance.now()
    const result = await window.llamaDesktop.streamChat({
      requestId,
      config: state.config,
      messages: buildApiMessages(state.chatMessages.slice(0, -1)),
    })
    const latencyMs = Math.round(performance.now() - startedAt)
    const assistant = assistantForRequest(requestId)
    if (assistant?.role === 'assistant') {
      assistant.thinking = result.thinking || assistant.thinking || ''
      assistant.content = result.content || assistant.content || (assistant.thinking ? '' : `基于“${userMessage.content}”重试后，模型返回了空内容。`)
      const estimatedTokens = estimateTokens(generatedTextForStats(assistant))
      const stats = responseStats(result.raw, generatedTextForStats(assistant), latencyMs)
      assistant.tokens = stats.tokens || estimatedTokens
      assistant.estimatedTokens = estimatedTokens
      assistant.latencyMs = latencyMs
      assistant.speed = stats.speed || ''
      assistant.speedSource = stats.speedSource || ''
      if (!assistant.speed && assistant.tokens) {
        assistant.liveSpeed = `${(Number(assistant.tokens) / (latencyMs / 1000)).toFixed(2)} t/s`
        assistant.liveSpeedSource = 'estimate'
      }
      assistant.streaming = false
      assistant.state = ''
    }
    saveCurrentSession()
  } catch (error) {
    markAssistantFailed(requestId, error, true)
    saveCurrentSession()
  } finally {
    state.chatBusy = false
    state.streamRequestId = ''
    render({ preserveChatScroll: true })
  }
}

async function pick(fieldName, kind) {
  const filters = {
    exe: [
      { name: 'Executable', extensions: ['exe', 'cmd', 'bat'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    gguf: [
      { name: 'GGUF', extensions: ['gguf'] },
      { name: 'All Files', extensions: ['*'] },
    ],
    toml: [
      { name: 'TOML', extensions: ['toml'] },
      { name: 'All Files', extensions: ['*'] },
    ],
  }[kind] || [{ name: 'All Files', extensions: ['*'] }]

  const selected = await window.llamaDesktop.pickFile(kind === 'dir' ? { properties: ['openDirectory'] } : filters)
  if (selected) {
    state.config[fieldName] = selected
    if (fieldName === 'llama_bin_dir') {
      state.config.llama_server_path = `${selected.replace(/[\\/]+$/, '')}\\llama-server.exe`
    }
    state.dirty = true
    render()
  }
}

async function pickAttachment(kind) {
  try {
    const picked = await window.llamaDesktop.pickAttachments({ kind })
    if (picked?.length) {
      addAttachments(picked, `${attachmentLabel(kind)}已添加`)
    } else {
      state.attachmentMenuOpen = false
      state.attachmentMenuPosition = null
      render()
    }
  } catch (error) {
    setToast(error.message || String(error))
  }
}

function addAttachments(picked, fallbackMessage = '文件已添加') {
  state.attachments = [...state.attachments, ...picked]
  state.attachmentMenuOpen = false
  state.attachmentMenuPosition = null
  state.draggingFiles = false
  state.dragDepth = 0
  const errors = picked.filter(item => item.error)
  const hasImage = picked.some(item => item.kind === 'image')
  const hasLargeImage = picked.some(item => item.kind === 'image' && !item.dataUrl)
  if (errors.length) {
    setToast(`已添加 ${picked.length} 个文件，其中 ${errors.length} 个只记录路径。`)
  } else if (hasLargeImage) {
    setToast('图片已添加，但文件较大，只会作为附件记录路径。')
  } else if (hasImage && !state.config?.mmproj) {
    setToast('图片已添加；未配置 mmproj 时，普通文本模型可能看不懂图片。')
  } else {
    setToast(fallbackMessage)
  }
}

function dragHasFiles(dataTransfer) {
  return Array.from(dataTransfer?.types || []).includes('Files')
}

function droppedFiles(dataTransfer) {
  return Array.from(dataTransfer?.files || [])
}

function droppedFilePath(file) {
  return file?.path || file?.webkitRelativePath || ''
}

function droppedFilePaths(files) {
  return files
    .map(file => droppedFilePath(file))
    .filter(Boolean)
}

function droppedMimeForFile(file) {
  const name = String(file?.name || '').toLowerCase()
  if (file?.type) return file.type
  if (/\.(png)$/i.test(name)) return 'image/png'
  if (/\.(jpe?g)$/i.test(name)) return 'image/jpeg'
  if (/\.(webp)$/i.test(name)) return 'image/webp'
  if (/\.(gif)$/i.test(name)) return 'image/gif'
  if (/\.(bmp)$/i.test(name)) return 'image/bmp'
  if (/\.(pdf)$/i.test(name)) return 'application/pdf'
  if (/\.(mp3)$/i.test(name)) return 'audio/mpeg'
  if (/\.(wav)$/i.test(name)) return 'audio/wav'
  if (/\.(flac)$/i.test(name)) return 'audio/flac'
  if (/\.(m4a)$/i.test(name)) return 'audio/mp4'
  if (/\.(ogg)$/i.test(name)) return 'audio/ogg'
  if (/\.(txt|md|json|toml|ya?ml|csv|log|py|js|ts|tsx|html|css|c|cpp|h|hpp)$/i.test(name)) return 'text/plain'
  return 'application/octet-stream'
}

function droppedKindForFile(file, mime = droppedMimeForFile(file)) {
  const name = String(file?.name || '').toLowerCase()
  if (mime.startsWith('image/')) return 'image'
  if (mime.startsWith('audio/')) return 'audio'
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf'
  if (mime.startsWith('text/') || /\.(txt|md|json|toml|ya?ml|csv|log|py|js|ts|tsx|html|css|c|cpp|h|hpp)$/i.test(name)) return 'text'
  return 'file'
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer)
  const chunkSize = 0x8000
  const chunks = []
  for (let index = 0; index < bytes.length; index += chunkSize) {
    chunks.push(String.fromCharCode(...bytes.subarray(index, index + chunkSize)))
  }
  return btoa(chunks.join(''))
}

async function readDroppedFileAsAttachment(file) {
  const mime = droppedMimeForFile(file)
  const kind = droppedKindForFile(file, mime)
  const attachment = {
    name: file.name || 'dropped-file',
    size: file.size || 0,
    mime,
    kind,
    source: 'drop',
  }

  if (kind === 'image' && file.size <= 10 * 1024 * 1024) {
    const base64 = arrayBufferToBase64(await file.arrayBuffer())
    attachment.dataUrl = `data:${attachment.mime};base64,${base64}`
  }

  if (kind === 'text' && file.size <= 256 * 1024) {
    attachment.text = await file.text()
  }

  return attachment
}

async function droppedFileAttachments(files) {
  const paths = droppedFilePaths(files)
  const pathSet = new Set(paths)
  const embeddedFiles = files.filter(file => !pathSet.has(droppedFilePath(file)))
  const attachments = []

  try {
    if (paths.length) {
      attachments.push(...(await window.llamaDesktop.importAttachments({ paths }) || []))
    }
    for (const file of embeddedFiles) {
      attachments.push(await readDroppedFileAsAttachment(file))
    }
  } catch (error) {
    setToast(error.message || String(error))
  }

  return attachments
}

async function importDroppedFiles(files) {
  const picked = await droppedFileAttachments(files)
  if (picked.length) {
    addAttachments(picked, `已拖入 ${picked.length} 个文件`)
  } else {
    setToast('拖拽来源没有提供可读取的文件，请从文件夹拖入原文件。')
  }
}

appEl.addEventListener('click', event => {
  // 点击顶栏之外的任意位置：先收起顶栏下拉
  if (state.topbarMenu && !event.target.closest('.topbar')) {
    state.topbarMenu = null
    render()
    return
  }

  // 注意：[data-action] 必须在选择器里 —— 顶栏的 .model-select/.model-file 是 div，
  // 只列 button 会导致它们点了没反应。
  const target = event.target.closest('[data-section], button, [data-action], .settings-backdrop, .preview-backdrop, .dialog-backdrop, .attach-menu-backdrop')
  if (!target) return

  const seed = target.dataset.seed
  if (seed) {
    state.chatInput = seed
    state.active = 'chat'
    state.view = 'chat'
    render()
    return
  }

  const sessionId = target.dataset.session
  if (sessionId) {
    openSession(sessionId)
    render({ jumpToBottom: true })
    return
  }

  const section = target.dataset.section || target.closest('[data-section]')?.dataset.section
  if (section) {
    openSettingsSection(section)
    render()
    return
  }

  const presetPick = target.dataset.presetPick
  if (presetPick) {
    void presetEditorPick(presetPick, target.dataset.kind)
    return
  }

  const pickField = target.dataset.pick
  if (pickField) {
    void pick(pickField, target.dataset.kind)
    return
  }

  const action = target.dataset.action
  if (action === 'param-tab') {
    state.paramTab = target.dataset.paramTab || PARAM_PANEL_SECTIONS[0].id
    render()
    return
  }
  if (action === 'goto-params') {
    state.view = 'params'
    state.settingsOpen = false
    render()
    return
  }
  if (action === 'terminal-tab') {
    state.terminalTab = target.dataset.terminalTab || 'output'
    render()
    return
  }
  if (action === 'set-view') {
    state.view = target.dataset.view || 'chat'
    render()
    return
  }
  if (action === 'toggle-topbar-menu') {
    const menu = target.dataset.menu || ''
    const wasOpen = state.topbarMenu === menu
    state.topbarMenu = wasOpen ? null : menu
    render()
    // 第一次展开模型菜单时才去扫盘，避免每次启动都白扫一遍。
    if (menu === 'models' && !wasOpen && !state.modelListLoaded) void loadModelList().then(() => render())
    return
  }
  if (action === 'open-stable-preset') {
    void openStablePresetDialog()
    return
  }
  if (action === 'close-stable-preset') {
    state.stablePreset = null
    render({ preserveChatScroll: true })
    return
  }
  if (action === 'apply-stable-preset') {
    applyStablePreset()
    return
  }
  if (action === 'apply-save-stable-preset') {
    // 先落到当前配置，再走既有的「保存为预设」对话框（它会写 stripUiPreferences 后的副本）
    const suggested = state.stablePreset?.result?.suggestedName || ''
    const result = state.stablePreset?.result
    if (result) {
      state.config = { ...state.config, ...result.proposal.patch }
      state.dirty = true
    }
    state.stablePreset = null
    openPresetDialog('save', suggested)
    return
  }
  if (action === 'toggle-path-snapshot') {
    state.pathSnapshotOpen = !state.pathSnapshotOpen
    render({ preserveChatScroll: true })
    return
  }
  if (action === 'refresh-models') {
    state.modelListLoaded = false
    void loadModelList().then(() => render())
    return
  }
  if (action === 'model-select') {
    const modelPath = target.dataset.modelPath || ''
    state.topbarMenu = null
    if (modelPath) {
      state.config = { ...state.config, model: modelPath }
      state.dirty = true
      // 换模型是改配置，必须让人看见「已经改了、还没保存」，
      // 否则点完菜单界面一闪就没了，用户不知道到底生效没有。
      const name = modelPath.split(/[\\/]/).filter(Boolean).pop() || modelPath
      setToast('已切换模型：' + shortenModelName(name, 30) + '（保存后生效）')
      void loadModelList().then(() => render())
    }
    render()
    return
  }
  if (action === 'preset-load') {
    const presetName = target.dataset.presetName
    state.topbarMenu = null
    if (presetName) void applyPreset(presetName)
    else render()
    return
  }
  if (action === 'preset-apply') {
    handleApplyPreset()
    return
  }
  if (action === 'preset-save') {
    openPresetDialog('save')
    return
  }
  if (action === 'preset-rename') {
    openPresetDialog('rename')
    return
  }
  if (action === 'preset-duplicate') {
    openPresetDialog('duplicate')
    return
  }
  if (action === 'preset-delete') {
    openPresetDialog('delete')
    return
  }
  if (action === 'preset-refresh') {
    void refreshPresetList()
    return
  }
  if (action === 'preset-dialog-close') {
    closePresetDialog()
    return
  }
  if (action === 'preset-dialog-confirm') {
    void submitPresetDialog()
    return
  }
  if (action === 'tab-move-up') {
    moveSettingsTab(target.dataset.tabId, -1)
    return
  }
  if (action === 'tab-move-down') {
    moveSettingsTab(target.dataset.tabId, 1)
    return
  }
  if (action === 'tab-order-reset') {
    resetSettingsTabOrder()
    return
  }
  if (action === 'preset-edit') {
    openPresetEditor()
    return
  }
  if (action === 'preset-editor-close') {
    closePresetEditor()
    return
  }
  if (action === 'preset-editor-save') {
    void savePresetDraft()
    return
  }
  if (action === 'engine-rescan') {
    rescanEngines()
    return
  }
  if (action === 'engine-pick-dir') {
    pickEngineFolder()
    return
  }
  if (action === 'engine-browse') {
    browseEngineBinary()
    return
  }
  if (action === 'engine-pick') {
    applyEngineBinary(target.dataset.enginePath || '', '扫到的', target.dataset.engineId || '')
    return
  }
  if (action === 'engine-switch') {
    handleSwitchEngine()
    return
  }
  if (action === 'toggle-thinking') {
    event.preventDefault()
    const key = target.dataset.thinkingKey || ''
    if (key) {
      const isOpen = state.openThinkingMessages.has(key) ||
        (Boolean(state.config?.expand_thinking) && !state.closedThinkingMessages.has(key))
      if (isOpen) {
        state.openThinkingMessages.delete(key)
        state.closedThinkingMessages.add(key)
      } else {
        state.closedThinkingMessages.delete(key)
        state.openThinkingMessages.add(key)
      }
      updateMessageDom(Number(target.dataset.messageIndex))
    }
    return
  }
  if (action === 'toggle-history-menu') {
    state.historyMenuId = state.historyMenuId === target.dataset.sessionId ? '' : target.dataset.sessionId
    render({ preserveChatScroll: true })
  }
  if (action === 'open-model-info') {
    void openModelInfo()
    return
  }
  if (action === 'close-model-info') {
    state.modelInfoOpen = false
    render({ preserveChatScroll: true })
    return
  }
  if (action === 'copy-model-info') {
    void navigator.clipboard.writeText(String(target.dataset.copy || ''))
    setToast('已复制到剪贴板')
    return
  }
  if (action === 'copy-terminal-diagnostics') {
    const text = diagnosticBundleText({
      config: state.config,
      status: state.status,
      logs: state.logs,
      terminalView: visibleTerminalLogs(),
    })
    void navigator.clipboard.writeText(text)
    setToast('终端诊断已复制，可直接粘贴给排查人员')
    return
  }
  if (action === 'toggle-run-check') {
    state.runCheckExpanded = !state.runCheckExpanded
    render({ preserveChatScroll: true })
    return
  }
  if (action === 'open-downloads') {
    void window.llamaDesktop.openUrl(downloadGuidance().releaseUrl)
    setToast('已打开 llama.cpp 官方 releases 页面')
    return
  }
  if (action === 'copy-download-guidance') {
    void navigator.clipboard.writeText(downloadGuidance().copyText)
    setToast('下载说明已复制')
    return
  }
  if (action === 'inspect-port') {
    void inspectPort()
    return
  }
  if (action === 'apply-port-fix') {
    const plan = portRepairPlan({ config: state.config || {}, status: state.status, inspection: state.portInspection, health: state.health })
    if (plan.canApply && plan.suggestedPort) {
      state.config.port = plan.suggestedPort
      state.dirty = true
      setToast(`已改用端口 ${plan.suggestedPort}，保存并重启后生效`)
      render({ preserveChatScroll: true })
    }
    return
  }
  if (action === 'client-smoke-test') {
    void clientSmokeTest()
    return
  }
  if (action === 'copy-integration-guide') {
    const text = integrationGuide({ config: state.config, status: state.status }).copyText
    void navigator.clipboard.writeText(text)
    setToast('第三方接入信息已复制')
    return
  }
  if (action === 'copy-support-bundle') {
    const text = supportBundleText({
      config: state.config,
      validation: state.validation,
      status: state.status,
      dirty: state.dirty,
    })
    void navigator.clipboard.writeText(text)
    setToast('支持诊断已复制')
    return
  }
  if (action === 'copy-feedback-bundle') {
    const parts = [
      supportBundleText({
        config: state.config,
        validation: state.validation,
        status: state.status,
        dirty: state.dirty,
      }),
      '',
      `Health: ${JSON.stringify(state.health || null)}`,
      `Port inspection: ${JSON.stringify(state.portInspection || null)}`,
      `System: ${JSON.stringify(state.systemInfo || null)}`,
      `Client smoke: ${JSON.stringify(state.clientSmoke || null)}`,
    ]
    void navigator.clipboard.writeText(parts.join('\n'))
    setToast('反馈诊断已复制，不会自动上传')
    return
  }
  if (action === 'open-first-run-wizard') {
    state.firstRunWizardOpen = true
    state.settingsOpen = false
    render({ preserveChatScroll: true })
    return
  }
  if (action === 'close-first-run-wizard') {
    state.firstRunWizardOpen = false
    state.firstRunWizardSeen = true
    markOnboardingDone()
    try {
      window.localStorage?.setItem('llama-desktop:first-run-seen', '1')
    } catch {}
    render({ preserveChatScroll: true })
    return
  }
  if (action === 'apply-recommended-params') {
    const recommendation = modelRecommendation({ config: state.config || {} })
    state.config.ctx_size = recommendation.profile.ctxSize
    state.config.n_gpu_layers = recommendation.profile.gpuLayers
    state.config.batch_size = recommendation.profile.batchSize
    state.dirty = true
    setToast('已应用保守推荐参数，保存后生效')
    render({ preserveChatScroll: true })
    return
  }
  if (action === 'wizard-start') {
    state.firstRunWizardSeen = true
    state.firstRunWizardOpen = false
    try {
      window.localStorage?.setItem('llama-desktop:first-run-seen', '1')
    } catch {}
    void start()
    return
  }
  if (action === 'copy-launch-command') {
    const command = state.launch?.preview || ''
    if (command && !state.launch?.error) {
      void navigator.clipboard.writeText(command)
      setToast('启动命令已复制')
    }
    return
  }
  if (action === 'history-edit') {
    const session = state.sessions.find(item => item.id === target.dataset.sessionId)
    if (session) {
      state.historyDialog = { type: 'edit', sessionId: session.id }
      state.historyMenuId = ''
      render({ preserveChatScroll: true })
      setTimeout(() => document.querySelector('[data-history-title-input]')?.focus(), 0)
    }
  }
  if (action === 'history-export') {
    const session = state.sessions.find(item => item.id === target.dataset.sessionId)
    if (session) {
      void navigator.clipboard.writeText(JSON.stringify(session, null, 2))
      state.historyMenuId = ''
      setToast('对话已复制到剪贴板')
    }
  }
  if (action === 'history-delete') {
    state.historyDialog = { type: 'delete', sessionId: target.dataset.sessionId }
    state.historyMenuId = ''
    render({ preserveChatScroll: true })
  }
  if (action === 'close-history-dialog') {
    state.historyDialog = null
    render({ preserveChatScroll: true })
  }
  if (action === 'history-save-title') {
    const session = state.sessions.find(item => item.id === target.dataset.sessionId)
    const input = document.querySelector('[data-history-title-input]')
    const nextTitle = String(input?.value || '').trim()
    if (session && nextTitle) {
      session.title = nextTitle.slice(0, 80)
      session.updatedAt = Date.now()
      state.historyDialog = null
      persistSessions()
      render({ preserveChatScroll: true, resetHistoryScroll: true })
    }
  }
  if (action === 'history-confirm-delete') {
    const sessionId = target.dataset.sessionId
    state.sessions = state.sessions.filter(item => item.id !== sessionId)
    if (state.currentSessionId === sessionId) {
      state.currentSessionId = makeSessionId()
      state.chatMessages = []
      state.chatInput = ''
      state.attachments = []
    }
    state.historyDialog = null
    persistSessions()
    render({ jumpToBottom: true, resetHistoryScroll: true })
  }
  if (action === 'toggle-settings') {
    if (state.settingsOpen) {
      state.settingsOpen = false
    } else {
      openSettingsSection(settingsTabs.some(([id]) => id === state.active) ? state.active : 'overview')
    }
    render()
  }
  if (action === 'toggle-attachment-menu') {
    if (state.attachmentMenuOpen) {
      state.attachmentMenuOpen = false
      state.attachmentMenuPosition = null
    } else {
      openAttachmentMenu(target)
    }
    render()
    return
  }
  if (action === 'close-attachment-menu') {
    state.attachmentMenuOpen = false
    state.attachmentMenuPosition = null
    render()
    return
  }
  if (action === 'copy-code') {
    const block = getCodeBlock(target.dataset.messageIndex, target.dataset.codeIndex)
    if (block) {
      void navigator.clipboard.writeText(block.value || '')
      setToast('代码已复制到剪贴板')
    }
  }
  if (action === 'preview-code') {
    const block = getCodeBlock(target.dataset.messageIndex, target.dataset.codeIndex)
    if (block) {
      const previewError = validateCodePreview(block.language || 'html', block.value || '')
      if (previewError) {
        state.preview = null
        state.previewError = previewError
        setToast(previewError)
        return
      }
      state.previewError = ''
      state.preview = {
        type: 'code',
        code: block.value || '',
        language: block.language || 'html',
        title: `${String(block.language || 'HTML').toUpperCase()} 预览`,
      }
      render({ preserveChatScroll: true })
    }
  }
  if (action === 'download-code') {
    const block = getCodeBlock(target.dataset.messageIndex, target.dataset.codeIndex)
    if (block) {
      const blob = new Blob([block.value || ''], { type: 'text/html;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = 'llama-artifact.html'
      document.body.appendChild(anchor)
      anchor.click()
      anchor.remove()
      URL.revokeObjectURL(url)
      setToast('HTML 已保存')
    }
  }
  if (action === 'preview-image') {
    state.preview = {
      type: 'image',
      src: target.dataset.src || '',
      title: target.dataset.title || '图片预览',
    }
    render({ preserveChatScroll: true })
  }
  if (action === 'close-preview') {
    state.preview = null
    render({ preserveChatScroll: true })
  }
  if (action === 'pick-file') void pickAttachment('file')
  if (action === 'pick-image') void pickAttachment('image')
  if (action === 'pick-audio') void pickAttachment('audio')
  if (action === 'pick-text') void pickAttachment('text')
  if (action === 'pick-pdf') void pickAttachment('pdf')
  if (action === 'insert-system-message') {
    if (!state.currentSessionId) state.currentSessionId = makeSessionId()
    state.chatMessages.push({
      role: 'system',
      content: '系统消息：请在这里写给模型的长期要求，发送下一条消息时会一起带上。',
      createdAt: Date.now(),
    })
    state.attachmentMenuOpen = false
    state.attachmentMenuPosition = null
    saveCurrentSession()
    render()
  }
  if (action === 'remove-attachment') {
    state.attachments.splice(Number(target.dataset.index), 1)
    render()
  }
  if (action === 'copy-message') {
    const message = state.chatMessages[Number(target.dataset.index)]
    if (message) {
      void navigator.clipboard.writeText(message.content || '')
      setToast('已复制到剪贴板')
    }
  }
  if (action === 'edit-message') {
    const index = Number(target.dataset.index)
    const message = state.chatMessages[index]
    if (message) {
      state.chatInput = message.content || ''
      state.attachments = message.attachments || []
      state.chatMessages.splice(index, 1)
      saveCurrentSession()
      render()
      setTimeout(() => document.querySelector('[data-chat-input]')?.focus(), 0)
    }
  }
  if (action === 'delete-message') {
    state.chatMessages.splice(Number(target.dataset.index), 1)
    saveCurrentSession()
    render()
  }
  if (action === 'retry-message') void retryMessage(Number(target.dataset.index))
  if (action === 'close-settings') {
    state.settingsOpen = false
    render()
  }
  if (action === 'toggle-sidebar') {
    state.sidebarCollapsed = !state.sidebarCollapsed
    render()
  }
  if (action === 'focus-chat') {
    state.active = 'chat'
    state.view = 'chat'
    state.sidebarPanel = 'chats'
    render({ resetHistoryScroll: true })
    setTimeout(() => {
      const search = document.querySelector('[data-history-search]')
      search?.focus()
      search?.select?.()
    }, 0)
  }
  if (action === 'return-chat') {
    state.active = 'chat'
    state.view = 'chat'
    state.sidebarPanel = 'chats'
    render()
    setTimeout(() => document.querySelector('[data-chat-input]')?.focus(), 0)
  }
  if (action === 'show-terminal') {
    state.view = 'terminal'
    state.sidebarPanel = 'chats'
    state.attachmentMenuOpen = false
    render()
  }
  if (action === 'open-log-settings') {
    openSettingsSection('logs')
    state.view = 'terminal'
    state.sidebarPanel = 'chats'
    render()
  }
  if (action === 'new-chat') {
    startFreshSession()
    render()
  }
  if (action === 'save') void save()
  if (action === 'vram-guard-cancel') {
    state.vramGuard = null
    setToast('已取消启动')
    render()
    return
  }
  if (action === 'vram-guard-confirm') {
    state.vramGuard = null
    setToast('已按你的选择继续启动')
    void doStartServer()
    return
  }
  if (action === 'start') void start()
  if (action === 'stop') void stop()
  if (action === 'health') void health()
  if (action === 'send-chat') void sendChat()
  if (action === 'cancel-chat') void cancelChat()
})

appEl.addEventListener('dragenter', event => {
  if (!dragHasFiles(event.dataTransfer)) return
  event.preventDefault()
  state.dragDepth += 1
  if (!state.draggingFiles) {
    state.draggingFiles = true
    render({ preserveChatScroll: true })
  }
})

appEl.addEventListener('dragover', event => {
  if (!dragHasFiles(event.dataTransfer)) return
  event.preventDefault()
  event.dataTransfer.dropEffect = 'copy'
})

appEl.addEventListener('dragleave', event => {
  if (!dragHasFiles(event.dataTransfer)) return
  state.dragDepth = Math.max(0, state.dragDepth - 1)
  if (state.dragDepth === 0 && state.draggingFiles) {
    state.draggingFiles = false
    render({ preserveChatScroll: true })
  }
})

appEl.addEventListener('drop', event => {
  if (!dragHasFiles(event.dataTransfer)) return
  event.preventDefault()
  const files = droppedFiles(event.dataTransfer)
  state.dragDepth = 0
  state.draggingFiles = false
  render({ preserveChatScroll: true })
  void importDroppedFiles(files)
})

appEl.addEventListener('input', event => {
  const input = event.target
  if (input.dataset?.chatInput !== undefined) {
    state.chatInput = input.value
    return
  }

  if (input.dataset?.historySearch !== undefined) {
    state.historySearch = input.value
    state.historyMenuId = ''
    render({ resetHistoryScroll: true })
    return
  }

  const name = input.dataset?.field
  if (!name) return

  if (input.type === 'checkbox') {
    state.config[name] = input.checked
  } else if (input.type === 'number') {
    state.config[name] = localNumberValue(input)
  } else {
    state.config[name] = input.value
  }
  if (name === 'chat_quality_mode') {
    applyChatQualityMode(input.value)
  }
  if (name === 'theme_mode' || name === 'chat_font') {
    applyAppearancePreferences()
  }
  if (name === 'llama_bin_dir') {
    state.config.llama_server_path = `${String(input.value || '').replace(/[\\/]+$/, '')}\\llama-server.exe`
  }
  state.dirty = true
  refreshConfigWarnings()
})

// 参数面板：滑块 <-> 数字框联动。
// 数字框带 data-field，真正的写配置交给既有 input 处理器；这里只负责两边同步。
appEl.addEventListener('input', event => {
  const slider = event.target?.closest?.('.param-slider')
  if (slider) {
    const input = appEl.querySelector(`.param-input[data-param="${slider.dataset.param}"]`)
    if (input) {
      input.value = slider.value
      input.dispatchEvent(new Event('input', { bubbles: true }))
    }
    return
  }
  const number = event.target?.closest?.('.param-input[data-field]')
  if (number?.dataset?.param) {
    const paired = appEl.querySelector(`.param-slider[data-param="${number.dataset.param}"]`)
    if (paired) paired.value = number.value
  }
})

// 参数面板的开关：不重渲染，直接跟随 checked 切换外观。
appEl.addEventListener('change', event => {
  const box = event.target
  if (box?.type === 'checkbox' && box.closest?.('.param-toggle')) {
    box.closest('.param-toggle').classList.toggle('on', box.checked)
  }
})

// 预设下拉框：切换选项即预览该预设的元信息（真正生效由「加载预设」按钮触发）。
appEl.addEventListener('change', event => {
  if (event.target?.id === 'presetSelect') {
    handlePresetSelect()
  }
  const presetField = event.target?.closest?.('[data-preset-field]')
  if (presetField) updatePresetDraftField(presetField)
})

// 参数编辑器：输入只写草稿，不重渲染（重渲染会丢焦点）。
appEl.addEventListener('input', event => {
  const presetField = event.target?.closest?.('[data-preset-field]')
  if (presetField) updatePresetDraftField(presetField)
})

appEl.addEventListener('keydown', event => {
  if (event.key === 'Escape' && state.presetDraft) {
    closePresetEditor()
    return
  }
  if (event.key === 'Escape' && state.presetDialog) {
    state.presetDialog = null
    render()
    return
  }
  if (event.key === 'Escape' && state.historyDialog) {
    state.historyDialog = null
    render({ preserveChatScroll: true })
    return
  }
  if (event.key === 'Escape' && state.modelInfoOpen) {
    state.modelInfoOpen = false
    render({ preserveChatScroll: true })
    return
  }
  if (event.target?.dataset?.historyTitleInput !== undefined && event.key === 'Enter') {
    event.preventDefault()
    document.querySelector('[data-action="history-save-title"]')?.click()
    return
  }
  if (event.target?.dataset?.presetNameInput !== undefined && event.key === 'Enter') {
    event.preventDefault()
    void submitPresetDialog()
    return
  }
  if (event.target?.dataset?.chatInput !== undefined && event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault()
    void sendChat()
  }
})

async function init() {
  try {
    loadSessions()
    state.tabOrder = loadTabOrder()
    if (!state.currentSessionId) state.currentSessionId = makeSessionId()
    patchFromBackend(await window.llamaDesktop.getState())
    try {
      state.firstRunWizardSeen = window.localStorage?.getItem('llama-desktop:first-run-seen') === '1'
      state.onboardingDone = window.localStorage?.getItem(ONBOARDING_DONE_KEY) === '1'
    } catch {
      state.firstRunWizardSeen = false
      state.onboardingDone = false
    }
    state.firstRunWizardOpen = shouldShowFirstRunWizard({
      config: state.config,
      validation: state.validation,
      status: state.status,
      seen: state.firstRunWizardSeen,
    })
    render()
    // Branding: dynamic version
    window.llamaDesktop.getVersion?.().then(v => {
      document.querySelectorAll('.about-version[data-version]').forEach(el => {
        el.textContent = `v${v}`
      })
    }).catch(() => {})
    // P0: Load presets, engine info, and VRAM
    // loadPresetList 内部已经连摘要一起刷新，不必再单独调一次。
    loadPresetList().then(() => render({ preserveChatScroll: true })).catch(() => {})
    loadEngineList().catch(() => {})
    loadModelList().catch(() => {})
    checkVram().catch(() => {})
    window.llamaDesktop.getSystemInfo?.()
      .then(info => {
        state.systemInfo = info
        // 双保险：get-system-info 也带回一份显存读数。vram-check 若因
        // 驱动/权限失败拿不到，这里仍然能把显存显示出来，不会只剩 RAM。
        if (!Number(state.vramUsage?.total) && Number(info?.vram?.total)) {
          state.vramUsage = info.vram
          state.vramWarning = vramSnapshot(info.vram).warning
        }
        render({ preserveChatScroll: true })
      })
      .catch(() => {})
  } catch (error) {
    appEl.innerHTML = `<div class="boot">${escapeHtml(error.message || String(error))}</div>`
  }

  window.llamaDesktop.onEvent(payload => {
    if (payload.type === 'status') {
      state.status = payload.status
      render({ preserveChatScroll: true })
      return
    }
    if (payload.type === 'logs') {
      if (Array.isArray(payload.logs)) state.logs = { ...state.logs, entries: payload.logs }
      if (payload.logStats) state.logs = { ...state.logs, ...payload.logStats }
      if (state.view === 'terminal') render({ preserveChatScroll: true })
      return
    }
    if (payload.type === 'chat-stream') {
      applyStreamDelta(payload)
      return
    }
    render()
  })
}


// ============================================================
// P0: Preset event handlers
// ============================================================

function handleApplyPreset() {
  const select = document.getElementById('presetSelect')
  const name = select?.value
  if (!name) return
  applyPreset(name)
}

void init()

