import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  moveTabInOrder,
  normalizeTabOrder,
  orderTabsById,
  tabsDefaultOrder,
} from '../renderer/lib/tab-order.js'

const TABS = [
  ['overview', 'i', '概述', 'h'],
  ['display', 'i', '展示', 'h'],
  ['sampling', 'i', '采样', 'h'],
  ['presets', 'i', '预设', 'h'],
  ['logs', 'i', '日志', 'h'],
]

test('默认顺序就是页签表的声明顺序', () => {
  assert.deepEqual(tabsDefaultOrder(TABS), ['overview', 'display', 'sampling', 'presets', 'logs'])
})

test('未知 id 被丢弃，新页签补到末尾（升级后不丢页签）', () => {
  const saved = ['logs', 'ghost-tab', 'overview']
  const order = normalizeTabOrder(saved, TABS)
  assert.deepEqual(order, ['logs', 'overview', 'display', 'sampling', 'presets'])
  assert.equal(order.length, TABS.length)
})

test('乱入的非数组数据回退成默认顺序', () => {
  for (const bad of [null, undefined, 'logs', 42, { order: [] }]) {
    assert.deepEqual(normalizeTabOrder(bad, TABS), tabsDefaultOrder(TABS))
  }
})

test('orderTabsById 永远返回全部页签', () => {
  const ordered = orderTabsById(TABS, ['presets', 'logs'])
  assert.equal(ordered.length, TABS.length)
  assert.deepEqual(ordered.slice(0, 2).map(tab => tab[0]), ['presets', 'logs'])
  const ids = ordered.map(tab => tab[0])
  for (const [id] of TABS) assert.ok(ids.includes(id), '丢了页签 ' + id)
})

test('moveTabInOrder 交换相邻页签', () => {
  assert.deepEqual(moveTabInOrder(null, 'display', -1, TABS), ['display', 'overview', 'sampling', 'presets', 'logs'])
  assert.deepEqual(moveTabInOrder(null, 'display', 1, TABS), ['overview', 'sampling', 'display', 'presets', 'logs'])
})

test('moveTabInOrder 越界或未知 id 时原样返回', () => {
  assert.deepEqual(moveTabInOrder(null, 'overview', -1, TABS), tabsDefaultOrder(TABS))
  assert.deepEqual(moveTabInOrder(null, 'logs', 1, TABS), tabsDefaultOrder(TABS))
  assert.deepEqual(moveTabInOrder(null, 'nope', 1, TABS), tabsDefaultOrder(TABS))
})

test('真实 settingsTabs 与排序模块自洽（7 个页签一个都不能丢）', () => {
  const source = readFileSync(path.resolve(import.meta.dirname, '../renderer/app.js'), 'utf8')
  const start = source.indexOf('const settingsTabs = [')
  const end = source.indexOf('const appEl =')
  assert.ok(start > 0 && end > start, '未找到 settingsTabs 声明块')
  const block = source.slice(start, end)
  const ids = [...block.matchAll(/\[\s*'([a-z0-9-]+)'\s*,/g)].map(match => match[1])
  // 2026-09-28：采样/惩罚两个页签与主界面「参数」视图 100% 重复，已删除。
  // 2026-09-29：MCP（纯占位、零操作项）与「进出口」（direct 模式下整页空白）
  //             实测确认无用，已删除 → 9 收敛到 7。
  assert.equal(ids.length, 7, 'settingsTabs 应有 7 个页签，实际 ' + ids.length)
  assert.ok(!ids.includes('sampling') && !ids.includes('penalty'), '重复的采样/惩罚页签应已移除')
  assert.ok(!ids.includes('mcp'), '纯占位的 MCP 页签应已移除')
  assert.ok(!ids.includes('io'), 'direct 模式下整页空白的「进出口」页签应已移除')
  assert.ok(ids.includes('presets'), 'settingsTabs 缺少 presets')

  const tabs = ids.map(id => [id, '', id, ''])
  // 残缺顺序（模拟旧版本只存了 3 个）不能把其余页签挤没；
  // 旧版本存过的 sampling/penalty/io/mcp 属于未知 id，应被丢弃而不是报错。
  assert.equal(normalizeTabOrder(ids.slice(0, 3), tabs).length, 7)
  assert.equal(normalizeTabOrder(['sampling', 'penalty', 'overview'], tabs).length, 7, '旧顺序里的已删页签应被丢弃')
  assert.equal(normalizeTabOrder(['io', 'mcp', 'presets'], tabs).length, 7, '旧顺序里的 io/mcp 应被丢弃且补齐其余页签')
  // 每个页签上下移动后仍是完整的 7 个
  for (const id of ids) {
    assert.equal(moveTabInOrder(ids, id, -1, tabs).length, 7)
    assert.equal(moveTabInOrder(ids, id, 1, tabs).length, 7)
  }
})
