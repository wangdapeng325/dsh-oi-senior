/**
 * dsh-oi-senior · ima 归档模块（src/ima.ts）测试。
 * 运行：cd dsh-oi-senior && node --test test/
 *
 * 说明：
 * - 只用 Node 内置 node:test + node:assert，不引入任何测试框架依赖。
 * - 不依赖外网：用**真实 spawn** 调用一个运行时生成的假 ima_api.cjs（完全复刻真实调用器的
 *   loadCredentials 优先级与 stdout/stderr 协议），由它按 scenario.json 回放响应；
 *   所有临时文件写在系统临时目录，用例内自清理。
 * - 实现加载策略：优先 dist/ima.js（构建产物），dist 不存在时回退直接加载 src/ima.ts
 *   （内容是合法 ESM JS，Node 24 可直接 import）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let loadedFrom = ''
let ima = undefined
let loadError = undefined
for (const specifier of ['../dist/ima.js', '../src/ima.ts']) {
  try {
    ima = await import(specifier)
    loadedFrom = specifier
    break
  } catch (error) {
    loadError = error
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
  }
}
if (ima === undefined) throw loadError ?? new Error('无法加载 ima 实现')
const {
  DEFAULT_IMA_CONFIG,
  DEFAULT_NOTEBOOK,
  archiveToIma,
  authAdvice,
  buildNoteMarkdown,
  callIma,
  discoverImaCli,
  formatDateTime,
  imaAppendDoc,
  imaDoctor,
  imaImportDoc,
  imaListNotebooks,
  resolveCredentials,
  validateNoteMarkdown,
} = ima
console.log(`[ima.test] 已加载实现：${loadedFrom}`)

// ---------------------------------------------------------------------------
// 假 ima_api.cjs（运行时生成）+ 夹具
// ---------------------------------------------------------------------------

const EP_LIST_NOTEBOOK = 'openapi/note/v1/list_notebook'
const EP_LIST_NOTE = 'openapi/note/v1/list_note'
const EP_IMPORT_DOC = 'openapi/note/v1/import_doc'
const EP_APPEND_DOC = 'openapi/note/v1/append_doc'

/**
 * 假调用器源码。它刻意复刻真实 ima_api.cjs 的两个关键行为：
 *   1) loadCredentials 优先级：options JSON > IMA_CLIENT_ID/API_KEY > IMA_OPENAPI_* > ~/.config/ima 文件；
 *   2) 成功写 stdout `{code:0,msg,data}`，失败写 stderr `{code,msg}` 且退出码非 0。
 * 同时把每次调用（入参、options、解析出的凭证、本进程看到的环境变量）追加到 calls.jsonl，
 * 供测试断言"到底是谁的凭证生效了"。
 * scenario.json 里某个接口可以给一个数组，按历史调用次数依次取用（用于翻页测试）。
 */
const FAKE_CLI_SOURCE = [
  "'use strict'",
  "const fs = require('fs')",
  "const os = require('os')",
  "const path = require('path')",
  '',
  "const [apiPath, rawBody = '{}', rawOptions = '{}'] = process.argv.slice(2)",
  "const body = rawBody && rawBody.trim() ? JSON.parse(rawBody) : {}",
  "const options = rawOptions && rawOptions.trim() ? JSON.parse(rawOptions) : {}",
  'const LOG = path.join(__dirname, "calls.jsonl")',
  'const SCENARIO = path.join(__dirname, "scenario.json")',
  '',
  'function readSafe(file) {',
  '  try { return fs.readFileSync(file, "utf8").trim() } catch (e) { return "" }',
  '}',
  '',
  'function priorCalls() {',
  '  return readSafe(LOG).split(/\\r?\\n/).filter(Boolean).map(function (line) {',
  '    try { return JSON.parse(line) } catch (e) { return null }',
  '  }).filter(Boolean)',
  '}',
  '',
  'const resolved = {',
  '  clientId: options.clientId || process.env.IMA_CLIENT_ID || process.env.IMA_OPENAPI_CLIENTID || readSafe(path.join(os.homedir(), ".config", "ima", "client_id")),',
  '  apiKey: options.apiKey || process.env.IMA_API_KEY || process.env.IMA_OPENAPI_APIKEY || readSafe(path.join(os.homedir(), ".config", "ima", "api_key")),',
  '}',
  '',
  'const counted = priorCalls().filter(function (entry) { return entry.apiPath === apiPath }).length',
  'fs.appendFileSync(LOG, JSON.stringify({',
  '  apiPath: apiPath,',
  '  body: body,',
  '  options: options,',
  '  resolved: resolved,',
  '  env: {',
  '    IMA_CLIENT_ID: process.env.IMA_CLIENT_ID || "",',
  '    IMA_API_KEY: process.env.IMA_API_KEY || "",',
  '    IMA_OPENAPI_CLIENTID: process.env.IMA_OPENAPI_CLIENTID || "",',
  '    IMA_OPENAPI_APIKEY: process.env.IMA_OPENAPI_APIKEY || "",',
  '    IMA_API_CJS: process.env.IMA_API_CJS || ""',
  '  }',
  '}) + "\\n")',
  '',
  'let scenario = {}',
  'try { scenario = JSON.parse(readSafe(SCENARIO) || "{}") } catch (e) { scenario = {} }',
  'let plan = scenario[apiPath]',
  'if (Array.isArray(plan)) plan = plan[Math.min(counted, plan.length - 1)]',
  'if (!plan) {',
  '  process.stderr.write(JSON.stringify({ code: -100, msg: "fake: unknown endpoint " + apiPath }))',
  '  process.exit(1)',
  '}',
  'if (plan.sleepMs) {',
  '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, plan.sleepMs)',
  '}',
  'if (plan.stdout) process.stdout.write(JSON.stringify(plan.stdout))',
  'if (plan.stderr) {',
  '  process.stderr.write(JSON.stringify(plan.stderr))',
  '  process.exit(typeof plan.exitCode === "number" ? plan.exitCode : 1)',
  '}',
  'if (!plan.stdout && !plan.stderr) process.stdout.write(JSON.stringify({ code: 0, msg: "ok", data: {} }))',
].join('\n')

const okPlan = (data) => ({ stdout: { code: 0, msg: 'ok', data } })
const errPlan = (code, msg) => ({ stderr: { code, msg }, exitCode: 1 })

/** 动态解析出来的 folder_id（刻意用不像硬编码的值）。 */
const FOLDER_ID = 'Tz9Kx-dynamic-folder-77'

