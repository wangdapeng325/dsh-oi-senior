/**
 * 常驻提示段的健壮性校验。
 *
 * 说明（为什么不做"真服务端到端"）：
 * 真实的 `ctx.systemPrompt.section()` 用法与官方 dsh-tool-bash 完全一致
 * （靠 `inject: ['tools', 'systemPrompt']` 拿到服务，然后 section(...)），
 * 属于既有事实，不需要在此重复证明。真正需要我保证的是：
 * **常驻提示是增强，缺了 / 报错了都不能影响工具注册。**
 *
 * 本脚本用三种 ctx 形态验证这一点：
 *   1. 有可用的 systemPrompt  -> 必须注册 section，4 个工具照常注册
 *   2. 访问 systemPrompt 抛错 -> 必须吞掉异常，4 个工具照常注册
 *   3. 完全没有 systemPrompt  -> 必须静默跳过，4 个工具照常注册
 *
 * 用法：node scripts/verify-prompt-section.mjs
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

function fail(message) {
  console.error(`[verify-prompt] 失败：${message}`)
  process.exit(1)
}

const plugin = await import(pathToFileURL(join(ROOT, 'dist', 'index.js')).href)

const CONFIG = {
  judge: { compiler: 'g++', std: '-std=c++14', optimization: '-O2', timeLimitMs: 2000, compileTimeoutMs: 30000, workDir: '' },
  ima: { enabled: false, cliPath: '', clientId: '', apiKey: '', timeoutMs: 20000 },
}

const EXPECTED_TOOLS = ['oi_solve', 'oi_judge', 'oi_archive', 'oi_doctor']

/** 造一个 ctx：systemPrompt 按需提供，tools 始终记录注册。 */
function makeCtx(systemPromptFactory) {
  const tools = []
  const sections = []
  const ctx = {
    tools: { register: (definition) => { tools.push(definition); return () => {} } },
    get systemPrompt() {
      if (systemPromptFactory === 'throw') throw new Error('service unavailable')
      if (typeof systemPromptFactory === 'function') {
        return { section: (definition) => { sections.push(definition); return () => {} } }
      }
      return undefined
    },
  }
  return { ctx, tools, sections }
}

// 1) 正常路径
{
  const { ctx, tools, sections } = makeCtx(() => true)
  plugin.apply(ctx, CONFIG)
  const names = tools.map(tool => tool.name)
  for (const want of EXPECTED_TOOLS) if (!names.includes(want)) fail(`情况1 缺少工具 ${want}`)
  if (sections.length !== 1) fail(`情况1 期望注册 1 个 section，实际 ${sections.length}`)
  const section = sections[0]
  if (section.name !== 'plugin:dsh-oi-senior') fail(`情况1 section 名不对：${section.name}`)
  if (!section.text.includes('mp.weixin.qq.com/s/')) fail('情况1 常驻段缺少公众号文章链接')
  if (!section.text.includes('不会使用')) fail('情况1 常驻段缺少触发条件')
  console.log(`[verify-prompt] 情况1（有 systemPrompt）：section 已注册，工具 ${names.length} 个 ✅`)
  console.log('[verify-prompt] 常驻段内容：')
  for (const line of section.text.split('\n')) console.log('  ' + line)
}

// 2) 访问抛错
{
  const { ctx, tools } = makeCtx('throw')
  plugin.apply(ctx, CONFIG)
  const names = tools.map(tool => tool.name)
  for (const want of EXPECTED_TOOLS) if (!names.includes(want)) fail(`情况2 缺少工具 ${want}`)
  console.log(`[verify-prompt] 情况2（systemPrompt 抛错）：异常已吞，工具 ${names.length} 个 ✅`)
}

// 3) 服务缺失
{
  const { ctx, tools } = makeCtx(undefined)
  plugin.apply(ctx, CONFIG)
  const names = tools.map(tool => tool.name)
  for (const want of EXPECTED_TOOLS) if (!names.includes(want)) fail(`情况3 缺少工具 ${want}`)
  console.log(`[verify-prompt] 情况3（无 systemPrompt）：静默跳过，工具 ${names.length} 个 ✅`)
}

console.log('[verify-prompt] 通过 ✅')
