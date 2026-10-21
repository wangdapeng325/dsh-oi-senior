/**
 * 端到端验证：带二维码的归档笔记能否真实写入 ima，且图片能显示。
 *
 * 会**真的**往「信奥学长-题解复盘」写一条测试笔记（标题带「格式验证」）。
 *
 * 用法：node scripts/e2e-qrcode-note.mjs
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const ima = await import(pathToFileURL(join(ROOT, 'dist', 'ima.js')).href)
const qrcodes = await import(pathToFileURL(join(ROOT, 'dist', 'qrcodes.js')).href)

const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
  `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`

const manifest = qrcodes.qrcodeManifest()
const markdown = ima.buildNoteMarkdown({
  title: '二维码归档验证 - 题解复盘 - 可删',
  time: now,
  source: '自命题/本项目自检记录 （ 本地 DSH 插件 dsh-oi-senior ）',
  difficulty: '（不分档）插件自检记录，非竞赛题目',
  gist: '验证归档笔记里的关注二维码合成图能否正常内嵌并显示。',
  concepts: 'ima 的 upload_temp_file 不可用，因此图片以 data URL 内嵌；正文过大时改走直连 HTTP。',
  approach: '四张二维码先由 make-qr-composite.py 拼成 660×120 合成图（每张 120、间隔 60），再整张内嵌。',
  pitfalls: 'data URL 不能走命令行参数（ENAMETOOLONG）；单条笔记内嵌图片总量要设上限。',
  code: '',
  complexity: '不适用。',
  verdictEvidence: `写入时间 ${stamp}；合成图已内嵌。`,
  related: '信奥教练 oi-coach',
  combinedQr: {
    path: qrcodes.combinedQRCodePath(),
    width: qrcodes.COMBINED_WIDTH,
    height: qrcodes.COMBINED_HEIGHT,
    alt: `扫码关注：${manifest.map(item => item.label).join(' / ')}`,
  },
})

const prepared = ima.inlineLocalImages(markdown)
console.log(`内嵌图片：${prepared.inlined} 张，原始 ${prepared.bytes} 字节，正文 ${prepared.markdown.length} 字符`)
console.log(`格式校验：${JSON.stringify(ima.validateNoteMarkdown(prepared.markdown))}`)

const t0 = Date.now()
const outcome = await ima.archiveToIma(
  { content: markdown, mode: 'import', now },
  { config: { ...ima.DEFAULT_IMA_CONFIG, enabled: true } },
)
const elapsed = Date.now() - t0

console.log(JSON.stringify({
  action: outcome.action,
  noteId: outcome.noteId,
  code: outcome.code,
  silent: outcome.silent,
  message: outcome.message,
  elapsedMs: elapsed,
}, null, 2))
if (outcome.action !== 'imported') process.exit(1)
console.log('\n请打开「二维码归档验证 - 题解复盘 - 可删」检查四张二维码是否都显示')