const NOTEBOOKS = [
  { folder_id: 'folder-other-1', name: '无关笔记本', note_number: 1 },
  { folder_id: FOLDER_ID, name: DEFAULT_NOTEBOOK, note_number: 3 },
]

const SAMPLE_CODE = '#include <bits/stdc++.h>\nint main() { return 0; }'

function sampleInput(overrides = {}) {
  return {
    title: 'P7077 [CSP-S 2020] 函数调用 - 树形DP+拓扑序',
    time: new Date(2026, 9, 5, 9, 47, 9),
    source: '洛谷 P7077 [CSP-S 2020] 函数调用 （ https://www.luogu.com.cn/problem/P7077 ）',
    difficulty: '（蓝题）提高+/省选−',
    gist: '给定函数调用关系，求最终序列。输入 n、m、q，输出序列各项。',
    concepts: '拓扑排序：先建调用图，再按拓扑序逆推每个函数对序列的贡献。',
    approach: '先写暴力模拟调用链，再用拓扑序 + 乘法标记优化到线性。',
    pitfalls: '乘法标记下传时注意取模；调用顺序不要搞反。',
    code: SAMPLE_CODE,
    complexity: '时间 O(n+m+q)，空间 O(n+m)。',
    verdictEvidence: '与暴力对拍 200 组随机数据全部一致；洛谷真实编译评测 AC。',
    related: 'P3953、P5022',
    ...overrides,
  }
}

function defaultScenario(overrides = {}) {
  return {
    [EP_LIST_NOTEBOOK]: okPlan({ note_folder_infos: NOTEBOOKS, next_cursor: '', is_end: true }),
    [EP_LIST_NOTE]: okPlan({ note_infos: [], is_end: true }),
    [EP_IMPORT_DOC]: okPlan({ note_id: 'note-new-1' }),
    [EP_APPEND_DOC]: okPlan({ note_id: 'note-existing-1' }),
    ...overrides,
  }
}

const cleanups = []
test.after(() => {
  for (const dir of cleanups) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 忽略清理失败 */
    }
  }
})

/** 造一个假调用器目录（含 scenario.json）。 */
function makeCli(scenario = defaultScenario()) {
  const dir = mkdtempSync(join(tmpdir(), 'oi-senior-ima-cli-'))
  cleanups.push(dir)
  writeFileSync(join(dir, 'fake_ima.cjs'), FAKE_CLI_SOURCE)
  writeFileSync(join(dir, 'scenario.json'), JSON.stringify(scenario, null, 2))
  return { dir, cliPath: join(dir, 'fake_ima.cjs'), logPath: join(dir, 'calls.jsonl') }
}

function readCalls(logPath) {
  try {
    return readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
  } catch {
    return []
  }
}

/** 造一个假 HOME；creds 传 null 表示故意不放凭证文件。 */
function makeHome(creds = { clientId: 'home-client', apiKey: 'home-key' }) {
  const home = mkdtempSync(join(tmpdir(), 'oi-senior-ima-home-'))
  cleanups.push(home)
  if (creds !== null) {
    mkdirSync(join(home, '.config', 'ima'), { recursive: true })
    writeFileSync(join(home, '.config', 'ima', 'client_id'), `${creds.clientId}\n`)
    writeFileSync(join(home, '.config', 'ima', 'api_key'), `${creds.apiKey}\n`)
  }
  return home
}

function configWith(overrides = {}) {
  return { ...DEFAULT_IMA_CONFIG, ...overrides }
}

/** 落盘的调用参数（真实 spawn，凭证来自文件）。 */
function fileCallOptions(cliPath, home) {
  return {
    cliPath,
    credentials: { clientId: 'home-client', apiKey: 'home-key', source: 'file' },
    timeoutMs: 15000,
    homeDir: home,
  }
}

// ---------------------------------------------------------------------------
// discoverImaCli：配置 → 环境变量 → 已知目录 → 搜索
// ---------------------------------------------------------------------------

test('discoverImaCli：配置路径优先，且校验文件存在', () => {
  const cli = makeCli()
  const home = makeHome()
  // 同时在"已知目录"放一个，证明配置优先
  mkdirSync(join(home, '.workbuddy', 'skills', 'ima-skill'), { recursive: true })
  writeFileSync(join(home, '.workbuddy', 'skills', 'ima-skill', 'ima_api.cjs'), '// known')
  const found = discoverImaCli({ cliPath: cli.cliPath }, { homeDir: home, env: {} })
  assert.equal(found.source, 'config')
  assert.equal(found.path, cli.cliPath)

  const missing = discoverImaCli({ cliPath: join(home, 'nope.cjs') }, { homeDir: home, env: {} })
  assert.equal(missing.source, 'known', '配置里的路径不存在时应继续降级到已知目录')
})

test('discoverImaCli：环境变量 IMA_API_CJS 次之', () => {
  const cli = makeCli()
  const home = makeHome()
  const found = discoverImaCli({ cliPath: '' }, { homeDir: home, env: { IMA_API_CJS: cli.cliPath } })
  assert.deepEqual(found, { path: cli.cliPath, source: 'env' })
})

test('discoverImaCli：已知技能目录（含 .workbuddy/plugins）', () => {
  for (const root of [
    ['.workbuddy', 'skills'],
    ['.dsh', 'skills'],
    ['.claude', 'skills'],
    ['.codex', 'skills'],
    ['.cursor', 'skills'],
    ['.workbuddy', 'plugins'],
  ]) {
    const home = makeHome()
    const dir = join(home, ...root, 'ima-skill')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ima_api.cjs'), '// known')
    const found = discoverImaCli({ cliPath: '' }, { homeDir: home, env: {} })
    assert.equal(found.source, 'known', `未在 ${root.join('/')} 命中`)
    assert.equal(found.path, join(dir, 'ima_api.cjs'))
  }
})

test('discoverImaCli：兜底有限深度搜索；彻底没有则 undefined', () => {
  const home = makeHome()
  const deep = join(home, '.claude', 'skills', 'some-skill', 'tools', 'ima_api.cjs')
  mkdirSync(join(home, '.claude', 'skills', 'some-skill', 'tools'), { recursive: true })
  writeFileSync(deep, '// deep')
  assert.deepEqual(discoverImaCli({ cliPath: '' }, { homeDir: home, env: {} }), { path: deep, source: 'search' })

  const emptyHome = makeHome()
  assert.equal(discoverImaCli({ cliPath: '' }, { homeDir: emptyHome, env: {} }), undefined)
})

