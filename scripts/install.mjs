#!/usr/bin/env node
/**
 * 把 dsh-oi-senior（信奥学长）插件安装到 DSH profile。
 *
 * 为什么用 Node 而不是 PowerShell：本机 PowerShell 执行策略禁止运行未签名 .ps1，
 * 而 node 是 DSH 插件的既定运行时，一定可用。
 *
 * 做两件事：
 *  1. 在本包 node_modules/@deepseek-ai 下，为 dsh-tools / schemastery 建立指向
 *     DSH profile 自身副本的 junction（Windows）或 symlink（POSIX）。
 *     这是插件唯一的外部运行期依赖，指向同一份副本可保证版本天然对齐。
 *  2. 在 profile 的 cordis.patch.yml 里插入（或替换）一条 oi-senior 条目，
 *     入口用绝对 file:/// URL —— 因此插件不必拷贝进 DSH 仓库。
 *
 * 用法：
 *   node scripts/install.mjs                  # 安装到 desktop profile
 *   node scripts/install.mjs --preview        # 只打印改动，不落盘
 *   node scripts/install.mjs --uninstall      # 移除条目
 *   node scripts/install.mjs --profile web    # 指定 profile
 */

import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const ENTRY_ID = 'oi-senior'
// 运行期依赖：插件 deps 只用到 dsh-tools 与 schemastery；
// cordis / dsh-system-prompt / dsh-llm 是自检脚本（scripts/verify-prompt-section.mjs 等）用到的，
// 一并链接，保证全新 checkout 上所有 scripts 都能直接跑。
const RUNTIME_DEPS = ['dsh-tools', 'schemastery', 'cordis', 'dsh-system-prompt', 'dsh-llm']

const argv = process.argv.slice(2)
const preview = argv.includes('--preview')
const uninstall = argv.includes('--uninstall')
const profileFlag = argv.indexOf('--profile')
const profile = profileFlag >= 0 ? argv[profileFlag + 1] : 'desktop'

function log(message) { console.log(`[install] ${message}`) }
function fail(message) { console.error(`[install] 失败：${message}`); process.exit(1) }

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', profile)
const patchFile = join(profileDir, 'cordis.patch.yml')
const profileScope = join(dshHome, 'profiles', 'node_modules', '@deepseek-ai')
const localScope = join(ROOT, 'node_modules', '@deepseek-ai')
const entryFile = join(ROOT, 'dist', 'index.js')

if (!existsSync(profileDir)) fail(`profile 目录不存在：${profileDir}`)
if (!existsSync(patchFile)) fail(`找不到 ${patchFile}`)
if (!uninstall && !existsSync(entryFile)) fail(`dist/index.js 不存在，请先运行：node scripts/build.mjs`)

// ---------------------------------------------------------------------------
// 1) 运行期依赖链接
// ---------------------------------------------------------------------------
function linkType() { return process.platform === 'win32' ? 'junction' : 'dir' }

function ensureLink(linkPath, targetPath) {
  if (!existsSync(targetPath)) fail(`依赖目标不存在：${targetPath}`)
  const stat = lstatSync(linkPath, { throwIfNoEntry: false })
  if (stat !== undefined) {
    let resolvedTarget = ''
    try {
      resolvedTarget = realpathSync(linkPath)
    } catch { /* 损坏的链接按需替换 */ }
    if (resolvedTarget === realpathSync(targetPath)) {
      log(`已就绪：${linkPath}`)
      return
    }
    log(`替换已有条目：${linkPath}`)
    if (!preview) rmSync(linkPath, { recursive: true, force: true })
  }
  if (preview) { log(`[preview] 建立 ${linkType()} ${linkPath} -> ${targetPath}`); return }
  mkdirSync(dirname(linkPath), { recursive: true })
  try {
    symlinkSync(targetPath, linkPath, linkType())
  } catch (error) {
    // Windows 无建 symlink 权限时退回目录 junction
    if (process.platform === 'win32') {
      execFileSync('cmd', ['/c', 'mklink', '/J', linkPath, targetPath], { stdio: 'pipe' })
    } else {
      fail(`建立链接失败：${error.message}`)
    }
  }
  if (!existsSync(linkPath)) fail(`链接建立失败：${linkPath}`)
  log(`已建立链接：${linkPath} -> ${targetPath}`)
}

if (uninstall) {
  log('卸载模式：只移除 profile 条目（保留依赖链接，便于下次重装）')
} else {
  for (const pkg of RUNTIME_DEPS) {
    ensureLink(join(localScope, pkg), join(profileScope, pkg))
  }
}

// ---------------------------------------------------------------------------
// 2) cordis.patch.yml 条目
// ---------------------------------------------------------------------------
const uri = pathToFileURL(entryFile).href
log(`插件入口：${uri}`)

const original = readFileSync(patchFile, 'utf8').replace(/\r\n/g, '\n')
const lines = original.split('\n')

