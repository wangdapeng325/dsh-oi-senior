/**
 * 内嵌图片与传输选择的测试。
 *
 * 背景：ima 的 `upload_temp_file` 在当前凭证下返回 `100001 session ID is required`，
 * 拿不到 download_url；而 ima 的 markdown 渲染支持 data URL 图片（已实测）。
 * 因此归档前要把本地图片改写成 data URL，并且因为命令行有长度上限，
 * 大请求体必须改走直连 HTTP。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

async function loadIma() {
  const dist = join(ROOT, 'dist', 'ima.js')
  const src = join(ROOT, 'src', 'ima.ts')
  return import(pathToFileURL(existsSync(dist) ? dist : src).href)
}

/** 1x1 像素的合法 PNG（最小可用图片）。 */
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

function withTempDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'oi-senior-inline-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('inlineLocalImages：本地 PNG 被改写成 data URL', async () => {
  const ima = await loadIma()
  withTempDir((dir) => {
    const file = join(dir, 'qr.png')
    writeFileSync(file, TINY_PNG)
    const md = `![二维码](${file})`
    const result = ima.inlineLocalImages(md)
    assert.equal(result.inlined, 1)
    assert.deepEqual(result.skipped, [])
    assert.ok(result.markdown.startsWith('![二维码](data:image/png;base64,'), result.markdown.slice(0, 60))
    assert.ok(!result.markdown.includes(dir), '不应残留本地路径')
    assert.equal(result.bytes, TINY_PNG.length)
  })
})

test('inlineLocalImages：回退路径的四张二维码也全部内嵌，且总量在 4MiB 上限内', async () => {
  const ima = await loadIma()
  const qrcodes = await import(pathToFileURL(join(ROOT, 'dist', 'qrcodes.js')).href)
  const md = ima.buildNoteMarkdown({
    title: 'P7077 [CSP-S 2020] 函数调用 - 树形DP+拓扑序',
    time: '2026-10-05 09:47:09',
    source: '洛谷 （ https://www.luogu.com.cn/problem/P7077 ）',
    difficulty: '（蓝题）提高+/省选−',
    gist: 'g', concepts: 'c', approach: 'a', pitfalls: 'p',
    code: 'int main(){}', complexity: 'O(1)', verdictEvidence: '样例 AC',
    // 故意不传 combinedQr，走四张独立图的回退路径
    qrcodes: qrcodes.qrcodeManifest(),
  })
  const result = ima.inlineLocalImages(md)
  assert.equal(result.inlined, 4, '四张二维码都要内嵌')
  assert.deepEqual(result.skipped, [])
  assert.ok(result.bytes > 0 && result.bytes <= ima.MAX_INLINE_IMAGE_BYTES, `总量超限：${result.bytes}`)
  assert.ok(!/assets[\\/]qrcodes/.test(result.markdown), '不应残留 assets 路径')
  // 回退路径用的是 markdown 图片语法
  assert.equal((result.markdown.match(/!\[[^\]]*\]\(data:image\/jpeg;base64,/g) ?? []).length, 4)
})

test('inlineLocalImages：已内嵌的 data URL 与 http(s) 图片原样保留', async () => {
  const ima = await loadIma()
  const md = `![a](data:image/png;base64,AAAA)\n![b](https://example.com/x.png)`
  const result = ima.inlineLocalImages(md)
  assert.equal(result.inlined, 0)
  assert.equal(result.markdown, md)
})

test('inlineLocalImages：文件不存在 / 不是图片 → 跳过并保留原引用，绝不抛异常', async () => {
  const ima = await loadIma()
  withTempDir((dir) => {
    const notImage = join(dir, 'note.txt')
    writeFileSync(notImage, 'hello')
    const md = `![x](${join(dir, 'missing.png')})\n![y](${notImage})`
    const result = ima.inlineLocalImages(md)
    assert.equal(result.inlined, 0)
    assert.equal(result.skipped.length, 2)
    assert.equal(result.markdown, md, '跳过时应原样保留引用')
  })
})

test('inlineLocalImages：HTML <img src> 也会被改写成 data URL，且保留 width/height', async () => {
  const ima = await loadIma()
  withTempDir((dir) => {
    const file = join(dir, 'qr.png')
    writeFileSync(file, TINY_PNG)
    const md = `<img src="${file}" alt="二维码" width="100" height="100" />`
    const result = ima.inlineLocalImages(md)
    assert.equal(result.inlined, 1)
    assert.ok(result.markdown.includes('src="data:image/png;base64,'), result.markdown.slice(0, 80))
    assert.ok(result.markdown.includes('width="100"') && result.markdown.includes('height="100"'), '尺寸属性必须保留')
    assert.ok(!result.markdown.includes(dir), '不应残留本地路径')
  })
})

test('inlineLocalImages：单引号 src 与已内嵌的 img 都能正确处理', async () => {
  const ima = await loadIma()
  withTempDir((dir) => {
    const file = join(dir, 'qr.png')
    writeFileSync(file, TINY_PNG)
    const single = ima.inlineLocalImages(`<img src='${file}' />`)
    assert.equal(single.inlined, 1)
    assert.ok(single.markdown.includes('src="data:image/png;base64,'))
  })
  const already = '<img src="data:image/png;base64,AAAA" width="100" />'
  const result = ima.inlineLocalImages(already)
  assert.equal(result.inlined, 0)
  assert.equal(result.markdown, already, '已内嵌的 img 必须原样保留')
})