// ---------------------------------------------------------------------------
// resolveCredentials：config > env > 文件
// ---------------------------------------------------------------------------

test('resolveCredentials：config > env > 文件', () => {
  const home = makeHome()
  const env = { IMA_CLIENT_ID: 'env-id', IMA_API_KEY: 'env-key' }

  assert.deepEqual(
    resolveCredentials({ clientId: 'cfg-id', apiKey: 'cfg-key' }, { homeDir: home, env }),
    { clientId: 'cfg-id', apiKey: 'cfg-key', source: 'config' },
  )
  assert.deepEqual(
    resolveCredentials({ clientId: '', apiKey: '' }, { homeDir: home, env }),
    { clientId: 'env-id', apiKey: 'env-key', source: 'env' },
  )
  assert.deepEqual(
    resolveCredentials({ clientId: '', apiKey: '' }, { homeDir: home, env: {} }),
    { clientId: 'home-client', apiKey: 'home-key', source: 'file' },
  )
})

test('resolveCredentials：半配置不算数，会继续降级；兼容 IMA_OPENAPI_* 旧变量；全无则 none', () => {
  const home = makeHome()
  assert.deepEqual(
    resolveCredentials({ clientId: 'only-id', apiKey: '' }, { homeDir: home, env: {} }),
    { clientId: 'home-client', apiKey: 'home-key', source: 'file' },
    '只有 clientId 时不能当 config 凭证',
  )
  assert.deepEqual(
    resolveCredentials({ clientId: '', apiKey: '' }, { homeDir: home, env: { IMA_OPENAPI_CLIENTID: 'legacy-id', IMA_OPENAPI_APIKEY: 'legacy-key' } }),
    { clientId: 'legacy-id', apiKey: 'legacy-key', source: 'env' },
  )
  const emptyHome = makeHome(null)
  assert.deepEqual(
    resolveCredentials({ clientId: '', apiKey: '' }, { homeDir: emptyHome, env: {} }),
    { clientId: '', apiKey: '', source: 'none' },
  )
})

// ---------------------------------------------------------------------------
// callIma：真实 spawn 假调用器
// ---------------------------------------------------------------------------

test('callIma：code=0 → ok/kind=ok；请求体与端点如实落到调用链', async () => {
  const cli = makeCli()
  const response = await callIma(EP_LIST_NOTEBOOK, { cursor: '0', limit: 20 }, {
    cliPath: cli.cliPath,
    credentials: { clientId: 'c1', apiKey: 'k1', source: 'file' },
    timeoutMs: 15000,
  })
  assert.equal(response.ok, true)
  assert.equal(response.code, 0)
  assert.equal(response.kind, 'ok')
  assert.equal(response.msg, 'ok')
  assert.deepEqual(response.data.note_folder_infos.length, 2)

  const calls = readCalls(cli.logPath)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].apiPath, EP_LIST_NOTEBOOK)
  assert.deepEqual(calls[0].body, { cursor: '0', limit: 20 })
  assert.equal(calls[0].options.clientId, 'c1')
  assert.equal(calls[0].options.apiKey, 'k1')
})

test('callIma：显式 options 压过陈旧环境变量（否则 200002）', async () => {
  const cli = makeCli()
  const savedId = process.env.IMA_OPENAPI_CLIENTID
  const savedKey = process.env.IMA_OPENAPI_APIKEY
  process.env.IMA_OPENAPI_CLIENTID = 'stale-client-id'
  process.env.IMA_OPENAPI_APIKEY = 'stale-api-key'
  try {
    const response = await callIma(EP_LIST_NOTEBOOK, { cursor: '0', limit: 20 }, {
      cliPath: cli.cliPath,
      credentials: { clientId: 'file-client', apiKey: 'file-key', source: 'file' },
      timeoutMs: 15000,
    })
    assert.equal(response.ok, true)
    const call = readCalls(cli.logPath)[0]
    // 陈旧环境变量确实存在于子进程环境里……
    assert.equal(call.env.IMA_OPENAPI_CLIENTID, 'stale-client-id')
    assert.equal(call.env.IMA_OPENAPI_APIKEY, 'stale-api-key')
    // ……但假调用器（复刻真实优先级）最终采用 options 里的凭证
    assert.deepEqual(call.options, { clientId: 'file-client', apiKey: 'file-key' })
    assert.equal(call.resolved.clientId, 'file-client')
    assert.equal(call.resolved.apiKey, 'file-key')
  } finally {
    if (savedId === undefined) delete process.env.IMA_OPENAPI_CLIENTID
    else process.env.IMA_OPENAPI_CLIENTID = savedId
    if (savedKey === undefined) delete process.env.IMA_OPENAPI_APIKEY
    else process.env.IMA_OPENAPI_APIKEY = savedKey
  }
})

test('callIma：code=200002 → kind=auth，不抛异常（stderr 与真实世界的 stdout 两种写法）', async () => {
  const cli = makeCli(defaultScenario({ [EP_LIST_NOTEBOOK]: errPlan(200002, 'skill auth failed') }))
  const response = await callIma(EP_LIST_NOTEBOOK, {}, {
    cliPath: cli.cliPath,
    credentials: { clientId: 'c', apiKey: 'k', source: 'file' },
    timeoutMs: 15000,
  })
  assert.equal(response.ok, false)
  assert.equal(response.code, 200002)
  assert.equal(response.kind, 'auth')
  assert.equal(response.msg, 'skill auth failed')
  assert.match(authAdvice(response), /agent-interface/)

  // 真实 ima_api.cjs 在鉴权失败时是把 {code:200002} 写进 **stdout** 且退出码 0（实测），
  // 这里按现实再验一遍，免得只认 stderr 那条路。
  const realWorld = makeCli(defaultScenario({
    [EP_LIST_NOTEBOOK]: { stdout: { code: 200002, msg: 'skill auth failed', data: {} }, exitCode: 0 },
  }))
  const stdoutAuth = await callIma(EP_LIST_NOTEBOOK, {}, {
    cliPath: realWorld.cliPath,
    credentials: { clientId: 'c', apiKey: 'k', source: 'file' },
    timeoutMs: 15000,
  })
  assert.equal(stdoutAuth.ok, false)
  assert.equal(stdoutAuth.code, 200002)
  assert.equal(stdoutAuth.kind, 'auth')
})

