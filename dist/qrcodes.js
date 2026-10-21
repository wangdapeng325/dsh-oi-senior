/**
 * 关注二维码资源清单。
 *
 * 四张二维码是使用者自己的学习资源（公众号 / 视频号 / ima 知识库 / 小程序），
 * 以 jpg 形式随插件打包在 `assets/qrcodes/`，用于：
 *   - 对话回复：DSH 能直接渲染本地图片，用绝对路径 `![](path)` 即可；
 *   - 归档笔记：通过 markdown 内嵌。
 *
 * 注意：图片必须保持真实文件（< 3 MiB、PNG/JPEG/WebP），不要转码或压缩规避限制。
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = dirname(HERE)
export const QRCODE_DIR = join(PKG_ROOT, 'assets', 'qrcodes')

/**
 * @typedef {{ key: string, label: string, file: string, description: string }} QRCodeEntry
 * @type {readonly QRCodeEntry[]}
 */
export const QR_CODES = [
  {
    key: 'gongzhonghao',
    label: '欣泽编程 公众号',
    file: 'gongzhonghao.jpg',
    description: '扫码关注公众号，看信奥学习方法与题解文章',
  },
  {
    key: 'shipinhao',
    label: '欣泽编程 视频号',
    file: 'shipinhao.jpg',
    description: '扫码关注视频号，看讲题视频',
  },
  {
    key: 'zhishiku',
    label: '欣泽编程-信奥知识大全 知识库',
    file: 'zhishiku.jpg',
    description: '扫码订阅 ima 知识库，按知识点系统复习',
  },
  {
    key: 'xiaochengxu',
    label: '信奥编程算法 小程序',
    file: 'xiaochengxu.jpg',
    description: '扫码打开小程序，随手练题',
  },
]

/**
 * 合成图：四张二维码按「每张 120×120、间隔 60」拼成一张 660×120。
 *
 * 为什么笔记里用合成图而不是四张独立图：
 * - 四张原图宽高比不同，即使写死 width/height，渲染端仍按原比例缩放，
 *   结果高度参差不齐、看起来偏大；
 * - 合成成一张后，整行尺寸由图片本身决定，一行、整齐、可控；
 *   也与「信奥教练」笔记本里的做法一致；
 * - 体积更小：四张分别内嵌约 584KB，合成一张约 84KB（base64 后）。
 *
 * 用 `make-qr-composite.py` 生成；改了四张原图后要重跑。
 */
export const COMBINED_FILE = 'combined.png'
/** 合成图布局参数（与 make-qr-composite.py 保持一致）。 */
export const QR_CELL = 120
export const QR_GAP = 60
/** 合成图尺寸：4*120 + 3*60 = 660 宽，120 高。 */
export const COMBINED_WIDTH = QR_CELL * QR_CODES.length + QR_GAP * (QR_CODES.length - 1)
export const COMBINED_HEIGHT = QR_CELL

/** 合成图绝对路径。 */
export function combinedQRCodePath() {
  return join(QRCODE_DIR, COMBINED_FILE)
}

/** 合成图是否存在。 */
export function hasCombinedQRCode() {
  return existsSync(combinedQRCodePath())
}

/**
 * 对话回复末尾要附的推广 + 二维码块（Markdown）。
 *
 * 版式与归档笔记保持一致：分隔线 → 「推荐关注」标题 → 一句话渠道文案 → 二维码合成图。
 * 用的是**同一张合成图**（660×120，四张码排一行），对话和笔记看到的是同一个东西。
 *
 * @param {string} [lead] 推广导语，如「想学更多信奥知识，请关注」
 * @param {readonly string[]} [channels] 渠道名
 * @param {string} [heading] 小节标题，默认「推荐关注」
 * @returns {string} 合成图缺失时返回空串
 */
export function chatPromoMarkdown(lead, channels, heading) {
  if (!hasCombinedQRCode()) return ''
  const list = Array.isArray(channels) && channels.length > 0 ? channels : QR_CODES.map(entry => entry.label)
  const text = `${lead === undefined ? '想学更多信奥知识，请关注' : lead}${list.join('、')}。`
  const title = heading === undefined ? '推荐关注' : heading
  // 对话里由 DSH 读本地文件渲染：用正斜杠 + 尖括号包住，兼容含空格的路径
  const url = combinedQRCodePath().replace(/\\/g, '/')
  return [
    '---',
    '',
    `## ${title}`,
    '',
    text,
    '',
    `![${title}：${list.join(' / ')}](<${url}>)`,
  ].join('\n')
}

/** 单张二维码的绝对路径。 */
export function qrcodePath(entry) {
  return join(QRCODE_DIR, entry.file)
}

/** 实际存在的二维码（缺文件时自动跳过，不产生破图）。 */
export function availableQRCodes() {
  return QR_CODES.filter(entry => existsSync(qrcodePath(entry)))
}

/**
 * 生成 Markdown 形式的二维码清单（每张图配一行说明）。
 * @param {{ heading?: string | null }} [options] heading 为 null 时不加小节标题
 * @returns {string} 没有可用图片时返回空串
 */
export function renderQRCodeMarkdown(options) {
  const list = availableQRCodes()
  if (list.length === 0) return ''
  const setting = options === undefined ? {} : options
  const lines = []
  if (setting.heading !== null) lines.push('', `## ${setting.heading ?? '扫码关注'}`, '')
  for (const entry of list) {
    lines.push(`**${entry.label}**——${entry.description}`, '', `![${entry.label}](${qrcodePath(entry)})`, '')
  }
  return lines.join('\n').trim()
}

/**
 * 供工具返回给模型的二维码清单（路径 + 说明），让模型能在对话里贴图。
 */
export function qrcodeManifest() {
  return availableQRCodes().map(entry => ({
    key: entry.key,
    label: entry.label,
    description: entry.description,
    path: qrcodePath(entry),
  }))
}
