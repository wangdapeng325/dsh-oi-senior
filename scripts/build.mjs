#!/usr/bin/env node
/**
 * dsh-oi-senior 构建脚本。
 *
 * 本插件源码是 ESM JavaScript（扩展名沿用 .ts 仅为与技能包命名习惯一致），
 * 因此"构建"= 类型擦除式的拷贝：src/*.ts -> dist/*.js。
 *
 * 因为本机没有针对本包的 tsc 配置，构建阶段只保证两件不依赖框架的事：
 *   1. 产物确实生成；
 *   2. 每个产物通过 `node --check` 语法校验。
 *
 * 真正的"接线是否正确"由两个独立脚本证明，它们不修改本目录：
 *   - scripts/verify-real.mjs  用真实 @deepseek-ai/* 加载 dist 并调用 apply()（推荐）
 *   - node scripts/build.mjs --selftest  用桩 + 临时目录模拟加载（无依赖时的兜底）
 *
 * 用法：
 *   node scripts/build.mjs              # 构建 + 语法校验
 *   node scripts/build.mjs --selftest   # 额外跑桩接线自检
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const SRC = join(ROOT, 'src')
const DIST = join(ROOT, 'dist')

const args = new Set(process.argv.slice(2))

function log(message) {
  console.log(`[build] ${message}`)
}

function fail(message) {
  console.error(`[build] 失败：${message}`)
  process.exit(1)
}

/** 1) 拷贝 src -> dist */
function build() {
  rmSync(DIST, { recursive: true, force: true })
  mkdirSync(DIST, { recursive: true })
  const sources = readdirSync(SRC).filter(file => extname(file) === '.ts')
  if (sources.length === 0) fail(`src/ 下没有 .ts 源码：${SRC}`)
  for (const file of sources) {
    const name = file.replace(/\.ts$/, '.js')
    copyFileSync(join(SRC, file), join(DIST, name))
    log(`src/${file} -> dist/${name}`)
  }
  return sources.map(file => file.replace(/\.ts$/, '.js'))
}

/** 2) 语法校验：node --check 每个产物 */
function checkSyntax(products) {
  for (const file of products) {
    const target = join(DIST, file)
    try {
      execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' })
      log(`语法 OK：dist/${file}`)
    } catch (error) {
      const detail = error && error.stderr ? error.stderr.toString() : String(error)
      fail(`dist/${file} 语法错误：\n${detail}`)
    }
  }
}

/**
 * 3) 兜底接线自检：在没有真实 @deepseek-ai/* 时，用一个**临时目录**做沙箱，
 *    把 dist 产物拷进去、放上桩依赖，加载并调用 apply()。
 *    全程不碰本包目录（本包 node_modules 里放的是指向真实 DSH 包的 junction）。
 */
const STUB_DEFINE_TOOL = 'export function defineTool(definition) { return definition }\n'
const STUB_SCHEMA = `function make(tag, extra) {
  const node = { _tag: tag, ...(extra ?? {}) }
  node.default = (value) => ({ ...node, _default: value })
  node.optional = () => ({ ...node, _optional: true })
  return node
}
const factory = (tag) => (extra) => make(tag, extra)
const Schema = {
  object: (shape) => make('object', { shape }),
  array: (item) => make('array', { item }),
  string: () => make('string'),
  number: () => make('number'),
  boolean: () => make('boolean'),
  union: (values) => make('union', { values }),
}
export default Schema
`

function writeStub(dir, name, body) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version: '0.0.0-stub',
    type: 'module',
    main: 'index.js',
    exports: { '.': './index.js' },
  }, null, 2))
  writeFileSync(join(dir, 'index.js'), body)
}

