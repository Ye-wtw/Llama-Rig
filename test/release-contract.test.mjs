import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const gitignore = readFileSync('.gitignore', 'utf8')
const workflow = readFileSync('.github/workflows/release.yml', 'utf8')
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'))
const builderConfig = readFileSync('electron-builder.yml', 'utf8')

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function readBuilderScalar(key) {
  const match = builderConfig.match(new RegExp(`^\\s*${key}:\\s*(.+)$`, 'm'))
  assert.ok(match, `electron-builder.yml must define ${key}`)
  return match[1].trim().replace(/^['"]|['"]$/g, '')
}

const builderProductName = readBuilderScalar('productName')
const artifactName = readBuilderScalar('artifactName')
const outputDirectory = readBuilderScalar('output')
// artifactName 带 ${version} 宏：解析出真实产物名用于断言。
const VERSION_MACRO = '${version}'
const executableName = artifactName
  .replace(/\$\{ext\}/g, 'exe')
  .replace(/\$\{version\}/g, packageJson.version)
const executablePath = `${outputDirectory}/${executableName}`
const checksumPath = `${executablePath}.sha256`
const releaseTitle = `${packageJson.productName} \${{ github.ref_name }}`

test('ignores all dist variants', () => assert.match(gitignore, /^dist-\*\/$/m))

test('workflow validates strict semver tag against package version', () => {
  assert.match(workflow, /\^v\\d\+\\\.\\d\+\\\.\\d\+\$/)
  assert.match(workflow, /package\.json/)
  assert.match(workflow, /github\.ref_name/)
  assert.match(workflow, /if \(\$tag -ne \$expectedTag\) \{/)
  assert.match(workflow, /throw "Release tag \$tag does not match package\.json version \$\(\$package\.version\)"/)
})

test('产物名带版本号，且与 package.json 同源', () => {
  assert.equal(packageJson.productName, builderProductName)
  assert.ok(artifactName.includes(VERSION_MACRO), 'artifactName 应含 ${version} 宏')
  assert.match(artifactName, /\$\{ext\}/)
  // 解析结果必须真的带上版本号，避免宏被误写成固定串
  assert.equal(executableName, `Llama-Rig-${packageJson.version}.exe`)
})

test('workflow release identity follows package and builder configuration', () => {
  assert.match(workflow, new RegExp(`^\\s*name: ${escapeRegExp(releaseTitle)}\\s*$`, 'm'))
  // CI 不能硬编码文件名（否则每次改版本都要手改 workflow），
  // 而是从 package.json 的 version 派生出与 artifactName 相同的名字。
  assert.match(workflow, /\$package = Get-Content -Raw -LiteralPath package\.json \| ConvertFrom-Json/)
  assert.match(workflow, /\$name = "Llama-Rig-\$version\.\$ext"/, 'workflow 未从 package.json 派生产物名')
  // 两种形态都要出：便携 exe 与解压 zip。
  // 解压版是为了绕开「便携版必须往 %TEMP% 解 430 MB，C 盘紧就失败」这个坑，
  // 少发一个等于把踩坑的用户丢回原地。
  assert.match(workflow, /foreach \(\$ext in @\('exe', 'zip'\)\)/, 'workflow 未同时处理 exe 与 zip')
  assert.match(builderConfig, /^\s*-\s*zip\s*$/m, 'electron-builder.yml 未配置 zip 目标')
  assert.match(workflow, /Get-FileHash -LiteralPath \$path -Algorithm SHA256/)
  assert.match(workflow, /Set-Content -LiteralPath "\$path\.sha256"/)
  // 产物缺失必须直接失败：否则会静默发出一个没有校验和的版本。
  assert.match(workflow, /throw "Release artifact not found/, '产物缺失时 workflow 未报错')
  // 发布资产用版本无关的 glob，避免与版本号脱节
  for (const suffix of ['exe', 'exe.sha256', 'zip', 'zip.sha256']) {
    assert.match(
      workflow,
      new RegExp(`^\\s*dist/Llama-Rig-\\*\\.${escapeRegExp(suffix)}\\s*$`, 'm'),
      `files 未包含 dist/Llama-Rig-*.${suffix}`,
    )
  }
  assert.match(workflow, /generate_release_notes:\s*true/)
})

test('electron-builder 不再依赖 legacy winCodeSign 工具集覆盖', () => {
  // 构建曾受阻于 legacy winCodeSign-2.6.0.7z 里的 macOS 符号链接
  // （未启用开发者模式时 7za 报「无法创建符号链接」并中止）。
  // 正确解法是启用 Windows 开发者模式，而不是往配置里塞 toolsets 覆盖。
  assert.ok(!builderConfig.includes('toolsets'), '不应靠 toolsets 覆盖绕过工具集解压问题')
  assert.match(builderConfig, /forceCodeSigning:\s*false/)
  assert.equal(executablePath, `dist/Llama-Rig-${packageJson.version}.exe`)
  assert.equal(checksumPath, `dist/Llama-Rig-${packageJson.version}.exe.sha256`)
})
