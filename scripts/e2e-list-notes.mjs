/**
 * 只读盘点「信奥学长-题解复盘」笔记本里的笔记，用于区分：
 *   - Lead 有意写入的一条自检记录
 *   - verifier 误写入的两条脏笔记
 * 不做任何写操作。
 */

import { join } from 'node:path'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const ima = await import(pathToFileURL(join(ROOT, 'dist', 'ima.js')).href)

const config = { ...ima.DEFAULT_IMA_CONFIG, enabled: true }
const callOptions = {
  cliPath: ima.discoverImaCli(config)?.path,
  credentials: ima.resolveCredentials(config),
  timeoutMs: config.timeoutMs,
}
if (!callOptions.cliPath) {
  console.error('未找到 ima_api.cjs')
  process.exit(1)
}
console.log('调用器: ' + callOptions.cliPath)
console.log('凭证来源: ' + callOptions.credentials.source)

const listed = await ima.imaListNotebooks(callOptions)
console.log('list_notebook code=' + listed.response.code + ' msg=' + listed.response.msg)

const target = listed.notebooks.find(n => n.name === '信奥学长-题解复盘')
if (!target) {
  console.error('目标笔记本不存在')
  process.exit(1)
}
console.log(`目标笔记本: ${target.name}  folder_id=${target.id}  noteNumber=${target.noteNumber}`)

// imaListNotes 是 ima.ts 的内部实现（冻结接口未导出），这里直接走同一条
// openapi/note/v1/list_note 只读接口做盘点。
const listed2 = await ima.callIma('openapi/note/v1/list_note', {
  folder_id: target.id,
  cursor: '',
  limit: 20,
  sort_type: 0,
}, callOptions)
console.log('list_note code=' + listed2.code + ' msg=' + listed2.msg)

const raw = listed2.data
const list = (raw && (raw.note_infos ?? raw.notes ?? raw.note_list)) ?? []
console.log(`共 ${list.length} 条：`)
for (const note of list) {
  const id = note.note_id ?? note.id
  console.log(`  - note_id=${id}  title=${JSON.stringify(note.title)}`)
}
if (list.length === 0) console.log('原始返回：' + JSON.stringify(raw).slice(0, 800))
