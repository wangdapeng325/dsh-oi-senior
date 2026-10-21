#!/usr/bin/env node
/**
 * 真实运行时加载校验（不用桩）。
 *
 * 与 scripts/build.mjs --selftest 的区别：
 * - build 自检用桩替换 @deepseek-ai/*，只证明「接线与语法」正确；
 * - 本脚本**加载真实的** @deepseek-ai/dsh-tools 与 schemastery（来自 DSH profile 的
 *   node_modules，经本包 node_modules/@deepseek-ai 的 junction 解析），
 *   因此能证明 Config（真实 schemastery 编译）与 defineTool（真实参数/输出 schema 校验）
 *   在真实框架下可用。
 *
 * 它用一个假的 ctx.tools.register 收集工具定义，不启动 DSH 运行时，也不产生副作用。
 *
 * 用法：node scripts/verify-real.mjs
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

function fail(message) {
  console.error(`[verify-real] 失败：${message}`)
  process.exit(1)
}

let mod
try {
  mod = await import(pathToFileURL(join(ROOT, 'dist', 'index.js')).href)
} catch (error) {
  fail(`加载 dist/index.js 失败：\n${error && error.stack ? error.stack : error}`)
}

console.log('[verify-real] 真实依赖加载成功')
console.log(`[verify-real] 插件版本：${mod.PLUGIN_VERSION}（来自 package.json）`)

if (mod.name !== 'dsh-oi-senior') fail(`name 不对：${String(mod.name)}`)
if (!Array.isArray(mod.inject) || !mod.inject.includes('tools')) fail('inject 未声明 tools')
if (typeof mod.apply !== 'function') fail('未导出 apply()')
if (mod.Config === undefined) fail('未导出 Config')

// 真实 schemastery 编译 Config：能编译出默认值就说明 schema DSL 用法正确
let defaults
try {
  const compiled = typeof mod.Config === 'function' ? mod.Config({}) : mod.Config
  defaults = typeof compiled === 'object' && compiled !== null ? compiled : {}
} catch (error) {
  fail(`Config 无法被真实 schemastery 解析：${error && error.message ? error.message : error}`)
}
console.log(`[verify-real] Config 解析成功，默认值：${JSON.stringify(defaults)}`)

const registered = []
const ctx = {
  tools: {
    register(definition) {
      if (definition === undefined || definition === null) fail('register 收到空定义')
      registered.push(definition)
      return () => {}
    },
  },
}

try {
  // 用 Config 的真实默认值喂给 apply（与 DSH 运行时的行为一致）
  const config = (typeof mod.Config === 'function' ? mod.Config({}) : undefined) ?? {
    judge: {},
    ima: {},
  }
  mod.apply(ctx, config)
} catch (error) {
  fail(`apply() 在真实框架下抛异常：\n${error && error.stack ? error.stack : error}`)
}

const expected = ['oi_solve', 'oi_judge', 'oi_archive', 'oi_doctor']
const names = registered.map(tool => tool.name)
console.log(`[verify-real] 注册工具：${names.join(', ')}`)
for (const want of expected) {
  if (!names.includes(want)) fail(`缺少工具 ${want}`)
}
if (names.length !== expected.length) fail(`工具数量不对：期望 ${expected.length}，实际 ${names.length}`)

for (const tool of registered) {
  if (typeof tool.description !== 'string' || tool.description.length < 20) fail(`${tool.name} description 不合格`)
  if (tool.output === undefined || typeof tool.output.render !== 'function') fail(`${tool.name} 缺少 output.render`)
  if (tool.output.schema === undefined) fail(`${tool.name} 缺少 output.schema`)
  if (typeof tool.execute !== 'function') fail(`${tool.name} 缺少 execute`)
  // 注意：defineTool 会把 parameters 转成 JSON Schema（{type:'object',properties,required}），
  // 所以这里要看 properties / required，而不是顶层键的个数。
  const props = Object.keys(tool.parameters?.properties ?? {})
  const required = tool.parameters?.required ?? []
  if (props.length === 0 && tool.name !== 'oi_doctor') fail(`${tool.name} 没有声明任何参数`)
  console.log(`[verify-real] ${tool.name} OK（参数 ${props.length} 个：${props.join(', ')}；必需：${required.join(', ') || '无'}）`)
}

// 真实 defineTool 会做参数校验：故意传一个越界枚举，应当被拒（证明真实校验已生效）
const solve = registered.find(tool => tool.name === 'oi_solve')
let rejected = false
try {
  await solve.execute({ mode: 'not-a-real-mode' }, { signal: undefined })
} catch {
  rejected = true
}
console.log(`[verify-real] 参数校验生效（非法枚举被拒）：${rejected}`)

// 真实通路：oi_solve（纯计算）
const solveValue = await solve.execute({ topic: 'P7077 函数调用', mode: 'solve' }, { signal: undefined })
if (solveValue?.persona === undefined) fail('oi_solve 返回结构不对')
if (solveValue.archive?.notebook !== '信奥学长-题解复盘') fail('归档笔记本名不对')
console.log('[verify-real] oi_solve 返回值 OK')

/**
 * lossless-JSON 校验：DSH 会在派发后对工具返回值做无损 JSON 快照，
 * 任何「键存在但值为 undefined」都会让整次调用报
 * `tool "<name>" returned invalid output: value is not lossless JSON`。
 * 只浅看返回值抓不到这类缺陷，所以这里对每个工具的真实返回值做深度扫描。
 */
function undefinedPaths(value, path = '') {
  if (value === undefined) return [path === '' ? '(root)' : path]
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap((item, index) => undefinedPaths(item, `${path}[${index}]`))
  return Object.keys(value).flatMap((key) => (
    value[key] === undefined ? [`${path}.${key}`] : undefinedPaths(value[key], `${path}.${key}`)
  ))
}

async function proveLossless(tool, args, label) {
  const value = await tool.execute(args, { signal: undefined })
  const bad = undefinedPaths(value)
  if (bad.length > 0) fail(`${label} 含 undefined 键（框架会判非 lossless JSON）：${bad.join(', ')}`)
  const text = JSON.stringify(value)
  if (text !== JSON.stringify(JSON.parse(text))) fail(`${label} JSON 往返不一致`)
  console.log(`[verify-real] ${label} lossless JSON OK`)
  return value
}

// 关键路径逐个证明：只给题号（最常见入口）、只给题面、什么都不给
await proveLossless(registered.find(t => t.name === 'oi_solve'), { topic: 'P7077' }, 'oi_solve{topic}')
await proveLossless(registered.find(t => t.name === 'oi_solve'), { problem: '题面' }, 'oi_solve{problem}')
await proveLossless(registered.find(t => t.name === 'oi_solve'), {}, 'oi_solve{}')

// 真实通路：oi_doctor（默认 ima.enabled=true，会尝试探测；本机可能没有 ima 调用器）
const doctor = registered.find(tool => tool.name === 'oi_doctor')
const doctorValue = await proveLossless(doctor, {}, 'oi_doctor{}')
console.log(`[verify-real] oi_doctor：ima connected=${doctorValue.connected} / compiler=${doctorValue.compiler?.available} (${String(doctorValue.compiler?.version ?? doctorValue.compiler?.message ?? '')})`)

console.log('[verify-real] 全部通过 ✅')