// 顶层 `- id: xxx` 切块：profile 的 patch 层里，**平铺条目 = 覆盖既有节点**，
// 而「新增一个插件节点」必须包在 `- insert:` 下（bundle 的 cordis.patch.yml 都是这么写的）。
// 因此本安装器写入的是 insert 形态，并用块标记区分两种块。
const blocks = []
let current = null
for (const line of lines) {
  const insertMatch = /^- insert:\s*$/.exec(line)
  const idMatch = /^- id:\s*(\S+)\s*$/.exec(line)
  if (insertMatch !== null) {
    if (current !== null) blocks.push(current)
    current = { kind: 'insert', id: null, lines: [line] }
  } else if (idMatch !== null) {
    if (current !== null) blocks.push(current)
    current = { kind: 'entry', id: idMatch[1], lines: [line] }
  } else if (current === null) {
    blocks.push({ kind: 'plain', id: null, lines: [line] })
    continue
  }
  if (current !== null && !(insertMatch !== null || idMatch !== null)) current.lines.push(line)
}
if (current !== null) blocks.push(current)

function blockOwnsEntry(block, entryId) {
  if (block.kind === 'entry') return block.id === entryId
  if (block.kind === 'insert') {
    return block.lines.some(line => new RegExp(`^\\s+- id:\\s*${entryId}\\s*$`).test(line))
  }
  return false
}

const before = blocks.length
const kept = blocks.filter(block => !blockOwnsEntry(block, ENTRY_ID))
const removed = before - kept.length
log(`原有块数=${before}，含同名 oi-senior 的块将被替换=${removed > 0 ? '是' : '否'}`)

const newBlock = [
  '- insert:',
  `    - id: ${ENTRY_ID}`,
  `      name: '${uri}'`,
  '      config:',
  '        judge:',
  '          compiler: g++',
  "          std: '-std=c++14'",
  "          optimization: '-O2'",
  '          timeLimitMs: 2000',
  '          compileTimeoutMs: 30000',
  "          workDir: ''",
  '        ima:',
  '          enabled: true',
  "          cliPath: ''",
  "          clientId: ''",
  "          apiKey: ''",
  '          timeoutMs: 20000',
]

const outLines = []
for (const block of kept) outLines.push(...block.lines)
while (outLines.length > 0 && outLines[outLines.length - 1].trim() === '') outLines.pop()
if (!uninstall) outLines.push(...newBlock)
const output = `${outLines.join('\n')}\n`

if (preview) {
  log('[preview] cordis.patch.yml 将变为：')
  console.log(output)
  process.exit(0)
}

writeFileSync(patchFile, output, 'utf8')

/**
 * 落盘后立刻用 profile 自带的 js-yaml 复验：必须仍是合法 YAML 顶层数组，
 * 且 oi-senior 的出现次数等于期望值、位于 insert 列表中。避免给 DSH 留下坏配置层。
 *
 * @param {number} expectedHits 安装路径期望 1；卸载路径期望 0。
 */
function validateWritten(expectedHits) {
  const yamlPath = join(dshHome, 'profiles', 'node_modules', 'js-yaml')
  if (!existsSync(yamlPath)) {
    log('提示：未找到 js-yaml，跳过 YAML 复验')
    return
  }
  let yaml
  try {
    yaml = createRequire(join(dshHome, 'profiles', 'package.json'))('js-yaml')
  } catch (error) {
    log(`提示：无法加载 js-yaml（${error.message}），跳过 YAML 复验`)
    return
  }
  const doc = yaml.load(readFileSync(patchFile, 'utf8'))
  if (!Array.isArray(doc)) fail('复验失败：patch 层不再是顶层数组')
  const inserts = doc.filter(entry => entry !== null && typeof entry === 'object' && Array.isArray(entry.insert))
  const hits = inserts.flatMap(entry => entry.insert).filter(entry => entry && entry.id === ENTRY_ID)
  if (hits.length !== expectedHits) {
    fail(`复验失败：oi-senior 应出现 ${expectedHits} 次，实际 ${hits.length} 次`)
  }
  if (expectedHits === 0) {
    log(`复验通过：YAML 合法，oi-senior 已移除，其余 ${doc.length} 个顶层块保留`)
    return
  }
  const entry = hits[0]
  if (typeof entry.name !== 'string' || !entry.name.startsWith('file:///')) {
    fail(`复验失败：入口必须是 file:/// URL，实际 ${String(entry.name)}`)
  }
  const target = fileURLToPath(entry.name)
  if (!existsSync(target)) fail(`复验失败：入口文件不存在 ${target}`)
  log(`复验通过：YAML 合法，insert 中 oi-senior 唯一，入口可达（共 ${doc.length} 个顶层块）`)
}

if (uninstall) {
  validateWritten(0)
  log(`已移除条目：${patchFile}`)
  process.exit(0)
}

validateWritten(1)

log(`已写入条目：${patchFile}`)
console.log('')
log('安装完成，请注意：')
console.log('  * DSH 需要重启（或该条目被 HMR 热加载）后 oi_solve / oi_judge / oi_archive / oi_doctor 才会出现。')
console.log('  * 归档前请确认 ima 笔记本「信奥学长-题解复盘」已在 ima 客户端创建，随后用 oi_doctor 自检。')
console.log('  * 卸载：node scripts/install.mjs --uninstall')