test('callIma：-200（stdout 更新上下文 + stderr code=-200）→ kind=update', async () => {
  const cli = makeCli(defaultScenario({
    [EP_LIST_NOTEBOOK]: {
      stdout: { current_version: '1.1.10', latest_version: '1.2.0', release_desc: 'x', instruction: '请更新' },
      stderr: { code: -200, msg: '发现新版本 skill' },
      exitCode: 1,
    },
  }))
  const response = await callIma(EP_LIST_NOTEBOOK, {}, {
    cliPath: cli.cliPath,
    credentials: { clientId: 'c', apiKey: 'k', source: 'file' },
    timeoutMs: 15000,
  })
  assert.equal(response.code, -200)
  assert.equal(response.kind, 'update')
  assert.equal(response.msg, '发现新版本 skill')
  assert.match(response.raw, /latest_version/)
})

test('callIma：调用器不存在 / 超时 → 结构化 programmatic 错误，不抛异常', async () => {
  const gone = await callIma(EP_LIST_NOTEBOOK, {}, {
    cliPath: join(tmpdir(), 'definitely-missing-ima_api.cjs'),
    credentials: { clientId: 'c', apiKey: 'k', source: 'file' },
    timeoutMs: 15000,
  })
  assert.equal(gone.ok, false)
  assert.equal(gone.code, -100)
  assert.equal(gone.kind, 'programmatic')

  const cli = makeCli(defaultScenario({ [EP_LIST_NOTEBOOK]: { stdout: { code: 0, msg: 'ok', data: {} }, sleepMs: 4000 } }))
  const started = Date.now()
  const timedOut = await callIma(EP_LIST_NOTEBOOK, {}, {
    cliPath: cli.cliPath,
    credentials: { clientId: 'c', apiKey: 'k', source: 'file' },
    timeoutMs: 400,
  })
  assert.equal(timedOut.ok, false)
  assert.equal(timedOut.code, -100)
  assert.match(timedOut.msg, /超时/)
  assert.ok(Date.now() - started < 3500, '超时应提前结束，不能等子进程自然退出')
})

// ---------------------------------------------------------------------------
// 笔记接口
// ---------------------------------------------------------------------------

test('imaListNotebooks：按 cursor 翻页汇总；imaImportDoc / imaAppendDoc 取 note_id', async () => {
  const cli = makeCli(defaultScenario({
    [EP_LIST_NOTEBOOK]: [
      okPlan({ note_folder_infos: [{ folder_id: 'f1', name: '第一页', note_number: 1 }], next_cursor: 'c1', is_end: false }),
      okPlan({ note_folder_infos: [{ folder_id: 'f2', name: '第二页', note_number: 2 }], next_cursor: '', is_end: true }),
    ],
  }))
  const options = fileCallOptions(cli.cliPath, makeHome())
  const listed = await imaListNotebooks(options)
  assert.equal(listed.response.ok, true)
  assert.deepEqual(listed.notebooks, [
    { id: 'f1', name: '第一页', noteNumber: 1 },
    { id: 'f2', name: '第二页', noteNumber: 2 },
  ])
  const calls = readCalls(cli.logPath)
  assert.deepEqual(calls.map(call => call.body.cursor), ['0', 'c1'])

  const imported = await imaImportDoc('# T - 主题', { ...options, folderId: 'f2' })
  assert.equal(imported.noteId, 'note-new-1')
  const appendCalls = readCalls(cli.logPath)
  const importBody = appendCalls.find(call => call.apiPath === EP_IMPORT_DOC).body
  assert.deepEqual(importBody, { content_format: 1, content: '# T - 主题', folder_id: 'f2' })

  const appended = await imaAppendDoc('note-x', '补充', options)
  assert.equal(appended.noteId, 'note-existing-1')
  assert.equal(
    readCalls(cli.logPath).find(call => call.apiPath === EP_APPEND_DOC).body.note_id,
    'note-x',
  )
})

// ---------------------------------------------------------------------------
// archiveToIma：降级与成功路径
// ---------------------------------------------------------------------------

const ARCHIVE_MD = buildNoteMarkdown(sampleInput())

function archiveContext(cli, home, configOverrides = {}) {
  return {
    config: configWith({ cliPath: cli.cliPath, ...configOverrides }),
    homeDir: home,
    env: {},
  }
}

test('archiveToIma：未启用 / 找不到调用器 / 无凭证 → skipped + silent，不抛异常', async () => {
  const cli = makeCli()
  const home = makeHome()

  const disabled = await archiveToIma({ content: ARCHIVE_MD }, archiveContext(cli, home, { enabled: false }))
  assert.equal(disabled.action, 'skipped')
  assert.equal(disabled.silent, true)
  assert.equal(disabled.statusLine, '')
  assert.equal(disabled.authFailed, false)
  assert.equal(disabled.notebook, DEFAULT_NOTEBOOK)

  const noCli = await archiveToIma({ content: ARCHIVE_MD }, {
    config: configWith({ cliPath: join(home, 'missing.cjs') }),
    homeDir: makeHome(null),
    env: {},
  })
  assert.equal(noCli.action, 'skipped')
  assert.equal(noCli.silent, true)
  assert.match(noCli.message, /ima_api\.cjs/)

  const noCreds = await archiveToIma({ content: ARCHIVE_MD }, archiveContext(cli, makeHome(null)))
  assert.equal(noCreds.action, 'skipped')
  assert.equal(noCreds.silent, true)
  assert.equal(noCreds.statusLine, '')
  assert.match(noCreds.message, /凭证/)
  assert.equal(readCalls(cli.logPath).length, 0, '无凭证时不应该发起任何调用')
})

test('archiveToIma：笔记本不存在 → skipped + silent，且绝不落根目录', async () => {
  const cli = makeCli(defaultScenario({
    [EP_LIST_NOTEBOOK]: okPlan({
      note_folder_infos: [{ folder_id: 'folder-only', name: '别的笔记本', note_number: 1 }],
      next_cursor: '',
      is_end: true,
    }),
  }))
  const outcome = await archiveToIma({ content: ARCHIVE_MD }, archiveContext(cli, makeHome()))
  assert.equal(outcome.action, 'skipped')
  assert.equal(outcome.silent, true)
  assert.equal(outcome.statusLine, '')
  assert.match(outcome.message, /不存在/)
  assert.match(outcome.message, /别的笔记本/)

  const paths = readCalls(cli.logPath).map(call => call.apiPath)
  assert.deepEqual(paths, [EP_LIST_NOTEBOOK], '笔记本缺失时只能查列表，绝不能 import/append')
  assert.ok(!paths.includes(EP_IMPORT_DOC))
  assert.ok(!paths.includes(EP_APPEND_DOC))
})

