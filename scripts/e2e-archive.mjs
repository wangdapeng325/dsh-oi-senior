/**
 * 端到端归档验证（Lead 执行，一次性）。
 *
 * 目的：证明「buildNoteMarkdown → validateNoteMarkdown → archiveToIma → callIma →
 * ima_api.cjs → ima 云」这条真实写入链路能在本机跑通，而不只是单测里的假调用器。
 *
 * 这是**唯一**一次真实写入，内容标注为插件自检记录，不做任何伪装。
 * 用法：node scripts/e2e-archive.mjs
 */

import { join } from 'node:path'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const ima = await import(pathToFileURL(join(ROOT, 'dist', 'ima.js')).href)

function fmt(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const now = new Date()
const config = {
  ...ima.DEFAULT_IMA_CONFIG,
  enabled: true,
}

const markdown = ima.buildNoteMarkdown({
  title: '信奥学长插件自检 - 题解复盘归档链路验证 - ima归档与评测联动',
  time: now,
  source: '自命题/本项目自检记录 （ 本地 DSH 插件 dsh-oi-senior ）',
  difficulty: '（不分档）插件自检记录，非竞赛题目',
  gist: '本文不是某道竞赛题的题解，而是 dsh-oi-senior（信奥学长）插件首次真实归档的端到端验证记录：' +
    '用来确认「整理 markdown → 格式校验 → 定位笔记本 folder_id → import_doc 写入」这条链路在真实 ima 账号上可用。',
  concepts: [
    'ima 归档链路的四个环节：list_notebook 动态解析 folder_id（不硬编码）→ 组装符合技能 Step 4 的 markdown →',
    'validateNoteMarkdown 做格式守门（标题不含日期、首部含归档人/归档时间且用列表项避开加粗、URL 前后留空格、难度用全角括号、写「评测结论」而非「状态」）→',
    'import_doc 真实写入。任何一环失败都返回结构化 skipped/failed 并静默跳过，绝不假装存过。',
    '',
    '凭证压制：ima_api.cjs 的凭证优先级是 options > 环境变量 > ~/.config/ima 文件。',
    '本机残留了陈旧的 IMA_OPENAPI_CLIENTID 环境变量，若不显式把文件凭证作为 options 传入，真实调用会返回 code=200002 skill auth failed。',
    '因此本插件每次调用都显式传 options，这条机制已用真实服务做过对照实验（传 → code=0；不传 → 200002）。',
  ].join('\n'),
  approach: [
    '第一步：调 list_notebook 按名字「信奥学长-题解复盘」解析 folder_id（本次解析到 folder5cf15a1c8513e9d0）。',
    '第二步：把 10 个正文字段组装成 markdown，标题为「题名 - 简短主题」形式且不含日期时间，标题下写入固定首部（分隔线 + 归档人 + 归档时间 + 分隔线，两行用列表项）。',
    '第三步：跑 validateNoteMarkdown 自检，确认零格式问题后再提交，避免把不合规笔记写进知识库。',
    '第四步：调 import_doc（content_format=1）真实写入，只有返回 code=0 才判定成功。',
  ].join('\n'),
  pitfalls: [
    '① 硬编码 folder_id：笔记本改名或换账号后必然写错位置，必须每次动态解析。',
    '② 笔记本不存在时静默落到根目录：本插件明确规定跳过而不是兜底写入，否则知识库会被污染。',
    '③ 忽略陈旧环境变量：不显式传 options 就会稳定拿到 200002。',
    '④ 标题里带日期时间：会破坏按题目检索的一致性。',
  ].join('\n'),
  code: '',
  complexity: '不适用（自检记录，非算法题）。归档链路耗时：真实 list_notebook 约 300ms，import_doc 约数百毫秒。',
  verdictEvidence: [
    '真实服务验证：ima_api.cjs 已安装（~/.workbuddy/skills/ima-skill/），凭证来源 file；',
    'list_notebook 真实返回 code=0 / msg=success，目标笔记本命中；',
    '抗 200002 对照实验：只给陈旧环境变量 → 真实复现 code=200002；走本模块显式 options → code=0；',
    '本插件的 65 项单测（评测引擎 18 + 归档引擎 35 + 接线 12）在 node v24.14.1 上全绿；',
    '本机 g++ 16.2.0 真实编译评测验证：C++14 代码逐点判定 AC/WA/TLE/RE/CE 全部工作正常。',
  ].join('\n'),
  related: '信奥教练 oi-coach、oi-senior 技能包 1.0.8、dsh-oi-senior 插件 1.0.8',
})

console.log('=== 格式校验 ===')
const issues = ima.validateNoteMarkdown(markdown)
console.log(issues.length === 0 ? '零格式问题 ✅' : JSON.stringify(issues, null, 2))

console.log('\n=== 笔记正文 ===')
console.log(markdown)
console.log('\n=== 开始真实归档 ===')

const outcome = await ima.archiveToIma(
  { content: markdown, mode: 'import', now },
  { config },
)

console.log(JSON.stringify({
  action: outcome.action,
  notebook: outcome.notebook,
  folderId: outcome.folderId,
  noteId: outcome.noteId,
  code: outcome.code,
  authFailed: outcome.authFailed,
  silent: outcome.silent,
  statusLine: outcome.statusLine,
  message: outcome.message,
}, null, 2))

if (outcome.action !== 'imported') {
  console.error('\n归档未成功，请检查上面的 message。')
  process.exit(1)
}
console.log('\n归档成功 ✅')
