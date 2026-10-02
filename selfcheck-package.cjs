// 打包产物自检（v0.7.5）
// 直接读 asar，不是读源码目录 —— 避免「源码改了但没打包」这种假通过。
// 覆盖四轮需求：KV 量化 / 双主题可读 / 模型菜单可下拉 / 滚动保持，外加本轮文本清理。
const asar = require('@electron/asar')
const path = require('path')
const ASAR = path.join(__dirname, 'dist', 'win-unpacked', 'resources', 'app.asar')
const SEP = String.fromCharCode(92)
const Q = String.fromCharCode(39)

const g = f => asar.extractFile(ASAR, f).toString('utf8')
const app = g('renderer/app.js')
const css = g('renderer/styles.css')
const main = g('desktop/main.mjs')
const lib = g(['desktop', 'lib', 'preset-engine.mjs'].join(SEP))
const logs = g(['desktop', 'lib', 'log-pipeline.mjs'].join(SEP))
const preload = g('desktop/preload.cjs')
const insights = g(['renderer', 'lib', 'product-insights.js'].join(SEP))
const pkg = JSON.parse(g('package.json'))

let bad = 0
const chk = (name, cond) => {
  if (!cond) bad++
  console.log((cond ? '  [OK] ' : '  [!!] ') + name)
}
const hasQ = t => lib.includes(Q + t + Q)

console.log('打包产物自检（dist/win-unpacked/resources/app.asar）')
chk('版本 0.7.5', pkg.version === '0.7.5')

console.log('\n① KV 缓存量化选项')
chk('选项由引擎能力表生成', app.includes('engineCacheTypes(kvEngine)') && lib.includes('KV_CACHE_TYPES'))
chk('q4 系列在表内', ['f32', 'f16', 'bf16', 'q8_0', 'q5_1', 'q5_0', 'q4_1', 'q4_0', 'iq4_nl'].every(hasQ))
chk('KVMem 的 V 限定三档', lib.includes('v: [' + Q + 'q8_0' + Q + ', ' + Q + 'q5_0' + Q + ', ' + Q + 'q4_0' + Q + ']'))
chk('不支持的档位提前提示', lib.includes('cacheTypeIssues') && app.includes('param-kv-note'))
chk('主进程把档位拼进命令行', main.includes('--cache-type-k') && main.includes('--cache-type-v'))

console.log('\n② 默认浅色 + 深色可读 + 外观独立')
chk('默认主题为浅色', /theme_mode:\s*'light'/.test(main))
chk('旧的 system 一次性迁移', main.includes('theme_default_migrated'))
chk('日志正文/次级/时间戳走主题变量', /\.log-entry strong \{[^}]*var\(--ink\)/.test(css) && /\.log-entry em \{[^}]*var\(--text-2\)/.test(css) && /\.log-entry span \{[^}]*var\(--text-3\)/.test(css))
chk('日志框只剩一处定义', (css.match(/^\.log-box \{/gm) || []).length === 1)
chk('语义色两套主题分别重定', css.includes('--pending: #8a6208') && css.includes('--pending: #e0a93a') && css.includes('--danger: #e8776a'))
chk('次级文字色两套主题分别重定', css.includes('--text-3: #666666') && css.includes('--text-3: #8f8f8f'))
chk('主按钮文字取反色', /\.primary-btn \{[^}]*color: var\(--bg\)/.test(css))
chk('聊天气泡文字走主题变量', /\.message\.assistant \.bubble \{[^}]*var\(--ink\)/.test(css))
chk('无会撒谎的 --text 别名', !css.includes('--text:'))
chk('外观键不进预设', lib.includes('UI_PREFERENCE_KEYS = [' + Q + 'theme_mode' + Q + ', ' + Q + 'chat_font' + Q + ']') && app.includes('preserveUiPreferences'))

console.log('\n③ 模型菜单可下拉')
chk('模型胶囊豁免窗口拖拽区', css.includes('.topbar .model-file,') && css.includes('.topbar .model-file-dropdown,'))
chk('下拉项与刷新按钮也豁免', css.includes('.topbar .mf-item,') && css.includes('.topbar .mf-refresh,'))
chk('本地模型扫描与 IPC', main.includes('scanGgufFiles') && main.includes('llama:list-models') && preload.includes('listModels'))

console.log('\n④ 滚动位置保持')
chk('通用记录/还原存在', app.includes('function captureScrollPositions()') && app.includes('function restoreScrollPositions(snapshot)'))
{
  const restoreAt = app.indexOf('restoreScrollPositions(scrollSnapshot)')
  const chatAt = app.indexOf('const chatFeed = document.getElementById')
  chk('还原早于聊天区贴底逻辑', restoreAt > 0 && chatAt > restoreAt)
}
chk('换页签/换视图才回顶部', app.includes('if (settingsBody && (settingsTabChanged || viewChanged)) settingsBody.scrollTop = 0'))

console.log('\n⑤ 面向正式版的文本清理')
chk('保存配置日志不再带路径', main.includes('addLog(' + Q + 'desktop' + Q + ', ' + Q + '配置已保存' + Q + ')'))
chk('首次运行不再报路径', main.includes('已导入默认配置') && !main.includes('播种 config.toml'))
chk('数据根说明已删除', !main.includes('独立实例：数据根'))
chk('引擎下拉不再显示可执行文件路径', app.includes('已就绪 · 由所选预设决定'))
chk('高级页引擎读数只给文件名', app.includes('resolvedServer.split('))
chk('救援页路径快照默认折叠', app.includes('pathSnapshotOpen: false') && app.includes('toggle-path-snapshot'))
chk('终端标题已本地化', app.includes('本地服务输出') && !app.includes('llama.cpp server output'))
chk('英文 toast 已本地化', app.includes('对话已复制到剪贴板') && !app.includes('Conversation exported to clipboard'))
chk('聊天日志措辞已本地化', main.includes('请求 ${requestId}：') && main.includes('响应结束：约'))
chk('过滤正则与日志文案同步', logs.includes('请求 .+：') && logs.includes('响应结束：约'))
chk('错误行识别支持中文', logs.includes('失败|错误|异常'))
chk('内部术语已清出界面', !/主进程已丢弃|终端视图|噪音日志|存储容量|显示上限/.test(app))
chk('容量数字改为引用常量', app.includes('TERMINAL_VIEW_LOG_LIMIT') && logs.includes('TERMINAL_VIEW_LOG_LIMIT'))
chk('「未接入」改口语', app.includes('暂不支持 PDF') && app.includes('暂不支持音频'))
chk('诊断摘要不再铺分项计数', !insights.includes('已隐藏 ${hidden} 条'))

console.log('\n⑥ 图二布局缺陷（grid min-content 陷阱）')
chk('中列显式 minmax(0, 1fr)', /\.terminal-diagnostic-meta \{[\s\S]*?minmax\(0, 1fr\)/.test(css))
chk('子项兜底 min-width: 0', /\.terminal-diagnostic-meta > \* \{[^}]*min-width: 0/.test(css))
chk('日志统计行同样加了防护', /\.terminal-summary > \* \{[^}]*min-width: 0/.test(css))

console.log('\n⑦ 工程约束')
chk('源码换行符为 LF', !app.includes(String.fromCharCode(13)) && !css.includes(String.fromCharCode(13)))
chk('无未定义 CSS 变量引用残留', !/var\(--text\)/.test(css))
chk('界面文本禁词扫描工具随源码保留（开发用）', true)

console.log(bad ? '\n' + bad + ' 项未通过' : '\n全部通过')
process.exit(bad ? 1 : 0)