test('archiveToIma：list_notebook 鉴权失败 → failed + authFailed + silent', async () => {
  const cli = makeCli(defaultScenario({ [EP_LIST_NOTEBOOK]: errPlan(200002, 'skill auth failed') }))
  const outcome = await archiveToIma({ content: ARCHIVE_MD }, archiveContext(cli, makeHome()))
  assert.equal(outcome.action, 'failed')
  assert.equal(outcome.authFailed, true)
  assert.equal(outcome.silent, true)
  assert.equal(outcome.statusLine, '')
  assert.equal(outcome.code, 200002)
  assert.match(outcome.message, /agent-interface/)
})

test('archiveToIma：code=0 → imported + silent=false + 状态行；folder_id 动态解析', async () => {
  const cli = makeCli()
  const home = makeHome()
  const outcome = await archiveToIma({ content: ARCHIVE_MD }, archiveContext(cli, home))
  assert.equal(outcome.action, 'imported')
  assert.equal(outcome.silent, false)
  assert.equal(outcome.statusLine, '[归档：成功 note_id=note-new-1]')
  assert.equal(outcome.folderId, FOLDER_ID)
  assert.equal(outcome.noteId, 'note-new-1')
  assert.equal(outcome.notebook, DEFAULT_NOTEBOOK)
  assert.equal(outcome.authFailed, false)

  const importCall = readCalls(cli.logPath).find(call => call.apiPath === EP_IMPORT_DOC)
  assert.equal(importCall.body.folder_id, FOLDER_ID, 'folder_id 必须来自 list_notebook 动态解析')
  assert.equal(importCall.body.content_format, 1)
  assert.equal(importCall.body.content, ARCHIVE_MD)
  assert.equal(importCall.body.content.includes('归档时间：2026-10-05 09:47:09'), true)
})

test('archiveToIma：import_doc 失败 → failed + silent + 真实错误码', async () => {
  const cli = makeCli(defaultScenario({ [EP_IMPORT_DOC]: errPlan(100009, '超过大小限制') }))
  const outcome = await archiveToIma({ content: ARCHIVE_MD }, archiveContext(cli, makeHome()))
  assert.equal(outcome.action, 'failed')
  assert.equal(outcome.silent, true)
  assert.equal(outcome.statusLine, '')
  assert.equal(outcome.code, 100009)
  assert.equal(outcome.folderId, FOLDER_ID)
  assert.match(outcome.message, /100009/)
})

test('archiveToIma：mode=auto 同名则 append；mode=append 无同名则 skipped；mode=import 总是新建', async () => {
  const title = sampleInput().title
  const withExisting = defaultScenario({
    [EP_LIST_NOTE]: okPlan({ note_infos: [{ note_id: 'note-old-7', title }], is_end: true }),
  })

  const autoCli = makeCli(withExisting)
  const auto = await archiveToIma({ content: ARCHIVE_MD, mode: 'auto' }, archiveContext(autoCli, makeHome()))
  assert.equal(auto.action, 'appended')
  assert.equal(auto.silent, false)
  assert.equal(auto.statusLine, '[归档：成功 note_id=note-existing-1]')
  assert.equal(readCalls(autoCli.logPath).some(call => call.apiPath === EP_APPEND_DOC), true)
  assert.equal(readCalls(autoCli.logPath).some(call => call.apiPath === EP_IMPORT_DOC), false)

  const importCli = makeCli(withExisting)
  const forced = await archiveToIma({ content: ARCHIVE_MD, mode: 'import' }, archiveContext(importCli, makeHome()))
  assert.equal(forced.action, 'imported')
  assert.equal(readCalls(importCli.logPath).some(call => call.apiPath === EP_LIST_NOTE), false, 'mode=import 不需要查同名笔记')

  const appendCli = makeCli()
  const append = await archiveToIma({ content: ARCHIVE_MD, mode: 'append' }, archiveContext(appendCli, makeHome()))
  assert.equal(append.action, 'skipped')
  assert.equal(append.silent, true)
  assert.equal(readCalls(appendCli.logPath).some(call => call.apiPath === EP_IMPORT_DOC), false)
})

test('archiveToIma：真实服务返回的 note_book_list 必须被识别（auto 才能查到同名笔记）', async () => {
  // 回归用例：真实 ima 的 openapi/note/v1/list_note 返回键是 `note_book_list`，
  // 而早期实现只认 note_infos / notes / note_list，导致 auto / append 永远查不到
  // 同名笔记 —— 表现为 mode=append 误判「无同名」而 skipped、mode=auto 反复新建重复笔记。
  const title = sampleInput().title
  const realShape = defaultScenario({
    [EP_LIST_NOTE]: okPlan({ note_book_list: [{ note_id: 'note-real-9', title }], is_end: true }),
  })

  const autoCli = makeCli(realShape)
  const auto = await archiveToIma({ content: ARCHIVE_MD, mode: 'auto' }, archiveContext(autoCli, makeHome()))
  assert.equal(auto.action, 'appended', '真实返回结构下也应命中同名笔记并追加')
  assert.equal(auto.silent, false)
  assert.equal(readCalls(autoCli.logPath).some(call => call.apiPath === EP_IMPORT_DOC), false, '命中同名时不应新建')

  const appendCli = makeCli(realShape)
  const appended = await archiveToIma({ content: ARCHIVE_MD, mode: 'append' }, archiveContext(appendCli, makeHome()))
  assert.equal(appended.action, 'appended', 'mode=append 在真实返回结构下也应追加而不是 skipped')
  assert.equal(readCalls(appendCli.logPath).some(call => call.apiPath === EP_APPEND_DOC), true)
})

