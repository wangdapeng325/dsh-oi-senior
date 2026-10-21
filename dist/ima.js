/**
 * dsh-oi-senior —— ima 归档模块。
 *
 * 把 oi-senior 技能「五、归档到 ima 知识库」的规程落成纯 Node 内置模块：
 *   node <ima_api.cjs> "<endpoint>" '<json body>' '<json options>'
 * 调用器成功时 stdout 输出 `{code:0,msg,data}`；失败时 stderr 输出 `{code,msg}` 且退出码非 0
 * （-100 程序性错误，-200 技能需更新）。
 *
 * 硬性纪律（与技能 5.1~5.4 一致）：
 * - 只写不读：仅用 list_notebook / list_note / import_doc / append_doc，不实现任何检索路径。
 * - 目标笔记本固定「信奥学长-题解复盘」，folder_id 每次用 list_notebook 按名字动态解析，绝不硬编码；
 *   笔记本不存在 → 本轮跳过并如实说明，绝不静默落到根目录。
 * - 凭证优先级：显式 options（来自 ~/.config/ima 文件）> 环境变量 > 文件；每次调用都把凭证作为
 *   options JSON 显式传给 ima_api.cjs，压过可能残留的 IMA_OPENAPI_CLIENTID/APIKEY（否则 200002）。
 * - 降级：未启用 / 找不到调用器 / 无凭证 / 笔记本缺失 → 返回结构化 skipped，不抛异常；
 *   鉴权失败 authFailed=true 并给出重新生成 Client ID / API Key 的指引。
 * - 不假装：只有 import_doc / append_doc 真的返回 code=0 才判成功；失败一律静默（silent=true，statusLine=''）。
 *
 * 文件内容为 ESM JavaScript（扩展名沿用 .ts 仅为与构建脚本「拷贝 .ts → dist/*.js」对齐），
 * 不含类型注解；下面用 JSDoc 记录冻结接口的字段与签名，一字不改。
 *
 * @typedef {object} ImaConfig
 * @property {boolean} enabled 总开关
 * @property {string} cliPath ima_api.cjs 路径；空 = 自动定位
 * @property {string} clientId Client ID；空 = 用环境变量/凭证文件
 * @property {string} apiKey API Key；空 = 用环境变量/凭证文件
 * @property {number} timeoutMs 单次调用超时（毫秒）
 *
 * @typedef {object} NotebookInfo
 * @property {string} id
 * @property {string} name
 * @property {number} noteNumber
 *
 * @typedef {object} CredentialInfo
 * @property {string} clientId
 * @property {string} apiKey
 * @property {'config'|'env'|'file'|'none'} source
 *
 * @typedef {object} CliDiscovery
 * @property {string} path
 * @property {'config'|'env'|'known'|'search'} source
 *
 * @typedef {object} ImaCallOptions
 * @property {string} cliPath
 * @property {CredentialInfo} credentials
 * @property {number} [timeoutMs]
 * @property {AbortSignal} [signal]
 *
 * @typedef {object} ImaResponse
 * @property {boolean} ok
 * @property {number} code
 * @property {string} msg
 * @property {unknown} data
 * @property {'ok'|'auth'|'update'|'programmatic'|'error'} kind
 * @property {string} raw
 *
 * @typedef {object} NoteInput
 * @property {string} title 标题，不含日期时间
 * @property {string|Date} [time] ISO/Date；缺省取当前时间
 * @property {string} source
 * @property {string} difficulty
 * @property {string} gist
 * @property {string} concepts
 * @property {string} approach
 * @property {string} pitfalls
 * @property {string} code
 * @property {string} complexity
 * @property {string} verdictEvidence 评测结论：对拍/真实评测证据
 * @property {string} [related]
 *
 * @typedef {object} NoteIssue
 * @property {string} field
 * @property {string} problem
 *
 * @typedef {object} ArchiveRequest
 * @property {string} content
 * @property {string} [notebook] 缺省 信奥学长-题解复盘
 * @property {'auto'|'import'|'append'} [mode] auto: 同名则 append 否则 import；import: 总是新建；append: 只追加
 * @property {Date} [now]
 *
 * @typedef {object} ArchiveOutcome
 * @property {'imported'|'appended'|'skipped'|'failed'} action
 * @property {string} notebook
 * @property {string} message
 * @property {string} [folderId]
 * @property {string} [noteId]
 * @property {number} [code]
 * @property {boolean} authFailed
 * @property {string} statusLine 成功 '[归档：成功 note_id=...]'；失败/跳过为空
 * @property {boolean} silent 失败/无凭证/笔记本不存在时 true
 *
 * @typedef {object} DoctorReport
 * @property {boolean} enabled
 * @property {string} [cliPath]
 * @property {string} [cliSource]
 * @property {'config'|'env'|'file'|'none'} credentials
 * @property {boolean} connected
 * @property {string} notebook
 * @property {string} [folderId]
 * @property {string[]} availableNotebooks
 * @property {number} [code]
 * @property {string} message
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// 配置与常量
// ---------------------------------------------------------------------------

/** @type {ImaConfig} */
export const DEFAULT_IMA_CONFIG = {
  enabled: true,
  cliPath: '',
  clientId: '',
  apiKey: '',
  timeoutMs: 20000,
}

/** 唯一的目标笔记本名。 */
export const DEFAULT_NOTEBOOK = '信奥学长-题解复盘'

/** 视为「鉴权失败」的错误码（含 ima 各版本不同写法）。 */
const AUTH_CODES = new Set([200002, 20004, 20002])
/** 调用器自身的错误码：需要更新 skill。 */
const UPDATE_CODE = -200
/** 调用器自身的错误码：程序性错误（参数/凭证/网络）。 */
const PROGRAMMATIC_CODE = -100

/** 归档链路只允许这 4 个接口（本技能只写不读）。 */
const EP_LIST_NOTEBOOK = 'openapi/note/v1/list_notebook'
const EP_LIST_NOTE = 'openapi/note/v1/list_note'
const EP_IMPORT_DOC = 'openapi/note/v1/import_doc'
const EP_APPEND_DOC = 'openapi/note/v1/append_doc'