test('shouldUseDirectHttp：小请求走命令行，大请求走直连', async () => {
  const ima = await loadIma()
  assert.equal(ima.shouldUseDirectHttp({ content: 'x'.repeat(100) }), false)
  assert.equal(ima.shouldUseDirectHttp({ content: 'x'.repeat(64 * 1024) }), true)
  // 带内嵌图片的真实正文必然走直连（否则 spawn ENAMETOOLONG）
  const qrcodes = await import(pathToFileURL(join(ROOT, 'dist', 'qrcodes.js')).href)
  const withImages = ima.inlineLocalImages(qrcodes.renderQRCodeMarkdown()).markdown
  assert.equal(ima.shouldUseDirectHttp({ content_format: 1, content: withImages }), true)
})

test('buildNoteMarkdown：combinedQr 生成单张合成图，直接跟在推广文字后（无标题、无图注）', async () => {
  const ima = await loadIma()
  const base = {
    title: 'P7077 [CSP-S 2020] 函数调用 - 树形DP+拓扑序',
    time: '2026-10-05 09:47:09',
    source: '洛谷 （ https://www.luogu.com.cn/problem/P7077 ）',
    difficulty: '（蓝题）提高+/省选−',
    gist: 'g', concepts: 'c', approach: 'a', pitfalls: 'p',
    code: 'int main(){}', complexity: 'O(1)', verdictEvidence: '样例 AC',
  }
  const withQr = ima.buildNoteMarkdown({
    ...base,
    combinedQr: { path: 'C:/x/combined.png', width: 660, height: 120, alt: '扫码关注' },
  })
  const tags = withQr.match(/<img [^>]*>/g) ?? []
  assert.equal(tags.length, 1, '应当只有一张合成图')
  assert.ok(tags[0].includes('src="C:/x/combined.png"'))
  assert.ok(tags[0].includes('width="660"') && tags[0].includes('height="120"'), '合成图按 660×120 显示')

  // 不再有小节标题与「从左到右」图注
  assert.ok(!withQr.includes(`## ${ima.QR_HEADING}`), '不应再有「扫码关注」小节标题')
  assert.ok(!withQr.includes('从左到右：'), '不应再有「从左到右」图注')

  // 图片紧跟在推广文字之后，且仍是全文最后一个内容块
  const promoAt = withQr.indexOf(`## ${ima.PROMO_HEADING}`)
  const imgAt = withQr.indexOf('<img ')
  assert.ok(promoAt >= 0 && imgAt > promoAt, '图片必须在推广小节之后')
  assert.ok(withQr.indexOf('<img ') > withQr.indexOf('想学更多信奥知识'), '图片在推广文字之后')
  assert.equal(withQr.slice(imgAt).trim().endsWith('/>'), true, '图片应是正文最后内容')

  const withoutQr = ima.buildNoteMarkdown(base)
  assert.ok(!withoutQr.includes('<img '), '不传 combinedQr / qrcodes 时不应有二维码')
})

test('buildNoteMarkdown：没有合成图时回退为四张独立图（同样不加标题）', async () => {
  const ima = await loadIma()
  const md = ima.buildNoteMarkdown({
    title: 'P7077 [CSP-S 2020] 函数调用 - 树形DP+拓扑序',
    time: '2026-10-05 09:47:09',
    source: '洛谷 （ https://www.luogu.com.cn/problem/P7077 ）',
    difficulty: '（蓝题）提高+/省选−',
    gist: 'g', concepts: 'c', approach: 'a', pitfalls: 'p',
    code: 'int main(){}', complexity: 'O(1)', verdictEvidence: '样例 AC',
    qrcodes: [{ label: '欣泽编程 公众号', description: '扫码关注', path: 'C:/x/qr.jpg' }],
  })
  assert.ok(md.includes('![欣泽编程 公众号](C:/x/qr.jpg)'), '回退路径用 markdown 图片')
  assert.ok(!md.includes(`## ${ima.QR_HEADING}`), '回退路径同样不加小节标题')
})

test('合成图：内嵌后体积远小于四张独立图', async () => {
  const ima = await loadIma()
  const qrcodes = await import(pathToFileURL(join(ROOT, 'dist', 'qrcodes.js')).href)
  assert.equal(qrcodes.hasCombinedQRCode(), true, '缺少合成图：先跑 python scripts/make-qr-composite.py')

  const base = {
    title: 'P7077 [CSP-S 2020] 函数调用 - 树形DP+拓扑序',
    time: '2026-10-05 09:47:09',
    source: 's', difficulty: 'd', gist: 'g', concepts: 'c', approach: 'a', pitfalls: 'p',
    code: 'int main(){}', complexity: 'O(1)', verdictEvidence: 'v',
  }
  const combined = ima.inlineLocalImages(ima.buildNoteMarkdown({
    ...base,
    combinedQr: { path: qrcodes.combinedQRCodePath(), width: qrcodes.COMBINED_WIDTH, height: qrcodes.COMBINED_HEIGHT },
  }))
  const separate = ima.inlineLocalImages(ima.buildNoteMarkdown({ ...base, qrcodes: qrcodes.qrcodeManifest() }))

  assert.equal(combined.inlined, 1)
  assert.equal(separate.inlined, 4)
  assert.ok(
    combined.markdown.length < separate.markdown.length / 3,
    `合成图应显著更小：合成 ${combined.markdown.length} vs 四张 ${separate.markdown.length}`,
  )
  assert.ok(combined.markdown.length < 150 * 1024, `合成图笔记不应过大：${combined.markdown.length}`)
})
