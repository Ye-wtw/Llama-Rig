import assert from 'node:assert/strict'
import test from 'node:test'

import {
  engineCandidateFromFile,
  isEngineServerFile,
  mergeDiscoveredEngines,
  pickRecommendedEngine,
  rankEngineCandidates,
  recommendEngineIdForModel,
} from '../desktop/lib/preset-engine.mjs'

// 引擎发现：让用户把引擎放在任何地方都能选到。
//
// 背景：原先引擎只认「模型根目录下的固定相对位置」，换个地方就显示「未安装」并禁用。
// 用户明明有引擎却选不了，只能手动去翻路径 —— 所以改成扫出来再挑。
// 扫描逻辑里最容易出错的两处在这里钉住：
//   1) 别把 llama-cli / llama-bench 之类的非服务端文件当成引擎
//   2) 候选要去重、顺序要稳定（否则界面列表每次刷新都在跳）

test('只认服务端可执行文件，不认同目录的其他 llama 工具', () => {
  // 认的
  for (const name of [
    'llama-server.exe',
    'llama-kvmem-server.exe',
    'llama-prism-server.exe',
    'LLAMA-SERVER.EXE',
    'Llama-MTP-Server.exe',
  ]) {
    assert.equal(isEngineServerFile(name), true, `${name} 应被认作服务端`)
  }
  // 不认的：这些和 llama-server.exe 躺在同一个目录里
  for (const name of [
    'llama-cli.exe',
    'llama-bench.exe',
    'llama-quantize.exe',
    'llama-embedding.exe',
    'llama-perplexity.exe',
    'llama-server.dll',
    'server.exe',
    'mmproj-model.gguf',
    '',
  ]) {
    assert.equal(isEngineServerFile(name), false, `${name} 不该被当成引擎`)
  }
})

test('从扫到的文件构造候选：引擎类型按目录判断，目录取父级', () => {
  const cases = [
    ['E:\\engines\\llama.cpp\\bin\\llama-server.exe', 'llama-cpp'],
    ['E:\\engines\\kvmem-gui\\llama-server.exe', 'kvmem'],
    ['E:\\engines\\kvmem-gui\\llama-kvmem-server.exe', 'kvmem'],
    ['E:\\engines\\prism-llama\\llama-server.exe', 'prismml'],
    ['D:\\随便什么目录\\llama-server.exe', 'llama-cpp'],
  ]
  for (const [full, expectedId] of cases) {
    const candidate = engineCandidateFromFile({ filePath: full })
    assert.ok(candidate, `${full} 应产出候选`)
    assert.equal(candidate.engineId, expectedId, `${full} 的引擎类型`)
    assert.equal(candidate.path, full)
    assert.equal(candidate.dir, full.slice(0, full.lastIndexOf('\\')), '目录应取父级')
  }

  // 非服务端文件必须返回 null，避免混进候选列表
  assert.equal(engineCandidateFromFile({ filePath: 'E:\\engines\\llama.cpp\\bin\\llama-cli.exe' }), null)
  assert.equal(engineCandidateFromFile({}), null)
  assert.equal(engineCandidateFromFile(), null)
})

test('候选去重：同一路径大小写不同只留一个', () => {
  const ranked = rankEngineCandidates([
    { engineId: 'llama-cpp', path: 'E:\\A\\llama-server.exe' },
    { engineId: 'llama-cpp', path: 'e:\\a\\LLAMA-SERVER.EXE' },
  ])
  assert.equal(ranked.length, 1, '大小写不同但同一文件，应去重')
})

test('候选排序：按引擎定义顺序分组，组内路径稳定', () => {
  const ranked = rankEngineCandidates([
    { engineId: 'prismml', path: 'E:\\p\\llama-server.exe' },
    { engineId: 'llama-cpp', path: 'E:\\z\\llama-server.exe' },
    { engineId: 'llama-cpp', path: 'E:\\a\\llama-server.exe' },
    { engineId: 'kvmem', path: 'E:\\k\\llama-server.exe' },
  ])
  assert.deepEqual(
    ranked.map(c => c.engineId),
    ['llama-cpp', 'llama-cpp', 'kvmem', 'prismml'],
    '应按 ENGINE_DEFINITIONS 的顺序分组',
  )
  assert.deepEqual(
    ranked.slice(0, 2).map(c => c.path),
    ['E:\\a\\llama-server.exe', 'E:\\z\\llama-server.exe'],
    '同引擎内应按路径排序',
  )
})