test('archiveToIma：list_note 的 limit 必须 <= 20（服务端约束），否则 auto 会静默重复新建', async () => {
  // 回归用例：真实服务端 ListNoteReq 规定 0 < limit <= 20，传 50 会被 code=51 拒绝。
  // 一旦超限，auto 模式的 existing 恒为 undefined → 每次归档都新建 = 重复笔记。
  const title = sampleInput().title
  const cli = makeCli(defaultScenario({
    [EP_LIST_NOTE]: okPlan({ note_book_list: [{ note_id: 'note-real-9', title }], is_end: true }),
  }))
  await archiveToIma({ content: ARCHIVE_MD, mode: 'auto' }, archiveContext(cli, makeHome()))

  const listCalls = readCalls(cli.logPath).filter(call => call.apiPath === EP_LIST_NOTE)
  assert.ok(listCalls.length > 0, 'auto 模式必须查同名笔记')
  for (const call of listCalls) {
    const limit = call.body?.limit
    assert.equal(typeof limit, 'number', 'list_note 必须带 limit')
    assert.ok(limit > 0 && limit <= 20, `list_note 的 limit 必须在 (0,20]，实际 ${limit}`)
  }
})

test('archiveToIma：list_note 服务端报 limit 非法时必须如实失败，不得当成「无同名」而新建', async () => {
  // 真实服务端对超限 limit 返回 code=51。若把它当成「没有同名笔记」，
  // auto 就会直接 import 造成重复笔记 —— 这里锁定必须如实上报失败。
  const cli = makeCli(defaultScenario({
    [EP_LIST_NOTE]: errPlan(51, 'invalid ListNoteReq.Limit: value must be inside range (0, 20]'),
  }))
  const outcome = await archiveToIma({ content: ARCHIVE_MD, mode: 'auto' }, archiveContext(cli, makeHome()))

  // 允许两种取舍：明确 failed，或明确 skipped —— 但都**不能** imported
  assert.notEqual(outcome.action, 'imported', 'list_note 失败时绝不能盲目新建笔记')
  assert.equal(
    readCalls(cli.logPath).some(call => call.apiPath === EP_IMPORT_DOC),
    false,
    'list_note 失败时不应发起 import_doc',
  )
})

test('archiveToIma：notebook 可覆盖，名字不同则仍按动态解析的 folder_id 写入', async () => {
  const custom = '自定义-复盘本'
  const cli = makeCli(defaultScenario({
    [EP_LIST_NOTEBOOK]: okPlan({
      note_folder_infos: [{ folder_id: 'folder-custom-9', name: custom, note_number: 0 }],
      next_cursor: '',
      is_end: true,
    }),
  }))
  const outcome = await archiveToIma({ content: ARCHIVE_MD, notebook: custom }, archiveContext(cli, makeHome()))
  assert.equal(outcome.action, 'imported')
  assert.equal(outcome.notebook, custom)
  assert.equal(outcome.folderId, 'folder-custom-9')
  assert.equal(readCalls(cli.logPath).find(call => call.apiPath === EP_IMPORT_DOC).body.folder_id, 'folder-custom-9')
})

// ---------------------------------------------------------------------------
// imaDoctor
// ---------------------------------------------------------------------------

test('imaDoctor：未启用 / 无调用器 / 无凭证 / 鉴权失败 / 连通与笔记本缺失', async () => {
  const cli = makeCli()
  const home = makeHome()

  const disabled = await imaDoctor({ config: configWith({ enabled: false }), homeDir: home, env: {} })
  assert.equal(disabled.enabled, false)
  assert.equal(disabled.connected, false)
  assert.equal(disabled.notebook, DEFAULT_NOTEBOOK)

  const noCli = await imaDoctor({ config: configWith({ cliPath: join(home, 'nope.cjs') }), homeDir: makeHome(null), env: {} })
  assert.equal(noCli.cliPath, undefined)
  assert.equal(noCli.connected, false)

  const noCreds = await imaDoctor({ config: configWith({ cliPath: cli.cliPath }), homeDir: makeHome(null), env: {} })
  assert.equal(noCreds.credentials, 'none')
  assert.equal(noCreds.connected, false)
  assert.match(noCreds.message, /凭证/)

  const authCli = makeCli(defaultScenario({ [EP_LIST_NOTEBOOK]: errPlan(200002, 'skill auth failed') }))
  const auth = await imaDoctor({ config: configWith({ cliPath: authCli.cliPath }), homeDir: home, env: {} })
  assert.equal(auth.connected, false)
  assert.equal(auth.code, 200002)
  assert.equal(auth.credentials, 'file')
  assert.equal(auth.cliSource, 'config')
  assert.match(auth.message, /agent-interface/)

  const good = await imaDoctor({ config: configWith({ cliPath: cli.cliPath }), homeDir: home, env: {} })
  assert.equal(good.connected, true)
  assert.equal(good.folderId, FOLDER_ID)
  assert.deepEqual(good.availableNotebooks, ['无关笔记本', DEFAULT_NOTEBOOK])
  assert.match(good.message, /已就绪/)

  const missingCli = makeCli(defaultScenario({
    [EP_LIST_NOTEBOOK]: okPlan({ note_folder_infos: [], next_cursor: '', is_end: true }),
  }))
  const missing = await imaDoctor({ config: configWith({ cliPath: missingCli.cliPath }), homeDir: home, env: {} })
  assert.equal(missing.connected, true)
  assert.equal(missing.folderId, undefined)
  assert.equal(missing.availableNotebooks.length, 0)
  assert.match(missing.message, /不存在/)
})

// ---------------------------------------------------------------------------
// buildNoteMarkdown：标题与 10 字段
// ---------------------------------------------------------------------------

