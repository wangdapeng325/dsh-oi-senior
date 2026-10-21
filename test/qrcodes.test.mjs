/**
 * 二维码资源测试：清单完整、文件真实存在且是合法图片、能生成 Markdown。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

async function loadModule() {
  const dist = join(ROOT, 'dist', 'qrcodes.js')
  const src = join(ROOT, 'src', 'qrcodes.ts')
  const entry = (await import('node:fs')).existsSync(dist) ? dist : src
  return import(pathToFileURL(entry).href)
}

/** 真实文件签名校验：只允许 PNG / JPEG / WebP，且与扩展名一致。 */
function detectType(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return ''
}

test('合成图：存在、是合法 PNG、尺寸正好 660×120（4×120 + 3×60）', async () => {
  const mod = await loadModule()
  assert.equal(mod.COMBINED_FILE, 'combined.png')
  assert.equal(mod.QR_CELL, 120)
  assert.equal(mod.QR_GAP, 60)
  assert.equal(mod.COMBINED_WIDTH, 660)
  assert.equal(mod.COMBINED_HEIGHT, 120)
  assert.equal(mod.hasCombinedQRCode(), true, '合成图缺失：请先跑 python scripts/make-qr-composite.py')

  const path = mod.combinedQRCodePath()
  const bytes = readFileSync(path)
  assert.equal(detectType(bytes), 'image/png', '合成图必须是合法 PNG')
  assert.ok(bytes.length < 3 * 1024 * 1024, `合成图体积超限：${bytes.length}`)

  // PNG 的 IHDR 里第 16..23 字节是大端宽高
  const width = bytes.readUInt32BE(16)
  const height = bytes.readUInt32BE(20)
  assert.equal(width, mod.COMBINED_WIDTH, `合成图实际宽度 ${width} 与常量不符`)
  assert.equal(height, mod.COMBINED_HEIGHT, `合成图实际高度 ${height} 与常量不符`)
  assert.ok(bytes.length < 200 * 1024, `合成图应尽量小（当前 ${bytes.length}），否则笔记会很大`)
})

test('二维码清单：四个渠道齐全且顺序固定', async () => {
  const mod = await loadModule()
  assert.equal(mod.QR_CODES.length, 4)
  assert.deepEqual(mod.QR_CODES.map(entry => entry.key), ['gongzhonghao', 'shipinhao', 'zhishiku', 'xiaochengxu'])
  assert.deepEqual(mod.QR_CODES.map(entry => entry.label), [
    '欣泽编程 公众号',
    '欣泽编程 视频号',
    '欣泽编程-信奥知识大全 知识库',
    '信奥编程算法 小程序',
  ])
  for (const entry of mod.QR_CODES) {
    assert.ok(entry.description.length > 0, `${entry.key} 缺少说明文案`)
  }
})

test('二维码文件：真实存在、是合法 JPEG、体积在 ima 3MiB 限制内', async () => {
  const mod = await loadModule()
  for (const entry of mod.QR_CODES) {
    const path = mod.qrcodePath(entry)
    const stat = statSync(path, { throwIfNoEntry: false })
    assert.notEqual(stat, undefined, `二维码文件缺失：${path}`)
    assert.ok(stat.isFile(), `不是文件：${path}`)
    assert.ok(stat.size > 0 && stat.size < 3 * 1024 * 1024, `体积不合法（须 <3MiB）：${path} = ${stat.size}`)
    const type = detectType(readFileSync(path))
    assert.equal(type, 'image/jpeg', `${basename(path)} 不是合法 JPEG（实际 ${type || '未知'}）`)
    assert.ok(path.endsWith('.jpg'), `${basename(path)} 扩展名应与内容一致`)
  }
})

test('availableQRCodes：全部可用（没有缺文件）', async () => {
  const mod = await loadModule()
  assert.equal(mod.availableQRCodes().length, 4)
})

test('renderQRCodeMarkdown：每张图配说明，且用绝对路径写 markdown 图片', async () => {
  const mod = await loadModule()
  const md = mod.renderQRCodeMarkdown()
  for (const entry of mod.QR_CODES) {
    assert.ok(md.includes(`**${entry.label}**`), `缺少渠道标题：${entry.label}`)
    assert.ok(md.includes(`![${entry.label}](${mod.qrcodePath(entry)})`), `缺少图片语法：${entry.label}`)
  }
  assert.ok(md.startsWith('## '), '应带一个小节标题')

  const noHeading = mod.renderQRCodeMarkdown({ heading: null })
  assert.ok(!noHeading.startsWith('## '), 'heading=null 时不应有标题')

  const custom = mod.renderQRCodeMarkdown({ heading: '关注我们' })
  assert.ok(custom.startsWith('## 关注我们'))
})

test('chatPromoMarkdown：对话末尾的推广块 = 分隔线 + 渠道文案 + 合成图', async () => {
  const mod = await loadModule()
  assert.equal(mod.hasCombinedQRCode(), true)

  const md = mod.chatPromoMarkdown()
  const lines = md.split('\n')
  assert.equal(lines[0], '---', '应以分隔线开头')
  assert.equal(lines[2], '## 推荐关注', '要有「推荐关注」标题（与笔记版式一致）')
  assert.ok(lines.some(line => line.startsWith('想学更多信奥知识，请关注')), '应有一句推广文案')
  for (const entry of mod.QR_CODES) {
    assert.ok(md.includes(entry.label), `文案缺少渠道：${entry.label}`)
  }
  // 用正斜杠 + 尖括号，兼容含空格的 Windows 路径
  assert.ok(md.includes('](<'), '图片应使用 <...> 包裹')
  assert.ok(md.includes('assets/qrcodes/combined.png'), '应指向合成图')
  assert.ok(!md.includes('\\'), '对话里的路径不应含反斜杠')
  assert.ok(md.includes('![推荐关注'), '应有图片语法')
})

test('chatPromoMarkdown：标题可通过参数改成其它名字', async () => {
  const mod = await loadModule()
  const md = mod.chatPromoMarkdown('想了解更多，请关注', ['欣泽编程 公众号'], '关注我们')
  assert.ok(md.includes('## 关注我们'))
  assert.ok(!md.includes('## 推荐关注'))
})

test('chatPromoMarkdown：可覆盖导语与渠道清单', async () => {
  const mod = await loadModule()
  const md = mod.chatPromoMarkdown('想了解更多，请关注', ['欣泽编程 公众号'])
  assert.ok(md.includes('想了解更多，请关注欣泽编程 公众号。'))
  assert.ok(!md.includes('视频号'), '自定义渠道时不应出现其它渠道')
})

test('qrcodeManifest：给模型的清单含路径与说明', async () => {
  const mod = await loadModule()
  const manifest = mod.qrcodeManifest()
  assert.equal(manifest.length, 4)
  for (const item of manifest) {
    assert.ok(item.path.startsWith(mod.QRCODE_DIR), `路径必须在 assets/qrcodes 下：${item.path}`)
    assert.ok(item.label.length > 0 && item.description.length > 0)
  }
})
