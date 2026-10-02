// 设置左栏页签排序的纯逻辑层。
// 参照 renderer/lib/product-insights.js 的既有模式：不碰 DOM、不碰 localStorage，
// 因此可以被 node --test 直接覆盖（排序与"升级后不丢新页签"这两条最容易写错）。

// 页签表形如 [['overview', '图标', '概述', '提示'], ...]，这里只关心 id。
export function tabsDefaultOrder(tabs = []) {
  return tabs.map(([id]) => id)
}

// 把任意外部数据(旧版本 localStorage、手改过的 JSON)规整成一份安全顺序：
// 1) 丢掉已经不存在的 id；2) 把没出现过的页签补到末尾，保证永远不丢页签。
export function normalizeTabOrder(rawOrder, tabs = []) {
  const fallback = tabsDefaultOrder(tabs)
  if (!Array.isArray(rawOrder)) return fallback
  const known = rawOrder.filter(id => fallback.includes(id))
  return [...known, ...fallback.filter(id => !known.includes(id))]
}

// 按给定顺序返回完整页签对象；即使顺序残缺也会补全。
export function orderTabsById(tabs = [], order) {
  const byId = new Map(tabs.map(tab => [tab[0], tab]))
  return normalizeTabOrder(order, tabs)
    .map(id => byId.get(id))
    .filter(Boolean)
}

// 把某个页签上移/下移一格；越界时原样返回（按钮本身也会置灰）。
export function moveTabInOrder(order, id, delta, tabs = []) {
  const current = normalizeTabOrder(order, tabs)
  const index = current.indexOf(id)
  if (index < 0) return current
  const target = index + delta
  if (target < 0 || target >= current.length) return current
  const next = [...current]
  const swapped = next[target]
  next[target] = next[index]
  next[index] = swapped
  return next
}