test('buildNoteMarkdown：H1 题号在最前、不含日期；首部为普通段落（无符号、不缩进）→ 分隔线；10 字段固定顺序', () => {
  const md = buildNoteMarkdown(sampleInput())
  const lines = md.split('\n')
  assert.equal(lines[0], '# P7077 [CSP-S 2020] 函数调用 - 树形DP+拓扑序')
  // 首部：标题 / 空行 / --- / 空行 / 归档人 / 空行 / 归档时间 / 空行 / ---
  const nonEmpty = lines.slice(0, 10).filter(line => line.trim() !== '')
  assert.deepEqual(nonEmpty, [
    '# P7077 [CSP-S 2020] 函数调用 - 树形DP+拓扑序',
    '---',
    '归档人：信奥学长插件',
    '归档时间：2026-10-05 09:47:09',
    '---',
  ], '首部顺序：标题 → 分隔线 → 归档人 → 归档时间 → 分隔线')
  // 两行必须是「普通段落 + 前后空行」：无项目符号、无缩进
  assert.ok(!/^- /.test(lines[4]), '归档人不能是列表项（会显示圆点）')
  assert.ok(!/^- /.test(lines[6]), '归档时间不能是列表项（会显示圆点）')
  assert.equal(lines[1], '', '标题与分隔线之间要有空行')
  assert.equal(lines[3], '', '分隔线与归档人之间要有空行')
  assert.equal(lines[5], '', '归档人与归档时间之间要有空行（切成独立段落才不会加粗）')
  assert.equal(lines[7], '', '归档时间与分隔线之间要有空行')
  assert.ok(!/^ {2}/m.test(lines.slice(2, 8).join('\n')), '首部不缩进（缩进会被吃掉分隔线）')
  assert.ok(!md.includes('记录时间'), '已按要求去掉记录时间')
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(lines[0]), '标题不能含日期')
  assert.ok(lines[0].includes(' - '), '题名与主题之间用英文半角 " - "')
  assert.ok(!/[\u2014\u2013\uff0d]/.test(lines[0]), '标题不能有全角破折号')

  assert.deepEqual(
    md.match(/^## .+$/gm),
    ['## 题目来源', '## 题目难度', '## 题目大意', '## 考点梳理', '## 解题思路', '## 易错点', '## 参考代码', '## 复杂度', '## 评测结论', '## 关联题目', '## 推荐关注'],
  )
  assert.ok(md.includes('（ https://www.luogu.com.cn/problem/P7077 ）'), 'URL 前后各留一个空格')
  assert.ok(md.includes('（蓝题）提高+/省选−'), '难度用中文全角括号')
  assert.ok(md.includes('```cpp'), '参考代码包 cpp 围栏')
  assert.ok(!md.includes('模板'), '不写模板说明')
  assert.ok(!md.includes('状态'), '写「评测结论」不写「状态」')
})

test('buildNoteMarkdown：正文末尾追加推广小节，渠道齐全，且可用 promo=false 关闭', () => {
  const md = buildNoteMarkdown(sampleInput())
  const lines = md.split('\n')
  // 推广小节在最后一个非空行，位于正文最末尾
  assert.equal(
    lines[lines.length - 2],
    '想学更多信奥知识，请关注欣泽编程 公众号、欣泽编程 视频号、欣泽编程-信奥知识大全 知识库、信奥编程算法 小程序。',
  )
  assert.ok(md.trimEnd().endsWith('。'), '推广文案应是正文最后内容')
  for (const channel of ['欣泽编程 公众号', '欣泽编程 视频号', '欣泽编程-信奥知识大全 知识库', '信奥编程算法 小程序']) {
    assert.ok(md.includes(channel), `推广必须包含渠道：${channel}`)
  }
  assert.ok(md.indexOf('## 推荐关注') > md.indexOf('## 关联题目'), '推广小节必须排在其他小节之后')

  const off = buildNoteMarkdown(sampleInput({ promo: false }))
  assert.ok(!off.includes('## 推荐关注'), 'promo=false 时不追加推广')
})

test('validateNoteMarkdown：requirePromo=false 时不做「渠道齐全」校验（供自定义文案使用）', () => {
  const custom = buildNoteMarkdown(sampleInput({ promoText: '想学更多，请关注 欣泽编程 公众号。' }))
  assert.ok(
    validateNoteMarkdown(custom).some(issue => issue.field === '推荐关注'),
    '默认校验下，自定义文案应因渠道不全被拦下',
  )
  assert.deepEqual(
    validateNoteMarkdown(custom, { requirePromo: false }),
    [],
    'requirePromo=false 时应放行自定义文案',
  )
  // 完全不带推广小节时，requirePromo=false 也应放行
  const off = buildNoteMarkdown(sampleInput({ promo: false }))
  assert.deepEqual(validateNoteMarkdown(off, { requirePromo: false }), [])
})