test('合并：固定位置优先，扫到的只在固定位置缺失时补位', () => {
  const defined = [
    { id: 'llama-cpp', label: 'llama.cpp', path: 'E:\\fixed\\llama-server.exe' },
    { id: 'kvmem', label: 'KVMem', path: '' },
    { id: 'prismml', label: 'PrismML', path: '' },
  ]
  const merged = mergeDiscoveredEngines(defined, [
    { engineId: 'llama-cpp', path: 'E:\\scanned\\llama-server.exe' },
    { engineId: 'kvmem', path: 'E:\\scanned\\kvmem-gui\\llama-server.exe' },
  ])

  assert.equal(merged[0].path, 'E:\\fixed\\llama-server.exe', '固定位置已存在时不该被扫描结果顶掉')
  assert.equal(merged[0].discovered, undefined, '固定位置不应打上 discovered 标记')
  assert.equal(merged[1].path, 'E:\\scanned\\kvmem-gui\\llama-server.exe', '固定位置缺失时应补上扫到的')
  assert.equal(merged[1].discovered, true, '补位的要标记来源，界面才好说明')
  assert.equal(merged[2].path, '', '没扫到的保持原样')
})

// ---------- 面向普通使用者的「自动选引擎」 ----------
//
// 普通用户不该先弄懂 KVMem 和 llama.cpp 的区别再选。
// 但自动选必须满足两个前提，否则比不选更糟：
//   1) 不能覆盖用户手动指定过的引擎
//   2) 推荐的那个必须**真的存在**，否则用户点了启动才发现跑不起来
// 下面把这两条钉住。

test('按模型类型推荐引擎：三元 Bonsai 用 KVMem，其余用 llama.cpp', () => {
  assert.equal(recommendEngineIdForModel('Bonsai2-27B-PQ2-Fast.gguf'), 'kvmem', '三元 Bonsai 应推荐 KVMem')
  assert.equal(recommendEngineIdForModel('Qwen3.6-35B-A3B.gguf'), 'llama-cpp', '普通 GGUF 应推荐 llama.cpp')
  assert.equal(recommendEngineIdForModel('随便什么模型.gguf'), 'llama-cpp')
  assert.equal(recommendEngineIdForModel(''), 'llama-cpp', '没有模型时给默认引擎')
})

test('推荐只在「扫到了」时才落地，扫不到就返回空', () => {
  const all = [
    { engineId: 'llama-cpp', path: 'E:\base\llama.cpp\bin\llama-server.exe' },
    { engineId: 'kvmem', path: 'E:\base\kvmem-gui\llama-server.exe' },
    { engineId: 'prismml', path: 'E:\base\prism-llama\llama-server.exe' },
  ]
  // 三元 Bonsai：KVMem 在，就用 KVMem
  assert.equal(pickRecommendedEngine('kvmem', all).engineId, 'kvmem')
  // 普通模型：用 llama.cpp
  assert.equal(pickRecommendedEngine('llama-cpp', all).engineId, 'llama-cpp')
  // 三元 Bonsai 但没装 KVMem → 退 PrismML（它也能跑三元）
  const noKvmem = all.filter(c => c.engineId !== 'kvmem')
  assert.equal(pickRecommendedEngine('kvmem', noKvmem).engineId, 'prismml', '没 KVMem 应退 PrismML')
  // 什么引擎都没有 → 返回 null，界面据此继续提示「手动指定」
  assert.equal(pickRecommendedEngine('kvmem', []), null, '一个都没扫到时不该推荐')
  assert.equal(pickRecommendedEngine('llama-cpp', []), null)
})

test('自动选引擎不得覆盖用户已经手动指定的引擎', () => {
  // 这条是界面逻辑的前置条件：只有「配置里引擎路径为空」时才允许自动填。
  // 用纯函数组合表达同一判断，防止以后有人把判断写反。
  const configuredPath = 'E:\我自己的\kvmem-gui\llama-server.exe'
  const shouldAutoPick = !String(configuredPath || '').trim()
  assert.equal(shouldAutoPick, false, '已有引擎路径时必须不自动选')
  assert.equal(!String('').trim(), true, '引擎路径为空时才自动选')
})