/** list_notebook 的 limit 上限为 20，超出会被服务端拒绝，因此按 cursor 翻页。 */
const NOTEBOOK_PAGE_LIMIT = 20
const MAX_NOTEBOOK_PAGES = 10
/** list_note 的 limit 同样受 0 < limit <= 20 约束：传 50 会被服务端以 code=51 拒绝，
 *  导致 auto/append 永远查不到同名笔记（表现为反复新建重复笔记）。 */
const NOTE_PAGE_LIMIT = 20
const MAX_NOTE_PAGES = 10

/** 标题里禁用的全角破折号：— (U+2014)、– (U+2013)、－ (U+FF0D)。
 *  注意 U+2212（−，数学减号）是难度档位「提高+/省选−」的正当字符，不在禁用列表内。 */
const FULLWIDTH_DASH_RE = /[\u2014\u2013\uff0d]/
const FULLWIDTH_HYPHEN = '\uff0d'

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function str(value) {
  return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value)
}

function asRecord(value) {
  return typeof value === 'object' && value !== null ? value : undefined
}

/** 数字或数字字符串（ima 的部分字段是字符串）。 */
function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : 0
  }
  return 0
}

function firstArray(data, keys) {
  const record = asRecord(data)
  if (record === undefined) return []
  for (const key of keys) {
    const value = record[key]
    if (Array.isArray(value)) return value
  }
  return []
}

function readTextFile(path) {
  try {
    return readFileSync(path, 'utf8').trim()
  } catch {
    return ''
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// 调用器定位
// ---------------------------------------------------------------------------

/** 常见技能目录（按顺序探测）。 */
function knownSkillRoots(home) {
  return [
    join(home, '.workbuddy', 'skills'),
    join(home, '.dsh', 'skills'),
    join(home, '.claude', 'skills'),
    join(home, '.codex', 'skills'),
    join(home, '.cursor', 'skills'),
    join(home, '.workbuddy', 'plugins'),
  ]
}

/** 在若干技能根目录下按有限深度搜索 ima_api.cjs（跳过隐藏目录与 node_modules）。 */
function searchImaCli(roots, maxDepth = 3) {
  const found = []
  const walk = (dir, depth) => {
    if (depth > maxDepth || found.length > 0) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const dirs = []
    for (const entry of entries) {
      if (entry.isFile() && entry.name === 'ima_api.cjs') {
        found.push(join(dir, entry.name))
        return
      }
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
      dirs.push(entry.name)
    }
    dirs.sort()
    for (const name of dirs) {
      walk(join(dir, name), depth + 1)
      if (found.length > 0) return
    }
  }
  for (const root of roots) {
    if (!existsSync(root)) continue
    walk(root, 0)
    if (found.length > 0) break
  }
  return found
}

/**
 * 按 配置 → 环境变量 IMA_API_CJS → 已知技能目录 → 有限深度搜索 的顺序定位 ima_api.cjs。
 * @returns {CliDiscovery|undefined}
 */
export function discoverImaCli(config, options = {}) {
  const home = options.homeDir ?? homedir()
  const env = options.env ?? process.env
  const candidates = []
  const configured = str(config && config.cliPath).trim()
  if (configured !== '') candidates.push({ path: configured, source: 'config' })
  const fromEnv = str(env.IMA_API_CJS).trim()
  if (fromEnv !== '') candidates.push({ path: fromEnv, source: 'env' })
  for (const root of knownSkillRoots(home)) {
    candidates.push({ path: join(root, 'ima-skill', 'ima_api.cjs'), source: 'known' })
  }
  for (const candidate of candidates) {
    if (existsSync(candidate.path)) return candidate
  }
  const searched = searchImaCli(knownSkillRoots(home))
  if (searched.length > 0) return { path: searched[0], source: 'search' }
  return undefined
}

// ---------------------------------------------------------------------------
// 凭证
// ---------------------------------------------------------------------------

/**
 * 按 显式配置 → 环境变量 → ~/.config/ima/{client_id,api_key} 文件的顺序解析凭证。
 * 只有两项都拿到才算一对凭证，避免半配置挡住下层正确来源。
 * @returns {CredentialInfo}
 */
export function resolveCredentials(config, options = {}) {
  const home = options.homeDir ?? homedir()
  const env = options.env ?? process.env
  const configId = str(config && config.clientId).trim()
  const configKey = str(config && config.apiKey).trim()
  if (configId !== '' && configKey !== '') {
    return { clientId: configId, apiKey: configKey, source: 'config' }
  }
  // ima_api.cjs 自身的环境变量顺序是 IMA_CLIENT_ID/IMA_API_KEY 优先于 IMA_OPENAPI_*，
  // 这里保持一致，免得调用方以为设了 IMA_OPENAPI_* 却没生效。
  const envId = str(env.IMA_CLIENT_ID).trim() || str(env.IMA_OPENAPI_CLIENTID).trim()
  const envKey = str(env.IMA_API_KEY).trim() || str(env.IMA_OPENAPI_APIKEY).trim()
  if (envId !== '' && envKey !== '') {
    return { clientId: envId, apiKey: envKey, source: 'env' }
  }
  const fileId = readTextFile(join(home, '.config', 'ima', 'client_id'))
  const fileKey = readTextFile(join(home, '.config', 'ima', 'api_key'))
  if (fileId !== '' && fileKey !== '') {
    return { clientId: fileId, apiKey: fileKey, source: 'file' }
  }
  return { clientId: '', apiKey: '', source: 'none' }
}

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

/** 执行 ima_api.cjs，不抛异常，失败以结果形式返回。 */
function runImaCli(cliPath, endpoint, body, options) {
  return new Promise((resolve) => {
    const credentials = options.credentials
    const usable = credentials !== undefined && credentials !== null && credentials.source !== 'none'
    const args = [cliPath, endpoint, JSON.stringify(body)]
    // 关键：把权威凭证作为 options JSON 显式传入。ima_api.cjs 的 loadCredentials 优先级是
    // options > 环境变量 > 文件，因此这一层彻底压过残留的 IMA_OPENAPI_CLIENTID/APIKEY（否则 200002）。
    if (usable) {
      args.push(JSON.stringify({ clientId: credentials.clientId, apiKey: credentials.apiKey }))
    }

    let child
    let settled = false
    let timedOut = false
    let stdout = ''
    let stderr = ''
    let timer

    const killChild = () => {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        child.kill(process.platform === 'win32' ? undefined : 'SIGKILL')
      }
    }
    const settle = (result) => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = () => {
      killChild()
      settle({ code: null, stdout, stderr, timedOut: false, aborted: true, error: 'aborted' })
    }

    if (options.signal !== undefined && options.signal.aborted === true) {
      resolve({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true, error: 'aborted' })
      return
    }

    try {
      child = spawn(process.execPath, args, {
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      settle({ code: null, stdout: '', stderr: '', timedOut: false, aborted: false, error: error instanceof Error ? error.message : String(error) })
      return
    }

    if (options.signal !== undefined) options.signal.addEventListener('abort', onAbort, { once: true })

    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_IMA_CONFIG.timeoutMs
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        killChild()
      }, timeoutMs)
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', (chunk) => { stdout += chunk })
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      settle({ code: null, stdout, stderr, timedOut, aborted: false, error: error.message })
    })
    child.on('close', (code) => {
      settle({ code, stdout, stderr, timedOut, aborted: false })
    })
  })
}