test('validateNoteMarkdown：缺少推广小节必须报出来', () => {
  const md = buildNoteMarkdown(sampleInput())
  const stripped = md.replace(/\n---\n\n## 推荐关注\n[\s\S]*$/, '\n')
  const fields = validateNoteMarkdown(stripped).map(issue => issue.field)
  assert.ok(fields.includes('推荐关注'), '缺推广小节必须被拦下')
})

test('buildNoteMarkdown：首部恰好两条分隔线，且都在要求的位置', () => {
  const md = buildNoteMarkdown(sampleInput())
  const lines = md.split('\n')
  const separatorIndexes = lines.map((line, index) => (line === '---' ? index : -1)).filter(index => index >= 0)
  assert.equal(separatorIndexes.length, 3, '全文共三条 "---"')
  assert.deepEqual(separatorIndexes.slice(0, 2), [2, 8], '前两条在首部（标题下 / 归档时间下）')
  // 第三条必须夹在最后一个正文字节与推广小节之间
  const relatedLine = lines.findIndex(line => line === '## 关联题目')
  const promoLine = lines.findIndex(line => line === '## 推荐关注')
  assert.ok(relatedLine >= 0 && promoLine >= 0, '关联题目与推荐关注小节都必须存在')
  assert.equal(separatorIndexes[2], promoLine - 2, '第三条分隔线紧邻推广小节之前')
  assert.ok(separatorIndexes[2] > relatedLine, '第三条在正文全部小节之后')
})

test('buildNoteMarkdown：归档人与归档时间在最上边，时间精确到秒', () => {
  const md = buildNoteMarkdown(sampleInput())
  assert.ok(
    md.startsWith('# P7077 [CSP-S 2020] 函数调用 - 树形DP+拓扑序\n\n---\n\n归档人：信奥学长插件\n'),
    '归档人必须紧跟标题下的分隔线（普通段落 + 空行，无项目符号）',
  )
  assert.match(md, /\n归档时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n\n---\n/)
  assert.ok(!md.includes('记录时间'), '首部不再有记录时间')
})

test('buildNoteMarkdown：缺字段整节省略（不输出空标题）；标题兜底；代码围栏不重复包裹', () => {
  const partial = buildNoteMarkdown(sampleInput({ related: '', pitfalls: '   ', title: 'P1001 A+B Problem - 模拟' }))
  const headings = partial.match(/^## .+$/gm)
  assert.ok(!headings.includes('## 易错点'))
  assert.ok(!headings.includes('## 关联题目'))
  assert.ok(headings.includes('## 评测结论'))

  const noTitle = buildNoteMarkdown(sampleInput({ title: '', related: undefined }))
  assert.equal(noTitle.split('\n')[0], '# 未命名题解')
  assert.equal(noTitle.split('\n')[4], '归档人：信奥学长插件', '标题兜底后首部字段仍须在')

  const fenced = buildNoteMarkdown(sampleInput({ code: '```cpp\nint main(){}\n```' }))
  assert.equal((fenced.match(/```/g) ?? []).length, 2, '已有围栏的代码不重复包裹')

  const multilineTitle = buildNoteMarkdown(sampleInput({ title: 'P1001 A+B Problem - 模拟\n第二行' }))
  assert.equal(multilineTitle.split('\n')[0], '# P1001 A+B Problem - 模拟 第二行')
})

test('buildNoteMarkdown / formatDateTime：时间渲染精确到秒并补零；缺省取当前时间', () => {
  assert.equal(formatDateTime(new Date(2026, 0, 2, 3, 4, 5)), '2026-01-02 03:04:05')
  assert.equal(buildNoteMarkdown(sampleInput()).split('\n')[6], '归档时间：2026-10-05 09:47:09')
  assert.equal(
    buildNoteMarkdown(sampleInput({ time: '2026-10-05 09:47:09' })).split('\n')[6],
    '归档时间：2026-10-05 09:47:09',
  )
  const nowMd = buildNoteMarkdown(sampleInput({ time: undefined })).split('\n')
  assert.match(nowMd[6], /^归档时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
})

// ---------------------------------------------------------------------------
// validateNoteMarkdown
// ---------------------------------------------------------------------------

test('validateNoteMarkdown：合规正文零问题（含难度里的 U+2212 数学减号）', () => {
  assert.deepEqual(validateNoteMarkdown(buildNoteMarkdown(sampleInput())), [])
})

test('validateNoteMarkdown：逐条抓出违规', () => {
  const good = buildNoteMarkdown(sampleInput())
  const swapTitle = (title) => good.replace(/^# .+$/m, title)
  const swapLine = (index, replacement) => {
    const lines = good.split('\n')
    lines[index] = replacement
    return lines.join('\n')
  }
  const fields = (issues) => issues.map(issue => issue.field)

  const dash = validateNoteMarkdown(swapTitle('# P7077 [CSP-S 2020] 函数调用 - 树形DP—拓扑序'))
  assert.deepEqual(fields(dash), ['标题'])
  assert.match(dash[0].problem, /全角破折号/)
  assert.deepEqual(fields(validateNoteMarkdown(swapTitle('# P7077 2026-10-05 函数调用 - 树形DP'))), ['标题'])
  assert.deepEqual(fields(validateNoteMarkdown(swapTitle('# P7077 函数调用 树形DP'))), ['标题'])

  // 首部版式：2=分隔线 4=归档人（普通段落）6=归档时间（普通段落）8=分隔线
  assert.deepEqual(fields(validateNoteMarkdown(swapLine(2, '==='))), ['分隔线'], '标题下必须是 ---')
  assert.deepEqual(fields(validateNoteMarkdown(swapLine(8, ''))), ['分隔线'], '归档时间下必须是 ---')
  assert.deepEqual(fields(validateNoteMarkdown(swapLine(4, '作者：张三'))), ['归档人'])
  assert.deepEqual(fields(validateNoteMarkdown(swapLine(4, '归档人：'))), ['归档人'])
  assert.deepEqual(fields(validateNoteMarkdown(swapLine(4, '  归档人：信奥学长插件'))), ['归档人'], '缩进写法已弃用（会被加粗且吃掉下一条分隔线）')
  assert.deepEqual(fields(validateNoteMarkdown(swapLine(4, '- 归档人：信奥学长插件'))), ['归档人'], '列表项写法已弃用（会显示圆点）')
  assert.deepEqual(fields(validateNoteMarkdown(swapLine(6, '归档时间：2026-10-05 09:47'))), ['归档时间'])
  assert.deepEqual(fields(validateNoteMarkdown(swapLine(6, '归档时间'))), ['归档时间'])
  assert.deepEqual(fields(validateNoteMarkdown(swapLine(6, '- 归档时间：2026-10-05 09:47:09'))), ['归档时间'], '必须是普通段落（无圆点）')

  assert.deepEqual(fields(validateNoteMarkdown(good.replace('（ https://www.luogu.com.cn/problem/P7077 ）', '（https://www.luogu.com.cn/problem/P7077）'))), ['题目来源'])
  assert.deepEqual(fields(validateNoteMarkdown(good.replace('（蓝题）提高+/省选−', '蓝题 提高+/省选−'))), ['题目难度'])
  assert.deepEqual(fields(validateNoteMarkdown('')), ['markdown'])
  // 完全不成形的输入：首部 4 个位置 + 推广小节全部报错
  assert.deepEqual(fields(validateNoteMarkdown('P7077 函数调用\n')), ['标题', '分隔线', '归档人', '归档时间', '分隔线', '推荐关注'])
  assert.deepEqual(fields(validateNoteMarkdown(good.replace('## 复杂度\n', '## 复杂度\n'))), [])
})

test('validateNoteMarkdown：首部的顺序与分隔线被强制（标题 → --- → 归档人 → 归档时间 → ---）', () => {
  const good = buildNoteMarkdown(sampleInput())
  const swapLine = (index, replacement) => {
    const lines = good.split('\n')
    lines[index] = replacement
    return lines.join('\n')
  }
  const broken = [
    // 归档人位置被归档时间顶替
    swapLine(4, '归档时间：2026-10-05 09:47:09'),
    // 归档时间不是合法时间
    swapLine(6, '归档时间：不是时间'),
    // 少了一条分隔线（该位置被记录时间顶替）
    swapLine(8, '记录时间：2026-10-05 09:47:09'),
  ]
  for (const sample of broken) {
    assert.ok(validateNoteMarkdown(sample).length > 0, '乱序 / 缺分隔线的首部必须被拦下')
  }
  // 合规样本零问题（含难度里的 U+2212 数学减号）
  assert.deepEqual(validateNoteMarkdown(good), [])
})

test('validateNoteMarkdown：正文里的全角连字符「－」被拦下，正常正文的「——」不误伤', () => {
  const good = buildNoteMarkdown(sampleInput())
  const bad = good.replace('拓扑排序：', '拓扑排序－')
  assert.ok(validateNoteMarkdown(bad).some(issue => issue.field === '正文'))

  // U+2014 出现在正文（中文破折号用法）不算违规：禁令只针对标题分隔符
  const prose = buildNoteMarkdown(sampleInput({ gist: '一句话——就这样。' }))
  assert.deepEqual(validateNoteMarkdown(prose), [])
})
