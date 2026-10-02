// 界面文本禁词扫描（源码层）
//
// 为什么需要它：这一轮清理的问题（绝对路径、内部术语、写死的容量数字）
// 都不是「写错了」，而是「本来就不该出现在这一层」。没有自动检查，
// 下次加功能又会顺手把路径或缓冲容量糊到界面上。
//
// ⚠️ 能力边界（写清楚，免得后人以为它管全了）：
//   源码扫描**看不到插值**。`addLog('desktop', `配置已保存：${config.config_path}`)`
//   在源码里只有「配置已保存：」这几个字，路径是运行时拼进去的。
//   因此**路径泄露由运行时检查负责**：tools/check-rendered-text.cjs
//   （用 CDP 抓真实渲染出来的全部可见文本，断言不含盘符路径与 .exe）。
//   两者分工：
//     源码层 → 内部术语、未本地化的自家日志措辞、散文里的可执行文件名
//     运行时 → 盘符路径、可执行文件名（无论来自字面量还是插值）
//
// 实现说明：上一版尝试「剥注释再解析字面量」，连续两次被 JS 里的
// 正则字面量（如 .replace(/'/g, ...)）带偏，导致把注释当文案报出来。
// 现在改成**按行、有界**的判定：只去掉行尾注释，且引号计数必须为偶数
// 才认为 // 是注释起点 —— 单行内判断，不会串到下一行。
//
// 用法: node tools/lint-ui-text.cjs          命中即非零退出
//       node tools/lint-ui-text.cjs --list   只列不判定
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const FILES = [
  'renderer/app.js',
  'renderer/lib/product-insights.js',
  'renderer/lib/feedback-repair.js',
  'renderer/lib/attachment-policy.js',
  'desktop/main.mjs',
]

const CJK = /[\u4e00-\u9fff]/

const RULES = [
  {
    id: 'absolute-path',
    // 源码里带 CJK 的盘符路径 = 写死的「散文 + 路径」，属于必改
    // （插值形态由运行时检查兜底）
    test: /[A-Za-z]:\\/,
    needsCjk: true,
    why: '面向用户的文案不应写死磁盘路径；路径请走变量并在诊断包里给出',
  },
  {
    id: 'executable-name',
    test: /\.[eE][xX][eE]\b/,
    needsCjk: true,
    why: '面向用户的文案不暴露可执行文件名（指示用户去磁盘上挑文件的说明除外）',
  },
  {
    id: 'internal-main-process',
    test: /主进程/,
    why: '「主进程」是实现概念，用户视角没有这个分层',
  },
  {
    id: 'internal-terminal-view',
    test: /终端视图/,
    why: '「终端视图」是实现概念；直接说「日志」「显示」即可',
  },
  {
    id: 'internal-buffer-capacity',
    test: /存储容量|显示上限/,
    why: '缓冲区容量是内部细节，且常量一改文案就说谎',
  },
  {
    id: 'internal-noise-wording',
    test: /噪音日志/,
    why: '「噪音日志」是过滤实现的说法；用户只需知道「已忽略 N 条无关输出」',
  },
  {
    id: 'internal-seed-wording',
    test: /播种/,
    why: '「播种」是首次运行拷贝默认文件的内部说法，用户看不懂',
  },
  {
    id: 'internal-matching-rule',
    test: /路径含|即识别为/,
    why: '内部的字符串匹配规则不该写进用户提示',
  },
  {
    id: 'untranslated-log-wrapper',
    test: /addLog\(\s*'[^']*',\s*`(?:request |stream done|streaming response|request failed)/,
    why: '自家日志的外层措辞应本地化；翻译时必须同步 log-pipeline 的过滤正则',
  },
]

// 白名单：逐条给出理由。这里只放「指示用户去磁盘上挑文件」这类说明 ——
// 那种场景下文件名是可操作信息，不是装饰。
const ALLOW = [
  { file: 'renderer/app.js', test: /选择包含 llama-server\.exe 的目录/, reason: '指导用户挑目录，文件名可操作' },
  { file: 'renderer/app.js', test: /目录里要有 llama-server\.exe/, reason: '指导用户确认目录内容，文件名可操作' },
  { file: 'renderer/app.js', test: /direct = 直接调用 llama-server\.exe/, reason: '解释 launch_mode 取值差别，文件名是说明的一部分' },
  {
    file: 'renderer/app.js',
    test: /^\s*\['llama-server\.exe',/,
    reason: '救援页路径快照的行标签：这一栏就是在列磁盘上的文件，写文件名才对（该区块已默认折叠）',
  },
  {
    file: 'renderer/lib/product-insights.js',
    test: /llama-server\.exe/,
    reason: '就绪清单的动作文案，指导用户去磁盘上找到这个文件，属可操作指引',
  },
  {
    file: 'renderer/lib/feedback-repair.js',
    test: /llama-server\.exe/,
    reason: '首启向导与救援页在指导用户去官网包里挑哪个文件，文件名可操作',
  },
  { file: 'desktop/main.mjs', test: /llama-server\.exe/, reason: '命令行预览与子进程启动的路径拼接，不是面向用户的文案' },
]

// 去掉行尾注释（单行内有界判断，不跨行）
function stripTrailingComment(line) {
  const idx = line.indexOf('//')
  if (idx < 0) return line
  const head = line.slice(0, idx)
  const quotes = (head.match(/(?<!\\)['"`]/g) || []).length
  // 引号数为奇数 => 这个 // 在字符串里，不是注释
  if (quotes % 2 === 1) return line
  return head
}

const listOnly = process.argv.includes('--list')
const findings = []

for (const rel of FILES) {
  const abs = path.join(ROOT, rel)
  if (!fs.existsSync(abs)) continue
  const lines = fs.readFileSync(abs, 'utf8').split('\n')
  lines.forEach((raw, index) => {
    const trimmed = raw.trim()
    if (!trimmed) return
    // 整行注释 / 块注释续行：跳过（注释里出现「主进程」是正常的）
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return
    const code = stripTrailingComment(raw)
    if (!code.trim()) return
    if (ALLOW.some(a => a.file === rel && a.test.test(code))) return
    for (const rule of RULES) {
      if (!rule.test.test(code)) continue
      if (rule.needsCjk && !CJK.test(code)) continue
      findings.push({ file: rel, line: index + 1, rule: rule.id, why: rule.why, text: code.trim().slice(0, 120) })
      break
    }
  })
}

if (!findings.length) {
  console.log('界面文本禁词扫描（源码层）：通过')
  console.log('  （内部术语 / 散文里的可执行文件名 / 未本地化的自家日志措辞，均未命中）')
  console.log('  提示：盘符路径与插值形态由 tools/check-rendered-text.cjs 在运行时检查')
  process.exit(0)
}

console.log('界面文本禁词扫描（源码层）：发现 ' + findings.length + ' 处')
for (const f of findings) {
  console.log('')
  console.log('  ' + f.file + ':' + f.line + '   [' + f.rule + ']')
  console.log('    ' + f.text)
  console.log('    → ' + f.why)
}
process.exit(listOnly ? 0 : 1)
