// 预设命名的纯规则层：不碰 DOM，可被 node --test 直接覆盖。
// 放在 renderer/lib 与 product-insights.js 等渲染侧纯逻辑同层。
import { PRESET_SUFFIX } from '../../desktop/lib/preset-engine.mjs'

// Windows 文件名非法字符 + 路径分隔符，一次拦掉。
const PRESET_NAME_ILLEGAL = /[\\/:*?"<>|]/

// 返回 '' 表示合法；'EXISTS:<名字>' 表示重名（另存/复制允许再次确认覆盖）。
//
// 注意重名判定的边界：只有「重命名成它自己的原名」才算无冲突（等价于什么都没做）。
// 早先这里比的是"下拉框里当前选中的预设"，于是「另存为」用同一个名字时会被
// 误判成"没有冲突"而静默覆盖，重名守卫形同不存在。
export function presetNameIssue(name, { type, target } = {}, existingNames = []) {
  const trimmed = String(name || '').trim()
  if (!trimmed) return '名称不能为空'
  if (PRESET_NAME_ILLEGAL.test(trimmed)) return '名称不能包含 \\ / : * ? " < > | 这些字符'
  if (trimmed.endsWith(PRESET_SUFFIX)) return '名称不用带 ' + PRESET_SUFFIX + ' 后缀'
  if (trimmed.startsWith('.')) return '名称不能以点开头'

  const exists = Array.isArray(existingNames) && existingNames.includes(trimmed)
  const renamingToItself = type === 'rename' && trimmed === target
  if (exists && !renamingToItself) return 'EXISTS:' + trimmed
  return ''
}
