/**
 * 只读对比：把「本次归档笔记」与「信奥教练参考笔记」的首部块结构并排列出，
 * 核对是否都为「无项目符号、无缩进的普通段落」。
 *
 * 用法：node scripts/compare-header-structure.mjs <本插件note_id> <参考note_id>
 */

import { join, dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const ima = await import(pathToFileURL(join(ROOT, 'dist', 'ima.js')).href)

const mine = process.argv[2] ?? '7518241794586889'
const coach = process.argv[3] ?? '7518239575801057'

const config = { ...ima.DEFAULT_IMA_CONFIG, enabled: true }
const opts = {
  cliPath: ima.discoverImaCli(config).path,
  credentials: ima.resolveCredentials(config),
  timeoutMs: 30000,
}

/** 把块压成一行描述。 */
function describe(block) {
  const text = (block.children ?? []).map(child => child.text ?? '').join('')
  let out = String(block.type)
  if (block.listStyleType) out += `[列表符号=${block.listStyleType}]`
  else out += '[无符号]'
  if (block.indent) out += `[缩进=${block.indent}]`
  if (text !== '') out += ` "${text}"`
  return out
}

for (const [label, noteId] of [['本插件', mine], ['信奥教练参考', coach]]) {
  const res = await ima.callIma(
    'openapi/note/v1/get_doc_content',
    { note_id: noteId, target_content_format: 2 },
    opts,
  )
  console.log(`\n===== ${label}  note_id=${noteId}  code=${res.code} =====`)
  if (res.code !== 0) {
    console.log(`  读取失败：${res.msg}`)
    continue
  }
  const blocks = JSON.parse(res.data.content)
  console.log('  首部 6 块：')
  for (const block of blocks.slice(0, 6)) console.log(`    ${describe(block)}`)

  const archiver = blocks.find(b => (b.children ?? []).some(c => String(c.text ?? '').startsWith('归档人')))
  const stamp = blocks.find(b => (b.children ?? []).some(c => String(c.text ?? '').startsWith('归档时间')))
  const judge = (block) => {
    if (block === undefined) return '缺失'
    const bullet = block.listStyleType ? '有圆点' : '无圆点'
    const indent = block.indent ? `缩进${block.indent}` : '无缩进'
    return `${bullet} / ${indent}`
  }
  console.log(`  归档人  : ${judge(archiver)}`)
  console.log(`  归档时间: ${judge(stamp)}`)
}
