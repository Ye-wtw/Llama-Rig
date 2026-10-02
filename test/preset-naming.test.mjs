import assert from 'node:assert/strict'
import test from 'node:test'

import { presetNameIssue } from '../renderer/lib/preset-naming.js'

const EXISTING = ['Bonsai2-27B-PQ2-KVMem', 'Qwen3.5-9B']

test('空名与非法字符被拒绝', () => {
  assert.equal(presetNameIssue('', {}, EXISTING), '名称不能为空')
  assert.equal(presetNameIssue('   ', {}, EXISTING), '名称不能为空')
  for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
    assert.match(presetNameIssue(bad, {}, EXISTING), /不能包含/, bad + ' 应被拒绝')
  }
})

test('带后缀或以点开头会被拒绝', () => {
  assert.match(presetNameIssue('MyPreset.config.toml', {}, EXISTING), /不用带/)
  assert.match(presetNameIssue('.hidden', {}, EXISTING), /不能以点开头/)
})

test('重名返回 EXISTS 而不是直接通过', () => {
  assert.equal(presetNameIssue('Qwen3.5-9B', { type: 'save' }, EXISTING), 'EXISTS:Qwen3.5-9B')
  assert.equal(presetNameIssue('Qwen3.5-9B', { type: 'duplicate' }, EXISTING), 'EXISTS:Qwen3.5-9B')
})

test('回归：另存用一个已有名字时必须仍然报 EXISTS', () => {
  // 事故：早先拿"下拉框当前选中项"当比较基准，于是"另存为"沿用选中预设的名字时
  // 被误判成无冲突，直接静默覆盖 —— 重名守卫形同不存在。
  const target = 'Qwen3.5-9B'
  assert.equal(
    presetNameIssue(target, { type: 'save', target }, EXISTING),
    'EXISTS:Qwen3.5-9B',
    '另存为同名时必须先让用户确认覆盖',
  )
})

test('只有"重命名成它自己的原名"才算无冲突', () => {
  assert.equal(presetNameIssue('Qwen3.5-9B', { type: 'rename', target: 'Qwen3.5-9B' }, EXISTING), '')
  assert.equal(presetNameIssue('Qwen3.5-9B', { type: 'rename', target: '别的东西' }, EXISTING), 'EXISTS:Qwen3.5-9B')
})

test('全新名字一律通过', () => {
  assert.equal(presetNameIssue('My-New-Preset', { type: 'save' }, EXISTING), '')
  assert.equal(presetNameIssue('My-New-Preset', { type: 'rename', target: 'Qwen3.5-9B' }, EXISTING), '')
})

test('名字两端空白会被裁掉后判定', () => {
  assert.equal(presetNameIssue('  Qwen3.5-9B  ', { type: 'save' }, EXISTING), 'EXISTS:Qwen3.5-9B')
})