function parseJsonObject(text) {
  if (text === '') return undefined
  try {
    const value = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** 取响应里的 code，容忍数字字符串。 */
function codeOf(record) {
  if (record === undefined) return undefined
  const value = record.code
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim())
  return undefined
}

function normalize(code, msg, data, raw) {
  if (code === 0) return { ok: true, code, msg, data, kind: 'ok', raw }
  const kind = AUTH_CODES.has(code)
    ? 'auth'
    : code === UPDATE_CODE
      ? 'update'
      : code < 0
        ? 'programmatic'
        : 'error'
  return { ok: false, code, msg, data, kind, raw }
}

/**
 * 调用一个 ima 接口并归一化结果。
 * @returns {Promise<ImaResponse>}
 */
export async function callIma(endpoint, body, options) {
  const run = await runImaCli(options.cliPath, endpoint, body, options)
  if (run.aborted === true) {
    throw new DOMException('oi-senior ima call aborted', 'AbortError')
  }
  if (run.error !== undefined) {
    return {
      ok: false,
      code: PROGRAMMATIC_CODE,
      msg: `无法启动 ima 调用器：${run.error}`,
      data: undefined,
      kind: 'programmatic',
      raw: run.error,
    }
  }
  if (run.timedOut === true) {
    const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_IMA_CONFIG.timeoutMs
    return {
      ok: false,
      code: PROGRAMMATIC_CODE,
      msg: `ima 调用超时（${timeoutMs}ms）`,
      data: undefined,
      kind: 'programmatic',
      raw: '',
    }
  }
  const stdoutText = run.stdout.trim()
  const stderrText = run.stderr.trim()
  const raw = [stdoutText, stderrText].filter(text => text !== '').join('\n')
  const fromStdout = parseJsonObject(stdoutText)
  const fromStderr = parseJsonObject(stderrText)
  // 调用器成功写 stdout；失败写 stderr 且退出码非 0；-200 时 stdout 里是更新上下文（无 code），
  // 真正的 code 在 stderr，因此挑第一个带 code 的对象。
  const chosen = [fromStdout, fromStderr].find(record => codeOf(record) !== undefined)
  const code = codeOf(chosen)
  if (chosen !== undefined && code !== undefined) {
    return normalize(code, str(chosen.msg), chosen.data, raw)
  }
  const fallback = raw === '' ? `ima 调用器无输出（退出码 ${run.code === null ? 'null' : run.code}）` : `ima 返回无法解析：${raw.slice(0, 300)}`
  return { ok: false, code: PROGRAMMATIC_CODE, msg: fallback, data: undefined, kind: 'programmatic', raw }
}

/** 鉴权失败的统一提示（供工具层直接展示）。 */
export function authAdvice(response) {
  return `ima 鉴权失败（code=${response.code}）：请到 https://ima.qq.com/agent-interface 重新生成 Client ID / API Key，` +
    '并写入 ~/.config/ima/{client_id,api_key}（或环境变量 IMA_CLIENT_ID / IMA_API_KEY）后重试。'
}

// ---------------------------------------------------------------------------
// 直连 HTTP 传输（大请求体用）
// ---------------------------------------------------------------------------

/**
 * 把请求体塞进命令行参数会触发 `spawn ENAMETOOLONG`（Windows 命令行长度上限），
 * 用于内嵌图片（data URL）的笔记正文必然超过这个限制。
 * 因此当请求体过大时改走直连 HTTP，协议与 `ima_api.cjs` 的 postJson 等价。
 */
const CLI_BODY_LIMIT_BYTES = 16 * 1024
const DIRECT_BASE_URL = 'https://ima.qq.com'
/** 单条笔记允许内嵌的图片总量上限（base64 前），避免把知识库撑爆。 */
export const MAX_INLINE_IMAGE_BYTES = 4 * 1024 * 1024

/** 请求体是否大到不能走命令行。 */
export function shouldUseDirectHttp(body) {
  try {
    return Buffer.byteLength(JSON.stringify(body), 'utf8') > CLI_BODY_LIMIT_BYTES
  } catch {
    return true
  }
}

async function runDirectHttp(endpoint, body, options) {
  const controller = new AbortController()
  const timeoutMs = typeof options.timeoutMs === 'number' ? options.timeoutMs : DEFAULT_IMA_CONFIG.timeoutMs
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  if (options.signal !== undefined) {
    if (options.signal.aborted === true) {
      clearTimeout(timer)
      throw new DOMException('oi-senior ima call aborted', 'AbortError')
    }
    options.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  try {
    const response = await fetch(`${DIRECT_BASE_URL}/${endpoint}`, {
      method: 'POST',
      headers: {
        'ima-openapi-clientid': options.credentials.clientId,
        'ima-openapi-apikey': options.credentials.apiKey,
        'ima-openapi-ctx': 'skill_version=dsh-oi-senior',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    })
    const text = await response.text()
    return { text }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 统一入口：小请求走 ima_api.cjs，大请求（内嵌图片）走直连 HTTP。
 * 两者返回同样的归一化结构。
 */
export async function callImaAuto(endpoint, body, options) {
  if (!shouldUseDirectHttp(body)) return callIma(endpoint, body, options)
  let text
  try {
    text = (await runDirectHttp(endpoint, body, options)).text
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error
    return {
      ok: false,
      code: PROGRAMMATIC_CODE,
      msg: `直连 ima 失败：${error instanceof Error ? error.message : String(error)}`,
      data: undefined,
      kind: 'programmatic',
      raw: '',
    }
  }
  const parsed = parseJsonObject(text.trim())
  const code = codeOf(parsed)
  if (parsed !== undefined && code !== undefined) {
    return normalize(code, str(parsed.msg), parsed.data, text.slice(0, 500))
  }
  return {
    ok: false,
    code: PROGRAMMATIC_CODE,
    msg: `ima 直连返回无法解析：${text.slice(0, 300)}`,
    data: undefined,
    kind: 'programmatic',
    raw: text.slice(0, 300),
  }
}

// ---------------------------------------------------------------------------
// 笔记模块（只允许 list_notebook / list_note / import_doc / append_doc）
// ---------------------------------------------------------------------------

function parseNotebook(item) {
  const record = asRecord(item) ?? {}
  return {
    id: str(record.folder_id) || str(record.id),
    name: str(record.name),
    noteNumber: num(record.note_number),
  }
}

function parseNote(item) {
  const record = asRecord(item) ?? {}
  return { id: str(record.note_id) || str(record.id), title: str(record.title) }
}

function failedResponse(message) {
  return { ok: false, code: PROGRAMMATIC_CODE, msg: message, data: undefined, kind: 'programmatic', raw: '' }
}

/** list_notebook：按 cursor 翻页取全量笔记本（用名字动态解析 folder_id，绝不硬编码）。 */
export async function imaListNotebooks(options) {
  const collected = []
  let cursor = '0'
  let lastResponse
  for (let page = 0; page < MAX_NOTEBOOK_PAGES; page += 1) {
    const response = await callIma(EP_LIST_NOTEBOOK, { cursor, limit: NOTEBOOK_PAGE_LIMIT }, options)
    lastResponse = response
    if (!response.ok) break
    const pageItems = firstArray(response.data, ['note_folder_infos', 'folders', 'notebook_infos'])
      .map(parseNotebook)
      .filter(notebook => notebook.id !== '')
    collected.push(...pageItems)
    const data = asRecord(response.data) ?? {}
    const next = str(data.next_cursor)
    if (data.is_end === true || next === '' || next === cursor || pageItems.length === 0) break
    cursor = next
  }
  return {
    response: lastResponse ?? failedResponse('未执行 list_notebook'),
    notebooks: collected,
  }
}

/**
 * list_note：用于 auto/append 模式找同名笔记（仍属技能允许的 4 个接口之一）。
 *
 * limit 必须 <= 20（服务端：0 < limit <= 20，超出直接 code=51），因此这里
 * 按 cursor/is_end 翻页，避免笔记数超过一页时漏掉同名笔记而重复新建。
 */
async function imaListNotes(folderId, options) {
  const collected = []
  let cursor = ''
  let response
  let pages = 0
  while (pages < MAX_NOTE_PAGES) {
    pages += 1
    response = await callIma(EP_LIST_NOTE, {
      folder_id: folderId,
      sort_type: 0,
      cursor,
      limit: NOTE_PAGE_LIMIT,
    }, options)
    if (!response.ok) {
      // 首页就失败：把真实失败原样交给调用方判断（鉴权 / limit / 服务端错误）
      return { response, notes: collected }
    }
    const page = firstArray(response.data, ['note_book_list', 'note_infos', 'notes', 'note_list'])
      .map(parseNote)
      .filter(note => note.id !== '')
    collected.push(...page)

    const data = asRecord(response.data) ?? {}
    const next = str(data.next_cursor)
    if (data.is_end === true || next === '' || next === cursor) break
    cursor = next
  }
  return { response, notes: collected }
}

function parseNoteId(response) {
  const data = asRecord(response.data) ?? {}
  const direct = str(data.note_id)
  if (direct !== '') return direct
  const nested = asRecord(data.note_info) ?? {}
  if (str(nested.note_id) !== '') return str(nested.note_id)
  const note = asRecord(data.note) ?? {}
  return str(note.note_id) === '' ? undefined : str(note.note_id)
}

/** import_doc：新建笔记（content_format=1 即 Markdown）。 */
export async function imaImportDoc(content, options) {
  const body = { content_format: 1, content }
  if (options.folderId !== undefined && options.folderId !== '') body.folder_id = options.folderId
  // 内嵌图片的正文很大，callImaAuto 会自动改走直连 HTTP
  const response = await callImaAuto(EP_IMPORT_DOC, body, options)
  const noteId = parseNoteId(response)
  return noteId === undefined ? { response } : { response, noteId }
}

/** append_doc：追加到已有笔记。 */
export async function imaAppendDoc(noteId, content, options) {
  const response = await callImaAuto(EP_APPEND_DOC, {
    note_id: noteId,
    content_format: 1,
    content,
  }, options)
  const returned = parseNoteId(response)
  return returned === undefined ? { response } : { response, noteId: returned }
}

// ---------------------------------------------------------------------------
// 归档正文（技能「二 Step 4」10 字段 + 6 条格式细则）
// ---------------------------------------------------------------------------

/** 允许内嵌的图片 MIME（与 ima 一致：PNG / JPEG / WebP）。 */
const INLINE_IMAGE_TYPES = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp' }

/** 按文件签名判断图片类型；不是受支持的图片返回空串。 */
function detectImageMime(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg'
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  return ''
}

/**
 * 把 markdown 里的本地图片引用改写成 data URL，使笔记本身自包含。
 *
 * 为什么必须这样做：ima 的 `upload_temp_file` 在当前凭证下返回
 * `100001 session ID is required`（连 ima-skill 自带的 note-images.cjs 也一样失败），
 * 拿不到 `download_url`；而 ima 的 markdown 渲染**支持 data URL 图片**（已实测）。
 *
 * 安全边界：只接受 PNG/JPEG/WebP 且校验真实文件签名；总量超过
 * {@link MAX_INLINE_IMAGE_BYTES} 则不内嵌（保留原引用，避免把知识库撑爆）。
 *
 * @param {string} markdown
 * @returns {{ markdown: string, inlined: number, skipped: string[], bytes: number }}
 */
export function inlineLocalImages(markdown) {
  const text = str(markdown)
  const skipped = []
  let inlined = 0
  let totalBytes = 0

  /** 把一个本地图片路径换成 data URL；失败或不支持时返回 undefined。 */
  const toDataUrl = (rawSource) => {
    const source = str(rawSource).trim()
    // 已经是 data URL 或 http(s) 的，交给调用方原样保留
    if (/^(data:|https?:)/i.test(source)) return undefined
    let buffer
    try {
      buffer = readFileSync(source)
    } catch {
      skipped.push(source)
      return undefined
    }
    const mime = detectImageMime(buffer)
    if (mime === '') {
      skipped.push(source)
      return undefined
    }
    if (totalBytes + buffer.length > MAX_INLINE_IMAGE_BYTES) {
      skipped.push(source)
      return undefined
    }
    totalBytes += buffer.length
    inlined += 1
    return `data:${mime};base64,${buffer.toString('base64')}`
  }

  // 1) Markdown 图片：![alt](path)
  let result = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (whole, alt, rawSource) => {
    const dataUrl = toDataUrl(rawSource)
    return dataUrl === undefined ? whole : `![${alt}](${dataUrl})`
  })

  // 2) HTML 图片：<img src="path" ...>（二维码用它来控制 100×100 显示尺寸）
  result = result.replace(/<img\b[^>]*>/gi, (tag) => {
    const matched = /\bsrc\s*=\s*("([^"]*)"|'([^']*)')/i.exec(tag)
    if (matched === null) return tag
    const dataUrl = toDataUrl(matched[2] ?? matched[3] ?? '')
    return dataUrl === undefined ? tag : tag.replace(matched[1], `"${dataUrl}"`)
  })

  return { markdown: result, inlined, skipped, bytes: totalBytes }
}

/** 本地时间 YYYY-MM-DD HH:mm:ss（秒必填）。 */
export function formatDateTime(date) {
  const valid = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date()
  const pad = (value) => String(value).padStart(2, '0')
  return `${valid.getFullYear()}-${pad(valid.getMonth() + 1)}-${pad(valid.getDate())} ` +
    `${pad(valid.getHours())}:${pad(valid.getMinutes())}:${pad(valid.getSeconds())}`
}

function resolveNoteTime(time) {
  if (time instanceof Date) return formatDateTime(time)
  const text = str(time).trim()
  if (text !== '') {
    const parsed = new Date(text)
    if (!Number.isNaN(parsed.getTime())) return formatDateTime(parsed)
  }
  return formatDateTime(new Date())
}

/** 参考代码：已在代码块里的原样保留，否则包一层 cpp 围栏；不写任何模板说明。 */
function formatCodeBlock(code) {
  const body = code.trim()
  if (body === '') return ''
  if (body.includes('```')) return body
  return ['```cpp', body, '```'].join('\n')
}

/** Step 4 的 10 个字段（正文小节顺序固定，一字不改）。 */
const NOTE_FIELDS = [
  { heading: '题目来源', key: 'source' },
  { heading: '题目难度', key: 'difficulty' },
  { heading: '题目大意', key: 'gist' },
  { heading: '考点梳理', key: 'concepts' },
  { heading: '解题思路', key: 'approach' },
  { heading: '易错点', key: 'pitfalls' },
  { heading: '参考代码', key: 'code', render: formatCodeBlock },
  { heading: '复杂度', key: 'complexity' },
  { heading: '评测结论', key: 'verdictEvidence' },
  { heading: '关联题目', key: 'related' },
]

/** 归档人署名（写进归档正文首部）。 */
export const ARCHIVER = '信奥学长插件'

/** 首部用于分隔标题/署名与正文的分隔线（Markdown 水平线）。 */
export const SEPARATOR = '---'

/**
 * 首部两行的写法。
 *
 * 目标（按使用要求）：**不带项目符号、文字也不加粗**，与「信奥教练」的笔记一致。
 *
 * 实测过的四种写法：
 * - 普通段落、`---` 之后**不留空行** → 两行都被自动加粗（最早的版本，已弃用）；
 * - 缩进两格 → 不但加粗，还会把紧随其后的 `---` 吃掉；
 * - 列表项 `- ` → 不加粗，但每行前面多一个项目符号（上一版，用户要求去掉）；
 * - **普通段落 + 前后各留一个空行** → 无符号、不加粗（「信奥教练」的笔记就是这个结构：
 *   它的正文 JSON 里两行都是独立的 `type: "p"` 且没有 `listStyleType`）。
 *
 * 因此这里不再给前缀，而是靠 {@link HEADER_GAP} 的空白把两行切成独立段落。
 */
export const META_PREFIX = ''

/** 首部每行之间插入的空行数（把相邻文本切成独立段落，躲开「首段标签行」自动加粗）。 */
export const HEADER_GAP = 1

/** 推广内容里要推荐的渠道（按顺序拼成「请关注 A、B、C」；可按需增删）。 */
export const PROMO_CHANNELS = ['欣泽编程 公众号', '欣泽编程 视频号', '欣泽编程-信奥知识大全 知识库', '信奥编程算法 小程序']

/** 推广导语。 */
export const PROMO_LEAD = '想学更多信奥知识，请关注'

/** 归档正文末尾的推广小节标题。 */
export const PROMO_HEADING = '推荐关注'

/**
 * 生成推广小节文本（正文最末尾）。
 * @param {string} [custom] 覆盖默认渠道文本；传空串表示不加推广（由调用方处理）
 */
export function buildPromoText(custom) {
  const body = typeof custom === 'string' && custom.trim() !== ''
    ? custom.trim()
    : `${PROMO_LEAD}${PROMO_CHANNELS.join('、')}。`
  return body
}

/** 归档正文末尾「扫码关注」小节标题。 */
export const QR_HEADING = '扫码关注'

/**
 * 生成归档 markdown：
 *   # <题号 [比赛] 题名 - 简短主题>   ← 不含日期时间
 *   （空行）
 *   ---                              ← 分隔线
 *   （空行）
 *   归档人：信奥学长插件              ← 普通段落，无项目符号
 *   （空行）
 *   归档时间：YYYY-MM-DD HH:mm:ss
 *   （空行）
 *   ---                              ← 分隔线
 *   ## 题目来源 / 题目难度 / … / 关联题目  ← 10 个字段固定顺序
 *   ---
 *   ## 推荐关注
 *   想学更多信奥知识，请关注 欣泽编程 公众号、…
 *   ---
 *   ## 扫码关注
 *   **欣泽编程 公众号**——…
 *   ![...](图片)
 * 缺失字段整节省略，不输出空标题。
 * 推广小节默认追加在正文最末尾，可用 promo=false 关闭、promoText 覆盖文案。
 * 二维码由调用方通过 `qrcodes` 传入（[{ label, description, path }]），缺省则不生成该小节。
 */
export function buildNoteMarkdown(input) {
  const raw = asRecord(input) ?? {}
  const titleText = str(raw.title).replace(/\s*\r?\n\s*/g, ' ').trim()
  const noteTime = resolveNoteTime(raw.time)
  const lines = [
    `# ${titleText === '' ? '未命名题解' : titleText}`,
    ...Array(HEADER_GAP).fill(''),
    SEPARATOR,
    ...Array(HEADER_GAP).fill(''),
    `${META_PREFIX}归档人：${ARCHIVER}`,
    ...Array(HEADER_GAP).fill(''),
    `${META_PREFIX}归档时间：${noteTime}`,
    ...Array(HEADER_GAP).fill(''),
    SEPARATOR,
  ]
  for (const field of NOTE_FIELDS) {
    const value = str(raw[field.key])
    const body = field.render !== undefined ? field.render(value) : value.trim()
    if (body === '') continue
    lines.push('', `## ${field.heading}`, body)
  }
  if (raw.promo !== false) {
    lines.push('', SEPARATOR, '', `## ${PROMO_HEADING}`, buildPromoText(raw.promoText))
  }
  // 二维码：用一张合成图（四张码各 120×120、间隔 60 → 660×120），
  // 直接跟在推广文字后面，**不加小节标题、不加图注**——与「信奥教练」笔记的版式一致。
  // 四张独立图不行：宽高比不同，渲染端按原比例缩放会导致高度参差不齐且偏大。
  const combined = asRecord(raw.combinedQr)
  const combinedPath = combined === undefined ? '' : str(combined.path).trim()
  if (combinedPath !== '') {
    const alt = str(combined.alt).trim() || QR_HEADING
    const width = num(combined.width) || 660
    const height = num(combined.height) || 120
    lines.push('', `<img src="${combinedPath}" alt="${alt}" width="${width}" height="${height}" />`)
  } else {
    // 回退：没有合成图时用四张独立图（每张单独一行）
    const qrcodes = Array.isArray(raw.qrcodes) ? raw.qrcodes : []
    const usable = qrcodes.filter(entry => {
      const record = asRecord(entry)
      return record !== undefined && str(record.path).trim() !== ''
    })
    if (usable.length > 0) {
      lines.push('')
      for (const entry of usable) {
        const record = asRecord(entry) ?? {}
        const label = str(record.label).trim()
        lines.push(`![${label === '' ? '二维码' : label}](${str(record.path).trim()})`, '')
      }
    }
  }
  return `${lines.join('\n')}\n`
}

/** 取某个 `## 标题` 小节的正文（到下一个 `## ` 为止）。 */
function sectionBody(lines, heading) {
  const target = `## ${heading}`
  const start = lines.findIndex(line => line.trim() === target)
  if (start < 0) return ''
  const out = []
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith('## ')) break
    out.push(lines[index])
  }
  return out.join('\n').trim()
}

/**
 * 校验归档 markdown，返回具体问题列表（供工具层提示模型重写）。
 * @param {string} markdown
 * @param {{ requirePromo?: boolean }} [options]
 *   requirePromo=true（默认，也是 oi_archive 使用的模式）时，要求末尾存在推广小节且渠道齐全；
 *   自定义文案（promoText）走的是 requirePromo=false，否则自定义必然报「渠道不全」而无法使用。
 * @returns {NoteIssue[]}
 */
export function validateNoteMarkdown(markdown, options) {
  const issues = []
  const text = str(markdown)
  if (text.trim() === '') {
    issues.push({ field: 'markdown', problem: '归档正文为空' })
    return issues
  }
  const lines = text.split(/\r?\n/)
  const title = lines[0] ?? ''
  if (!title.startsWith('# ')) {
    issues.push({ field: '标题', problem: '第一行必须是 H1 标题（以 "# " 开头）' })
  } else {
    const body = title.slice(2).trim()
    if (body === '') issues.push({ field: '标题', problem: '标题内容为空' })
    if (/\d{4}-\d{2}-\d{2}/.test(title) || /\d{1,2}:\d{2}/.test(title)) {
      issues.push({ field: '标题', problem: '标题不能含日期时间：日期时间写在正文首部（归档人 / 归档时间）' })
    }
    if (body !== '' && !body.includes(' - ')) {
      issues.push({ field: '标题', problem: '题名与简短主题之间必须用英文半角 " - "（前后各一个空格）分隔' })
    }
    if (FULLWIDTH_DASH_RE.test(title)) {
      issues.push({ field: '标题', problem: '标题禁用全角破折号（—/–/－）：请改用英文半角 " - "' })
    }
  }

  // 首部固定版式：标题 / 空行 / 分隔线 / 空行 / 归档人 / 空行 / 归档时间 / 空行 / 分隔线
  // 空行的作用见 META_PREFIX 的注释（把各行切成独立段落，躲开 ima 对「首段标签行」的自动加粗）。
  const headerLines = lines.map(line => str(line))
  /** 按「跳过空行」的方式取首个非空行。 */
  const nextNonEmpty = (from) => {
    let index = from
    while (index < headerLines.length && headerLines[index].trim() === '') index += 1
    return index
  }

  const sepIndex = nextNonEmpty(1)
  if ((headerLines[sepIndex] ?? '').trim() !== SEPARATOR) {
    issues.push({ field: '分隔线', problem: '标题下必须是一条分隔线 "---"' })
  }
  const archiverIndex = nextNonEmpty(sepIndex + 1)
  const body2 = headerLines[archiverIndex] ?? ''
  if (!body2.startsWith(`${META_PREFIX}归档人：`)) {
    issues.push({
      field: '归档人',
      problem: `"---" 之下必须是 "${META_PREFIX}归档人：${ARCHIVER}"`,
    })
  } else if (body2.slice(`${META_PREFIX}归档人：`.length).trim() === '') {
    issues.push({ field: '归档人', problem: '归档人不能为空' })
  }

  const archiveIndex = nextNonEmpty(archiverIndex + 1)
  const archiveLine = headerLines[archiveIndex] ?? ''
  if (!archiveLine.startsWith(`${META_PREFIX}归档时间：`)) {
    issues.push({ field: '归档时间', problem: `归档人之下必须是 "${META_PREFIX}归档时间：YYYY-MM-DD HH:mm:ss"` })
  } else if (!/^归档时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(archiveLine.slice(META_PREFIX.length))) {
    issues.push({ field: '归档时间', problem: '归档时间必须精确到秒，格式 YYYY-MM-DD HH:mm:ss' })
  }

  const tailSepIndex = nextNonEmpty(archiveIndex + 1)
  if ((headerLines[tailSepIndex] ?? '').trim() !== SEPARATOR) {
    issues.push({ field: '分隔线', problem: '归档时间下必须是一条分隔线 "---"' })
  }

  const source = sectionBody(lines, '题目来源')
  const urlRe = /https?:\/\/\S+/g
  let match
  while ((match = urlRe.exec(source)) !== null) {
    const before = match.index > 0 ? source[match.index - 1] : ''
    const after = source[match.index + match[0].length] ?? ''
    if (before !== ' ' || after !== ' ') {
      issues.push({ field: '题目来源', problem: 'URL 前后必须各留一个空格（否则 ima 里点链接会 404）' })
      break
    }
  }

  const difficulty = sectionBody(lines, '题目难度')
  if (difficulty !== '' && !(difficulty.includes('（') && difficulty.includes('）'))) {
    issues.push({ field: '题目难度', problem: '难度必须用中文全角括号，格式「（X题）难度名」，如「（蓝题）提高+/省选−」' })
  }

  if (lines.slice(1).some(line => line.includes(FULLWIDTH_HYPHEN))) {
    issues.push({ field: '正文', problem: '正文出现全角连字符「－」：请改用英文半角 "-"' })
  }

  // 推广小节：必须在正文最末尾且非空；默认还要求渠道齐全。
  // requirePromo=false 时不检查（用于 promo=false 或自定义 promoText 的场景）。
  const requirePromo = (asRecord(options) ?? {}).requirePromo !== false
  if (requirePromo) {
    const promoIndex = lines.findIndex(line => line.trim() === `## ${PROMO_HEADING}`)
    if (promoIndex < 0) {
      issues.push({ field: PROMO_HEADING, problem: `正文末尾缺少推广小节 "## ${PROMO_HEADING}"` })
    } else {
      const promoBody = lines.slice(promoIndex + 1).join('\n').trim()
      if (promoBody === '') {
        issues.push({ field: PROMO_HEADING, problem: '推广小节内容为空' })
      } else if (!PROMO_CHANNELS.every(channel => promoBody.includes(channel))) {
        issues.push({
          field: PROMO_HEADING,
          problem: `推广内容必须包含全部渠道：${PROMO_CHANNELS.join('、')}`,
        })
      }
    }
  }

  return issues
}

// ---------------------------------------------------------------------------
// 归档流程
// ---------------------------------------------------------------------------

function discoveryOptions(options) {
  const result = {}
  if (options.homeDir !== undefined) result.homeDir = options.homeDir
  if (options.env !== undefined) result.env = options.env
  return result
}

function callOptionsFor(config, cli, credentials, options) {
  const result = { cliPath: cli.path, credentials, timeoutMs: config.timeoutMs }
  if (options.signal !== undefined) result.signal = options.signal
  return result
}

/** 从 markdown 首行 H1 取笔记标题（auto/append 用来找同名笔记）。 */
function noteTitleFromMarkdown(content) {
  for (const line of str(content).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    return trimmed.startsWith('# ') ? trimmed.slice(2).trim() : trimmed
  }
  return ''
}

function findExistingNote(notes, title) {
  if (title === '') return undefined
  const exact = notes.find(note => note.title === title)
  if (exact !== undefined) return exact
  const numbered = notes
    .filter(note => /-\d+$/.test(note.title) && note.title.replace(/-\d+$/, '') === title)
    .sort((a, b) => a.title.localeCompare(b.title))
  return numbered[numbered.length - 1]
}

function skippedOutcome(notebook, message) {
  return { action: 'skipped', notebook, message, authFailed: false, statusLine: '', silent: true }
}

function failedOutcome(notebook, message, extra) {
  const outcome = { action: 'failed', notebook, message, authFailed: false, statusLine: '', silent: true }
  return Object.assign(outcome, extra)
}

function successOutcome(action, notebook, message, folderId, noteId) {
  const outcome = {
    action,
    notebook,
    message,
    folderId,
    authFailed: false,
    statusLine: `[归档：成功 note_id=${noteId === undefined ? '未知' : noteId}]`,
    silent: false,
  }
  if (noteId !== undefined) outcome.noteId = noteId
  return outcome
}

/**
 * 把一篇题解 markdown 归档到「信奥学长-题解复盘」。
 * 前置不满足一律返回结构化 skipped（silent=true，statusLine=''），不抛异常，绝不落根目录。
 * @returns {Promise<ArchiveOutcome>}
 */
export async function archiveToIma(request, options) {
  const { config } = options
  const requested = str(request.notebook).trim()
  const notebook = requested === '' ? DEFAULT_NOTEBOOK : requested

  if (!config.enabled) {
    return skippedOutcome(notebook, 'ima 归档未启用（配置 ima.enabled=false）')
  }
  const discoverOptions = discoveryOptions(options)
  const cli = discoverImaCli(config, discoverOptions)
  if (cli === undefined) {
    return skippedOutcome(notebook, '未找到 ima-skill 的 ima_api.cjs：请安装 ima-skill，或设置 ima.cliPath / 环境变量 IMA_API_CJS')
  }
  const credentials = resolveCredentials(config, discoverOptions)
  if (credentials.source === 'none') {
    return skippedOutcome(notebook, '未配置 ima 凭证：请到 https://ima.qq.com/agent-interface 生成 Client ID / API Key，并写入 ~/.config/ima/{client_id,api_key}')
  }
  const callOptions = callOptionsFor(config, cli, credentials, options)

  // 1) folder_id 每次按名字动态解析，绝不硬编码
  const listed = await imaListNotebooks(callOptions)
  if (!listed.response.ok) {
    const authFailed = listed.response.kind === 'auth'
    return failedOutcome(
      notebook,
      authFailed ? authAdvice(listed.response) : `list_notebook 失败（code=${listed.response.code}）：${listed.response.msg}`,
      { code: listed.response.code, authFailed },
    )
  }
  const target = listed.notebooks.find(item => item.name === notebook)
  if (target === undefined) {
    const available = listed.notebooks.map(item => item.name).filter(name => name !== '').join('、')
    return skippedOutcome(
      notebook,
      `目标笔记本「${notebook}」不存在（API 不能自动建笔记本）：请在 ima 客户端先创建，本轮不归档、也不落根目录。` +
      `账号现有笔记本：${available === '' ? '无' : available}`,
    )
  }

  // 把正文里的本地图片（如二维码）改写成 data URL，使笔记自包含。
  // 关闭方式：request.inlineImages === false
  const prepared = request.inlineImages === false
    ? { markdown: request.content, inlined: 0, skipped: [], bytes: 0 }
    : inlineLocalImages(request.content)
  if (request.inlineImages !== false && prepared.skipped.length > 0) {
    console.warn(`[dsh-oi-senior] 以下图片未能内嵌（不存在/非 PNG-JPEG-WebP/超总量上限）：${prepared.skipped.join('、')}`)
  }
  const content = prepared.markdown

  // 2) auto/append 时先看目标笔记本里有没有同名笔记
  const mode = request.mode ?? 'auto'
  if (mode !== 'import') {
    const noteList = await imaListNotes(target.id, callOptions)
    if (!noteList.response.ok) {
      // 关键：查不到同名笔记 ≠ 没有同名笔记。
      // 若把 list_note 的失败当成「无同名」而继续 import，就会反复产生重复笔记
      // （真实事故：limit 超限被服务端 code=51 拒绝，auto 每次都新建）。
      // 因此两种模式都如实失败，绝不盲目新建。
      const authFailed = noteList.response.kind === 'auth'
      return failedOutcome(
        notebook,
        authFailed
          ? authAdvice(noteList.response)
          : `list_note 失败（code=${noteList.response.code}）：${noteList.response.msg}；` +
            '为避免产生重复笔记，本次不新建。可改用 mode=import 明确表示「就是要新建」。',
        { code: noteList.response.code, authFailed, folderId: target.id },
      )
    }
    const existing = findExistingNote(noteList.notes, noteTitleFromMarkdown(content))
    if (existing !== undefined) {
      const appended = await imaAppendDoc(existing.id, content, callOptions)
      if (!appended.response.ok) {
        const authFailed = appended.response.kind === 'auth'
        return failedOutcome(
          notebook,
          authFailed ? authAdvice(appended.response) : `append_doc 失败（code=${appended.response.code}）：${appended.response.msg}`,
          { code: appended.response.code, authFailed, folderId: target.id },
        )
      }
      const noteId = appended.noteId ?? existing.id
      return successOutcome('appended', notebook, `已追加到同名笔记（note_id=${noteId}）`, target.id, noteId)
    }
    if (mode === 'append') {
      return skippedOutcome(notebook, `未找到同名笔记「${noteTitleFromMarkdown(content)}」：mode=append 只追加，不新建`)
    }
  }

  // 3) import_doc 真写入；只有 code=0 才算成功
  const imported = await imaImportDoc(content, Object.assign({}, callOptions, { folderId: target.id }))
  if (!imported.response.ok) {
    const authFailed = imported.response.kind === 'auth'
    return failedOutcome(
      notebook,
      authFailed ? authAdvice(imported.response) : `import_doc 失败（code=${imported.response.code}）：${imported.response.msg}`,
      { code: imported.response.code, authFailed, folderId: target.id },
    )
  }
  const noteId = imported.noteId
  const message = noteId === undefined
    ? `已新建笔记（folder_id=${target.id}，返回未含 note_id）`
    : `已新建笔记（folder_id=${target.id}, note_id=${noteId}）`
  return successOutcome('imported', notebook, message, target.id, noteId)
}

// ---------------------------------------------------------------------------
// 环境自检
// ---------------------------------------------------------------------------

/**
 * ima 环境自检：调用器、凭证来源、目标笔记本是否存在（folder_id）、连通性。
 * @returns {Promise<DoctorReport>}
 */
export async function imaDoctor(options) {
  const { config } = options
  const report = {
    enabled: config.enabled,
    credentials: 'none',
    connected: false,
    notebook: DEFAULT_NOTEBOOK,
    availableNotebooks: [],
    message: '',
  }
  if (!config.enabled) {
    return Object.assign({}, report, { message: 'ima 归档未启用（配置 ima.enabled=false）' })
  }
  const discoverOptions = discoveryOptions(options)
  const cli = discoverImaCli(config, discoverOptions)
  if (cli === undefined) {
    return Object.assign({}, report, { message: '未找到 ima-skill 的 ima_api.cjs：请安装 ima-skill，或设置 ima.cliPath / 环境变量 IMA_API_CJS' })
  }
  const credentials = resolveCredentials(config, discoverOptions)
  const withCli = Object.assign({}, report, {
    cliPath: cli.path,
    cliSource: cli.source,
    credentials: credentials.source,
  })
  if (credentials.source === 'none') {
    return Object.assign({}, withCli, {
      message: '未配置 ima 凭证：请到 https://ima.qq.com/agent-interface 生成 Client ID / API Key，并写入 ~/.config/ima/{client_id,api_key}',
    })
  }
  const listed = await imaListNotebooks(callOptionsFor(config, cli, credentials, options))
  if (!listed.response.ok) {
    return Object.assign({}, withCli, {
      code: listed.response.code,
      message: listed.response.kind === 'auth' ? authAdvice(listed.response) : listed.response.msg,
    })
  }
  const availableNotebooks = listed.notebooks.map(item => item.name).filter(name => name !== '')
  const target = listed.notebooks.find(item => item.name === report.notebook)
  if (target === undefined) {
    return Object.assign({}, withCli, {
      connected: true,
      availableNotebooks,
      message: `ima 已连接；目标笔记本「${report.notebook}」不存在，请在 ima 客户端先创建（API 不能自动建笔记本）`,
    })
  }
  return Object.assign({}, withCli, {
    connected: true,
    availableNotebooks,
    folderId: target.id,
    message: `ima 已连接，笔记本「${report.notebook}」已就绪（folder_id=${target.id}）`,
  })
}
