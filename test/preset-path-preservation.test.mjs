import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import {
  PRESET_PATH_FIELDS,
  applyPresetOverCurrent,
  restoreEmptyPathFields,
} from '../desktop/lib/preset-engine.mjs'

// 这条 bug 的完整链路（v0.8.3 实测发现）：
//
//   预设文件里 llama_server_path = ""
//        ↓  readPreset → normalizeConfig 按「完整配置」补齐，算出
//          llama_server_path = path.join(llamaBinDir, serverFileName)
//        ↓  这个值是**非空**的默认路径，不是空串
//        ↓  applyPresetOverCurrent 看到「预设声明了路径」，于是预设优先
//        ↓  用户配好的 KVMem 引擎路径被换成默认路径
//
// 注释里曾写「normalizeConfig 会把路径填成空串」——代码并非如此。
// 这个不一致让「预设里留空 = 沿用当前」这条规则在读取阶段就失效了。

const RAW_PRESET = {
  // 随包示例预设的样子：路径留空，只带参数
  launch_mode: 'direct',
  llama_server_path: '',
  model: '',
  host: '127.0.0.1',
  port: 18200,
  ctx_size: 8192,
  n_gpu_layers: 99,
  threads: 0,
}

// normalizeConfig 的真实行为：路径字段被算成非空的默认路径
const AFTER_NORMALIZE = {
  ...RAW_PRESET,
  llama_bin_dir: 'D:\\llama.cpp\\bin',
  llama_server_path: 'D:\\llama.cpp\\bin\\llama-server.exe',
}

const CURRENT_CONFIG = {
  llama_server_path: 'E:\\AI_workspace\\00_models_Base\\kvmem-gui\\llama-server.exe',
  llama_bin_dir: 'E:\\AI_workspace\\00_models_Base\\kvmem-gui',
  model: 'E:\\models\\my-model.gguf',
  ctx_size: 4096,
  n_gpu_layers: 17,
  threads: 12,
}

test('文件里留空的路径字段，读取后必须还原为空', () => {
  const restored = restoreEmptyPathFields(AFTER_NORMALIZE, RAW_PRESET)
  assert.equal(restored.llama_server_path, '', 'llama_server_path 应还原为空串')
  assert.equal(restored.llama_bin_dir, '', 'llama_bin_dir 应还原为空串')
  assert.equal(restored.model, '', 'model 应还原为空串')
  // 非路径字段不受影响：参数照旧以预设为准
  assert.equal(restored.ctx_size, 8192)
  assert.equal(restored.n_gpu_layers, 99)
  assert.equal(restored.port, 18200)
})

test('不还原就会被覆盖 —— 这正是修复前的行为，说明这一步不能省', () => {
  const broken = applyPresetOverCurrent(CURRENT_CONFIG, AFTER_NORMALIZE)
  assert.notEqual(
    broken.llama_server_path,
    CURRENT_CONFIG.llama_server_path,
    '没有还原步骤时，默认路径会覆盖用户的引擎路径（bug 的现场）',
  )
  assert.equal(broken.llama_server_path, 'D:\\llama.cpp\\bin\\llama-server.exe')
})

test('还原之后套用：引擎与模型路径保持不动，参数正常更新', () => {
  const restored = restoreEmptyPathFields(AFTER_NORMALIZE, RAW_PRESET)
  const merged = applyPresetOverCurrent(CURRENT_CONFIG, restored)

  assert.equal(merged.llama_server_path, CURRENT_CONFIG.llama_server_path, '引擎路径不得被换掉')
  assert.equal(merged.llama_bin_dir, CURRENT_CONFIG.llama_bin_dir, '引擎目录不得被换掉')
  assert.equal(merged.model, CURRENT_CONFIG.model, '模型路径不得被清掉')
  // 参数该更新的还是要更新
  assert.equal(merged.ctx_size, 8192)
  assert.equal(merged.n_gpu_layers, 99)
})

test('预设里真写了路径时，仍然以预设为准（别把修复做成「路径永远不生效」）', () => {
  const withPath = { ...AFTER_NORMALIZE, model: 'D:\\models\\other.gguf' }
  const rawWithPath = { ...RAW_PRESET, model: 'D:\\models\\other.gguf' }
  const restored = restoreEmptyPathFields(withPath, rawWithPath)
  assert.equal(restored.model, 'D:\\models\\other.gguf', '预设显式声明的路径不能被清掉')

  const merged = applyPresetOverCurrent(CURRENT_CONFIG, restored)
  assert.equal(merged.model, 'D:\\models\\other.gguf', '预设声明的路径应覆盖当前值')
  // 没声明的那个仍然沿用当前
  assert.equal(merged.llama_server_path, CURRENT_CONFIG.llama_server_path)
})

test('PRESET_PATH_FIELDS 覆盖了所有会让预设「不可用」的路径', () => {
  for (const field of ['model', 'mmproj', 'llama_server_path', 'llama_bin_dir', 'launcher_path', 'config_path', 'lora_paths']) {
    assert.ok(PRESET_PATH_FIELDS.includes(field), `路径白名单缺少 ${field}`)
  }
})

test('readPreset 的管线里确实调用了还原步骤', () => {
  // readPreset 依赖 Electron 的 app 对象，无法直接 import，
  // 所以这里用文本契约钉住接线：少了这一步，上面几条测试保证的性质就不会生效。
  const main = readFileSync(new URL('../desktop/main.mjs', import.meta.url), 'utf8')
  const start = main.indexOf('async function readPreset(')
  assert.ok(start >= 0, '没找到 readPreset')
  const body = main.slice(start, start + 1200)
  assert.match(body, /restoreEmptyPathFields\(/, 'readPreset 未调用 restoreEmptyPathFields')
  assert.match(body, /restoreEmptyPathFields\(\s*[\s\S]*?parsed,?\s*\)/, 'readPreset 应把解析出的原始值传给还原步骤')
})
