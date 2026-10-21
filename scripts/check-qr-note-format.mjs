/**
 * 打印归档正文末尾的二维码版式（base64 缩短），核对是否与「信奥教练」一致：
 * 推广文字之后直接是合成图，**没有**小节标题、**没有**图注。
 * 用法：node scripts/check-qr-note-format.mjs
 */

import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const ima = await import(pathToFileURL(join(ROOT, 'dist', 'ima.js')).href)
const qrcodes = await import(pathToFileURL(join(ROOT, 'dist', 'qrcodes.js')).href)

const manifest = qrcodes.qrcodeManifest()
const md = ima.buildNoteMarkdown({
  title: 'P7077 [CSP-S 2020] 函数调用 - 树形DP+拓扑序',
  time: '2026-10-05 09:47:09',
  source: '洛谷 （ https://www.luogu.com.cn/problem/P7077 ）',
  difficulty: '（蓝题）提高+/省选−',
  gist: '给定函数调用关系，求最终序列。',
  concepts: '拓扑排序与逆序处理。',
  approach: '先建图，再按调用顺序处理。',
  pitfalls: '注意乘法逆元与取模。',
  code: 'int main(){return 0;}',
  complexity: '时间 O(n+m)，空间 O(n+m)。',
  verdictEvidence: '公开样例真编译评测 2 组 AC。',
  combinedQr: {
    path: qrcodes.combinedQRCodePath(),
    width: qrcodes.COMBINED_WIDTH,
    height: qrcodes.COMBINED_HEIGHT,
    alt: `扫码关注：${manifest.map(item => item.label).join(' / ')}`,
  },
})

const r = ima.inlineLocalImages(md)
const promoAt = r.markdown.indexOf(`## ${ima.PROMO_HEADING}`)
const readable = r.markdown.slice(promoAt).replace(/src="data:[^"]*"/g, 'src="data:…"')

console.log(readable)
console.log('=== 版式核对 ===')
console.log('有「扫码关注」标题   = ' + r.markdown.includes(`## ${ima.QR_HEADING}`) + '（应为 false）')
console.log('有「从左到右」图注   = ' + r.markdown.includes('从左到右：') + '（应为 false）')
console.log('图片在推广文字之后   = ' + (r.markdown.indexOf('<img ') > r.markdown.indexOf('想学更多信奥知识')))
console.log('图片是正文最后内容   = ' + r.markdown.trimEnd().endsWith('/>'))
console.log('img 标签数           = ' + (r.markdown.match(/<img /g) ?? []).length + '（应为 1）')
console.log('合成图尺寸           = ' + qrcodes.COMBINED_WIDTH + 'x' + qrcodes.COMBINED_HEIGHT)
console.log('单张格子/间隔        = ' + qrcodes.QR_CELL + ' / ' + qrcodes.QR_GAP)
console.log('内嵌原始字节         = ' + r.bytes)
console.log('正文总长度           = ' + r.markdown.length + ' 字符')
console.log('格式校验             = ' + JSON.stringify(ima.validateNoteMarkdown(r.markdown)))

writeFileSync(join(ROOT, 'review-qr-note-preview.md'), readable, 'utf8')
console.log('\n结构预览已写入 review-qr-note-preview.md')
