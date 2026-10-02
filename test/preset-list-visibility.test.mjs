import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

// 左侧预设列表「看得见 / 看不见」的契约。
//
// 背景（v0.8.1 实测发现的 bug）：保存一个新预设后，它只在设置区出现，
// 左侧列表里没有。原因是两件事叠在一起：
//   1) 摘要（presetSummaries）只在启动时取一次快照，保存预设后没刷新；
//   2) 左侧列表用摘要做过滤，把「摘要里查不到」当成了「跟当前模型无关」。
// 于是用户自己的预设被自己的过滤条件藏了起来，而且没有任何报错。
//
// 这两条都要钉住：刷新必须成对，过滤必须「失败即放行」。

const rendererSource = readFileSync(new URL('../renderer/app.js', import.meta.url), 'utf8')

function functionBody(name) {
  const start = rendererSource.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `没找到函数 ${name} —— 正则/函数名可能已改，测试必须跟着改`)
  // 从函数头往后取到下一个顶层 function 声明为止，足够覆盖函数体。
  const rest = rendererSource.slice(start)
  const nextTopLevel = rest.indexOf('\nfunction ', 10)
  return nextTopLevel > 0 ? rest.slice(0, nextTopLevel) : rest
}

test('loadPresetList 必须连摘要一起刷新（否则新建的预设会被过滤掉）', () => {
  const body = functionBody('loadPresetList')
  assert.match(
    body,
    /loadPresetSummaries\s*\(/,
    'loadPresetList 必须调用 loadPresetSummaries：保存/改名/复制/删除都只调 loadPresetList，'
      + '它不刷摘要的话，新预设进不了摘要，就会被左侧列表的过滤条件当成「无关」而消失',
  )
})

test('左侧列表过滤必须「失败即放行」：摘要里查不到的预设一律保留', () => {
  const body = functionBody('presetsForCurrentModel')

  // 必须先把摘要里的名字收成一个集合，再用它判断「摘要到底有没有覆盖这个预设」。
  assert.match(
    body,
    /new Set\(summaries\.map/,
    'presetsForCurrentModel 需要把摘要里的名字收成集合，才能区分「摘要说它无关」和「摘要根本没它的信息」',
  )

  // 关键断言：不在摘要里的必须保留（!summarized.has(name) 参与 or 条件）。
  assert.match(
    body,
    /!\s*summarized\.has\(\s*name\s*\)/,
    '过滤条件里必须有 !summarized.has(name)：摘要没覆盖到就保留。'
      + '去掉它等于把用户刚存好的预设藏起来（v0.8.1 的现象）',
  )

  // 不能退化成「只信摘要」——那正是出问题的写法。
  assert.doesNotMatch(
    body,
    /const names = all\.filter\(\s*name\s*=>\s*specific\.includes\(name\)\s*\|\|\s*generic\.includes\(name\)\s*,?\s*\)/,
    '过滤条件退化回「只信摘要」了：摘要没覆盖的预设会被静默丢弃',
  )
})

test('预设增删改之后确实会刷新列表', () => {
  // 保存 / 改名 / 复制 / 删除 的处理函数里应当出现 loadPresetList，
  // 否则改动不会反映到界面上。
  const dialogStart = rendererSource.indexOf('async function submitPresetDialog(')
  assert.ok(dialogStart >= 0, '没找到 submitPresetDialog')
  const dialogBody = rendererSource.slice(dialogStart, dialogStart + 3000)
  assert.match(
    dialogBody,
    /await loadPresetList\(\)/,
    '保存/改名/复制完成后必须 await loadPresetList()，让名单与摘要一起更新',
  )
})