async function selftest(products) {
  const sandbox = join(tmpdir(), `oi-senior-selftest-${process.pid}`)
  rmSync(sandbox, { recursive: true, force: true })
  mkdirSync(join(sandbox, 'dist'), { recursive: true })
  for (const file of products) {
    copyFileSync(join(DIST, file), join(sandbox, 'dist', file))
  }
  writeStub(join(sandbox, 'node_modules', '@deepseek-ai', 'dsh-tools'), '@deepseek-ai/dsh-tools', STUB_DEFINE_TOOL)
  writeStub(join(sandbox, 'node_modules', '@deepseek-ai', 'schemastery'), '@deepseek-ai/schemastery', STUB_SCHEMA)
  writeFileSync(join(sandbox, 'package.json'), JSON.stringify({ name: 'oi-senior-selftest', type: 'module' }, null, 2))
  log(`桩沙箱：${sandbox}`)

  let mod
  try {
    mod = await import(pathToFileURL(join(sandbox, 'dist', 'index.js')).href)
  } catch (error) {
    fail(`桩沙箱加载失败：${error && error.stack ? error.stack : error}`)
  }

  const registered = []
  const ctx = { tools: { register: (definition) => { registered.push(definition); return () => {} } } }
  const config = {
    judge: { compiler: 'g++', std: '-std=c++14', optimization: '-O2', timeLimitMs: 2000, compileTimeoutMs: 30000, workDir: '' },
    ima: { enabled: false, cliPath: '', clientId: '', apiKey: '', timeoutMs: 20000 },
  }
  try {
    mod.apply(ctx, config)
  } catch (error) {
    fail(`apply() 抛异常：${error && error.stack ? error.stack : error}`)
  }

  const expected = ['oi_solve', 'oi_judge', 'oi_archive', 'oi_doctor']
  const names = registered.map(tool => tool.name)
  for (const want of expected) {
    if (!names.includes(want)) fail(`缺少工具 ${want}（实际：${names.join(', ')}）`)
  }
  for (const tool of registered) {
    if (typeof tool.execute !== 'function') fail(`${tool.name} 缺少 execute`)
    if (tool.output?.render === undefined) fail(`${tool.name} 缺少 output.render`)
  }

  const solve = registered.find(tool => tool.name === 'oi_solve')
  const value = await solve.execute({ topic: 'P7077 函数调用' }, { signal: undefined })
  if (value?.persona === undefined) fail('oi_solve 返回结构不对')
  if (value.archive?.notebook !== '信奥学长-题解复盘') fail('归档笔记本名不对')

  const archive = registered.find(tool => tool.name === 'oi_archive')
  const archived = await archive.execute({
    title: 'P7077 [CSP-S 2020] 函数调用 - 树形DP+拓扑序',
    source: '洛谷 （ https://www.luogu.com.cn/problem/P7077 ）',
    difficulty: '（蓝题）提高+/省选−',
    gist: '给定函数调用关系，求最终序列。',
    concepts: '拓扑排序与逆序处理。',
    approach: '先建图，再按调用顺序处理。',
    pitfalls: '注意乘法的逆元与取模。',
    code: 'int main(){return 0;}',
    complexity: '时间 O(n+m)，空间 O(n+m)。',
    verdictEvidence: '用题目公开样例 2 组真编译评测，全部 AC。',
  }, { signal: undefined })
  if (archived.action !== 'skipped') fail(`ima 关闭时应为 skipped，实际 ${String(archived.action)}`)
  if (archived.silent !== true || archived.statusLine !== '') fail('ima 关闭时必须静默跳过')
  if (!Array.isArray(archived.formatIssues) || archived.formatIssues.length !== 0) {
    fail(`合规 markdown 不应有格式问题：${JSON.stringify(archived.formatIssues)}`)
  }

  rmSync(sandbox, { recursive: true, force: true })
  log('桩接线自检通过 ✅（注意：这只证明接线正确，不证明真实框架兼容性）')
}

const products = build()
checkSyntax(products)
if (args.has('--selftest')) await selftest(products)
if (existsSync(join(ROOT, 'node_modules', '@deepseek-ai'))) {
  log('检测到真实 @deepseek-ai 依赖；建议再跑 `node scripts/verify-real.mjs` 做真实框架校验')
}
log('完成')
