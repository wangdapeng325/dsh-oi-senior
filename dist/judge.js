/**
 * 信奥学长（dsh-oi-senior）· C++ 评测引擎：真编译 + 逐点真跑 + 宽松空白比对。
 *
 * 说明（构建约定，勿改成 TypeScript）：
 *   本文件虽名为 judge.ts，内容是**合法 ESM JavaScript**（无类型注解、无 import type），
 *   只依赖 Node 内置模块。构建流程仅把 src/*.ts 拷贝成 dist/*.js，不会跑 tsc，
 *   因此这里出现的任何 TS 语法都会在运行时炸掉。类型信息一律用 JSDoc 描述。
 *
 * 评测规程（对应 skills/oi-senior/SKILL.md 第四节）：
 *   4.2 编译 `g++ -std=c++14 -O2 -Wall main.cpp -o main`（Windows 产物 main.exe）；
 *       编译失败 → CE（保留编译器报错原文）；逐点喂 stdin、单点超时强杀 → TLE；
 *       非零退出 → RE（附 stderr）；比对遵循 OI 宽松空白约定（忽略行尾空白与文件末尾空行）。
 *   4.1 source 字段如实描述本次测试点来源，禁止暗示跑了 OJ 私密测试点。
 *   4.3 bigStack 选项可在编译期附 `-Wl,--stack,16777216`（MinGW），默认关闭，由调用方对递归题打开。
 *   4.4 输出采集上限 512KB 防死循环刷屏；临时目录用后清理。
 *   4.5 找不到编译器（spawn ENOENT 等）→ 结构化返回 failure='no_compiler'，绝不抛异常、绝不假称跑过。
 *
 * @typedef {'AC'|'WA'|'TLE'|'RE'|'CE'} Verdict
 * @typedef {'none'|'ce'|'no_compiler'|'aborted'} FailureKind
 * @typedef {{ input: string, expected: string, name?: string }} TestCase
 * @typedef {{ index: number, name: string, verdict: Verdict, runtimeMs: number, stdout: string, stderr: string, expected: string, truncated: boolean }} TestResult
 * @typedef {{
 *   code: string, tests: TestCase[], std?: string, optimization?: string, compiler?: string,
 *   extraFlags?: string[], timeLimitMs?: number, compileTimeoutMs?: number,
 *   fileIo?: boolean, bigStack?: boolean, workDir?: string
 * }} JudgeRequest
 * @typedef {{ ok: boolean, command: string, durationMs: number, stderr: string }} CompileInfo
 * @typedef {{
 *   ok: boolean, accepted: number, total: number, compile: CompileInfo,
 *   firstFailIndex?: number, results: TestResult[], source: string,
 *   failure: FailureKind, message: string, workDir?: string
 * }} JudgeResult
 * @typedef {{ signal?: AbortSignal }} JudgeOptions
 */

import { spawn } from 'node:child_process'
import { access, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// 常量（默认值全部集中在顶部，便于核对冻结接口里的「默认」描述）
// ---------------------------------------------------------------------------

/** 子进程 stdout 采集上限（字节/字符），防死循环刷屏 */
export const MAX_CAPTURED_OUTPUT = 512 * 1024
/** 子进程 stderr 采集上限 */
export const MAX_CAPTURED_ERROR = 256 * 1024
/** 单段展示文本上限（进入 TestResult 前截断） */
export const MAX_VALUE_TEXT = 4000
/** 编译报错保留上限（比展示上限大，尽量保留原文） */
export const MAX_COMPILE_STDERR = 16 * 1024

export const DEFAULT_COMPILER = 'g++'
export const DEFAULT_STD = '-std=c++14'
export const DEFAULT_OPTIMIZATION = '-O2'
export const DEFAULT_EXTRA_FLAGS = ['-Wall']
export const DEFAULT_TIME_LIMIT_MS = 2000
export const DEFAULT_COMPILE_TIMEOUT_MS = 30_000
/** MinGW 递归爆栈链接选项（bigStack=true 时附加） */
export const DEFAULT_STACK_FLAG = '-Wl,--stack,16777216'
/** fileIo 模式下，代码里检测不到文件名时的兜底主干 */
export const DEFAULT_FILEIO_STEM = 'main'
/** 未配置 workDir 时，临时评测目录前缀 */
export const TEMP_DIR_PREFIX = 'dsh-oi-senior-judge-'

// ---------------------------------------------------------------------------
// 进程执行
// ---------------------------------------------------------------------------

/**
 * 运行一个子进程并采集输出。超时强杀；外部取消（AbortSignal）连同子进程一起终止并以
 * AbortError 拒绝。**启动失败不抛异常**，而是以 `error` 字段返回（判题场景下
 * 「找不到编译器」是领域结果，不是异常）。
 *
 * @param {string} command
 * @param {readonly string[]} args
 * @param {{ input?: string, timeoutMs?: number, cwd?: string, env?: NodeJS.ProcessEnv, signal?: AbortSignal }} [options]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string, timedOut: boolean, durationMs: number, error?: string }>}
 */
export function runProcess(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let stdout = ''
    let stderr = ''
    let timedOut = false
    let settled = false
    let aborted = options.signal !== undefined && options.signal.aborted === true
    const startedAt = Date.now()
    let timer
    /** @type {ReturnType<typeof spawn> | undefined} */
    let child

    const abortError = () => new DOMException('oi-senior judge aborted', 'AbortError')

    function killChild() {
      if (child !== undefined && child.exitCode === null && child.signalCode === null) {
        try {
          // Windows 下 kill() 即 TerminateProcess；POSIX 用 SIGKILL 保证真的死。
          child.kill(process.platform === 'win32' ? undefined : 'SIGKILL')
        } catch {
          // 进程已退出，忽略
        }
      }
    }

    function onAbort() {
      aborted = true
      killChild()
    }

    function cleanup() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      if (options.signal !== undefined) options.signal.removeEventListener('abort', onAbort)
    }

    function settle(result) {
      if (settled) return
      settled = true
      cleanup()
      if (aborted) rejectPromise(abortError())
      else resolvePromise(result)
    }

    if (aborted) {
      cleanup()
      rejectPromise(abortError())
      return
    }

    try {
      child = spawn(command, [...args], {
        cwd: options.cwd,
        env: options.env ?? process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      settle({
        code: null,
        stdout: '',
        stderr: '',
        timedOut: false,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      })
      return
    }

    options.signal?.addEventListener('abort', onAbort, { once: true })

    if (typeof options.timeoutMs === 'number' && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true
        killChild()
      }, options.timeoutMs)
    }

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    // 到达上限后继续消费（丢弃）数据，避免管道背压把子进程卡死。
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < MAX_CAPTURED_OUTPUT) {
        stdout += chunk
        if (stdout.length > MAX_CAPTURED_OUTPUT) stdout = stdout.slice(0, MAX_CAPTURED_OUTPUT)
      }
    })
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < MAX_CAPTURED_ERROR) {
        stderr += chunk
        if (stderr.length > MAX_CAPTURED_ERROR) stderr = stderr.slice(0, MAX_CAPTURED_ERROR)
      }
    })
    // 子进程可能不读 stdin 就退出，写端报 EPIPE 属正常，吞掉即可。
    child.stdin?.on('error', () => {})
    child.on('error', (error) => {
      settle({
        code: null,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      })
    })
    child.on('close', (code) => {
      settle({ code, stdout, stderr, timedOut, durationMs: Date.now() - startedAt })
    })

    try {
      child.stdin?.end(options.input ?? '')
    } catch {
      // 子进程已退出时忽略
    }
  })
}

// ---------------------------------------------------------------------------
// 比对与文本工具
// ---------------------------------------------------------------------------

/**
 * 判题输出归一化：CRLF→LF、去掉每行行尾空白、去掉文件末尾空行。
 * 这是 OI/NOI 判题的标准「宽松空白」约定，其余逐字符比较。
 * @param {string} text
 * @returns {string}
 */
export function normalizeOutput(text) {
  const lines = String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''))
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

/**
 * 单点判定：超时优先 TLE；非零退出 RE；否则宽松比对 AC/WA。
 * @param {{ timedOut: boolean, code: number | null, output: string, expected: string }} details
 * @returns {Verdict}
 */
export function verdictFor(details) {
  if (details.timedOut) return 'TLE'
  if (details.code !== 0) return 'RE'
  return normalizeOutput(details.output) === normalizeOutput(details.expected) ? 'AC' : 'WA'
}

/**
 * 截断长文本，保留尾部说明。
 * @param {string} text
 * @param {number} max
 * @returns {string}
 */
export function truncateText(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n…[已截断，共 ${value.length} 字符]`
}

/**
 * 取编译器报的第一条错误（优先含 `error:` 的行，否则第一条非空行）。
 * 教学上「一次只指出第一处错误」比一次倒出全部报错更有效。
 * 注意：这是 additive 工具函数，不属于冻结接口，index.ts 可自行选用。
 * @param {string} stderr
 * @returns {string | undefined}
 */
export function extractFirstError(stderr) {
  const lines = String(stderr ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return lines.find((line) => /error:/i.test(line)) ?? lines[0]
}

// ---------------------------------------------------------------------------
// fileIo（freopen）模式辅助
// ---------------------------------------------------------------------------

/**
 * 把候选字符串规范化成安全的文件名主干；不合法返回 undefined。
 * @param {unknown} raw
 * @returns {string | undefined}
 */
function sanitizeStem(raw) {
  if (typeof raw !== 'string') return undefined
  let stem = raw.trim().replace(/\.(in|out)$/i, '').trim()
  if (stem === '' || stem === '.' || stem === '..') return undefined
  // Windows 非法字符 + 路径分隔符一律拒绝（避免路径穿越）
  if (/[\\/:*?"<>|]/.test(stem)) return undefined
  if (stem.includes('..')) return undefined
  return stem
}

/**
 * 从源码里探测 freopen/fopen/ifstream/ofstream 用到的 .in / .out 文件名主干。
 * 文件 IO 题的文件名由代码硬编码，光靠测试点名字猜不出来，所以优先相信自己读到的。
 * @param {string} code
 * @returns {{ inStem?: string, outStem?: string }}
 */
function detectFileIoStems(code) {
  const text = typeof code === 'string' ? code : ''
  /** @type {string | undefined} */
  let inStem
  /** @type {string | undefined} */
  let outStem
  const take = (file, mode, kind) => {
    const base = String(file).replace(/^.*[\\/]/, '')
    if (kind === 'in' && /\.in$/i.test(base) && /r/i.test(mode)) {
      if (inStem === undefined) inStem = base.replace(/\.in$/i, '')
    }
    if (kind === 'out' && /\.out$/i.test(base) && /[wa]/i.test(mode)) {
      if (outStem === undefined) outStem = base.replace(/\.out$/i, '')
    }
  }
  const pairRe = /(?:freopen|fopen)\s*\(\s*"([^"\n]+)"\s*,\s*"([^"\n]*)"/g
  let match
  while ((match = pairRe.exec(text)) !== null) {
    const file = match[1] ?? ''
    const mode = match[2] ?? ''
    if (/\.in$/i.test(file)) take(file, mode, 'in')
    else if (/\.out$/i.test(file)) take(file, mode, 'out')
  }
  const streamRe = /(ifstream|ofstream|fstream)\s+[A-Za-z_]\w*\s*\(\s*"([^"\n]+)"/g
  while ((match = streamRe.exec(text)) !== null) {
    const kind = match[1] === 'ifstream' ? 'in' : match[1] === 'ofstream' ? 'out' : (/\.in$/i.test(match[2] ?? '') ? 'in' : 'out')
    take(match[2] ?? '', kind === 'in' ? 'r' : 'w', kind)
  }
  return inStem === undefined && outStem === undefined ? {} : { inStem, outStem }
}

/**
 * 为一个测试点规划文件 IO 现场：文件名主干、要写入的 .in 列表、要读回的 .out 候选。
 * 每个测试点独占 `case-<n>/` 子目录，彻底避免点与点之间互相污染。
 * @param {{ input: string, expected: string, name?: string }} testCase
 * @param {number} index0 0-based
 * @param {string} workDirAbs
 * @param {{ inStem?: string, outStem?: string }} detected
 */
function planFileIoCase(testCase, index0, workDirAbs, detected) {
  const named = sanitizeStem(testCase?.name)
  const inputStems = []
  for (const candidate of [named, detected.inStem, detected.outStem, DEFAULT_FILEIO_STEM]) {
    if (candidate !== undefined && !inputStems.includes(candidate)) inputStems.push(candidate)
  }
  const outputNames = []
  for (const candidate of [detected.outStem, detected.inStem, named, DEFAULT_FILEIO_STEM]) {
    if (candidate !== undefined && !outputNames.includes(`${candidate}.out`)) outputNames.push(`${candidate}.out`)
  }
  return { dir: join(workDirAbs, `case-${index0 + 1}`), inputStems, outputNames }
}

/**
 * 如实描述本次评测的测试点来源（4.1 边界要求）。
 * @param {ReadonlyArray<{ name?: string }>} tests
 * @param {boolean} fileIo
 * @param {ReadonlyArray<string>} stems
 * @returns {string}
 */
function describeSource(tests, fileIo, stems) {
  if (tests.length === 0) return '无测试点（tests 为空，未执行任何评测）'
  const names = []
  for (const item of tests) {
    if (item !== null && typeof item === 'object' && typeof item.name === 'string' && item.name.trim() !== '') {
      names.push(item.name.trim())
    }
  }
  const allNamed = names.length === tests.length
  const sampleLike = allNamed && names.every((name) => /样例|sample|例\s*\d/i.test(name))
  const head = sampleLike ? `样例 ${tests.length} 组` : `调用方传入的 ${tests.length} 个测试点`
  const detail = allNamed
    ? `名称：${names.join('、')}`
    : names.length > 0
      ? `部分命名：${names.join('、')}`
      : '测试点未命名'
  const io = fileIo ? `；文件 IO 模式，.in/.out 主干：${[...new Set(stems)].join('、')}` : ''
  return `${head}（${detail}${io}）；仅使用调用方提供的测试数据，未访问任何 OJ 私密测试点`
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

/**
 * 组装编译参数（不含编译器本身）。
 * @param {JudgeRequest} req
 * @param {string} sourcePath
 * @param {string} exePath
 * @returns {string[]}
 */
function buildCompileArgs(req, sourcePath, exePath) {
  const std = req.std === undefined ? DEFAULT_STD : String(req.std).trim()
  const optimization = req.optimization === undefined ? DEFAULT_OPTIMIZATION : String(req.optimization).trim()
  const extraFlags = Array.isArray(req.extraFlags)
    ? req.extraFlags.map((flag) => String(flag).trim()).filter((flag) => flag !== '')
    : [...DEFAULT_EXTRA_FLAGS]
  const args = []
  if (std !== '') args.push(std)
  if (optimization !== '') args.push(optimization)
  args.push(...extraFlags)
  // MinGW/GNU ld 的栈大小链接选项；默认关闭，递归题由调用方打开（SKILL.md 4.3）。
  if (req.bigStack === true) args.push(DEFAULT_STACK_FLAG)
  args.push(sourcePath, '-o', exePath)
  return args
}

/**
 * 运行编译好的程序时，把编译器所在目录补进 PATH，
 * 免得 MinGW 运行时 DLL（libstdc++-6.dll 等）不在 PATH 上导致假 RE。
 * @param {string} compiler
 * @returns {NodeJS.ProcessEnv}
 */
function runtimeEnv(compiler) {
  if (!isAbsolute(compiler)) return process.env
  const dir = dirname(compiler)
  if (dir === '' || dir === '.') return process.env
  const sep = process.platform === 'win32' ? ';' : ':'
  const key = process.platform === 'win32' ? 'Path' : 'PATH'
  return { ...process.env, [key]: `${dir}${sep}${process.env[key] ?? process.env.PATH ?? ''}` }
}

/**
 * 评测一段 C++ 代码（真编译 + 逐点真跑 + 宽松空白比对）。
 *
 * 永不因「环境/代码问题」抛异常：编译失败 → failure='ce'，找不到编译器 → failure='no_compiler'，
 * 都是结构化结果。**只有** options.signal 被取消时以 AbortError（DOMException）拒绝。
 *
 * fileIo 模式说明：不走 stdin 重定向。每个测试点在 `case-<n>/` 子目录内独立执行；
 * 文件名主干优先取该测试点的 `name`，同时写入源码里探测到的 `<stem>.in`；
 * 运行后按「源码探测到的 .out → 测试点 name.out → main.out → 目录内唯一的 .out」顺序读回比对。
 *
 * @param {JudgeRequest} request
 * @param {JudgeOptions} [options]
 * @returns {Promise<JudgeResult>}
 */
export async function judgeCpp(request, options = {}) {
  const req = request !== null && typeof request === 'object' ? request : {}
  const signal = options?.signal
  const tests = Array.isArray(req.tests) ? req.tests : []
  const total = tests.length
  /** 取消时抛出的 AbortError；顺带挂上 FailureKind 里的 'aborted'，便于调用方如实记录。 */
  const abortError = () => {
    const error = new DOMException('oi-senior judge aborted', 'AbortError')
    error.failure = 'aborted'
    error.total = total
    return error
  }
  if (signal !== undefined && signal.aborted === true) throw abortError()

  const code = typeof req.code === 'string' ? req.code : String(req.code ?? '')
  const compiler = typeof req.compiler === 'string' && req.compiler.trim() !== '' ? req.compiler.trim() : DEFAULT_COMPILER
  const fileIo = req.fileIo === true
  const timeLimitMs = typeof req.timeLimitMs === 'number' && req.timeLimitMs > 0 ? req.timeLimitMs : DEFAULT_TIME_LIMIT_MS
  const compileTimeoutMs =
    typeof req.compileTimeoutMs === 'number' && req.compileTimeoutMs > 0 ? req.compileTimeoutMs : DEFAULT_COMPILE_TIMEOUT_MS
  const keepWorkDir = typeof req.workDir === 'string' && req.workDir.trim() !== ''

  if (total === 0) {
    return {
      ok: false,
      accepted: 0,
      total: 0,
      compile: { ok: false, command: '', durationMs: 0, stderr: '' },
      results: [],
      source: describeSource(tests, fileIo, []),
      failure: 'none',
      message: '没有提供测试数据（tests 为空）：请至少给出一组 input/expected。',
    }
  }

  const workDirAbs = keepWorkDir ? resolve(req.workDir) : await mkdtemp(join(tmpdir(), TEMP_DIR_PREFIX))
  const sourcePath = join(workDirAbs, 'main.cpp')
  const exeName = process.platform === 'win32' ? 'main.exe' : 'main'
  const exePath = join(workDirAbs, exeName)
  const compileArgs = buildCompileArgs(req, sourcePath, exePath)
  const command = [compiler, ...compileArgs].join(' ')

  const detected = fileIo ? detectFileIoStems(code) : {}
  const plans = fileIo ? tests.map((item, index) => planFileIoCase(item, index, workDirAbs, detected)) : []
  const stems = plans.flatMap((plan) => plan.inputStems)
  const source = describeSource(tests, fileIo, stems)
  const workDirField = keepWorkDir ? { workDir: req.workDir } : {}

  try {
    await mkdir(workDirAbs, { recursive: true })
    await writeFile(sourcePath, code, 'utf8')

    // ---- 编译 ----
    const compileRun = await runProcess(compiler, compileArgs, {
      timeoutMs: compileTimeoutMs,
      cwd: workDirAbs,
      ...(signal !== undefined ? { signal } : {}),
    })
    const compileStderr = truncateText(compileRun.stderr, MAX_COMPILE_STDERR)
    /** @type {CompileInfo} */
    const compile = {
      ok: false,
      command,
      durationMs: compileRun.durationMs,
      stderr: compileStderr,
    }

    // 4.5 兜底：找不到编译器 → no_compiler，绝不假称跑过。
    if (compileRun.error !== undefined) {
      return {
        ok: false,
        accepted: 0,
        total,
        compile,
        results: [],
        source,
        failure: 'no_compiler',
        message: `未找到可用的 C++ 编译器「${compiler}」（${compileRun.error}）：本环境无法真实评测，未执行任何测试点。`,
        ...workDirField,
      }
    }

    if (compileRun.timedOut || compileRun.code !== 0) {
      return {
        ok: false,
        accepted: 0,
        total,
        compile,
        results: [],
        source,
        failure: 'ce',
        message: compileRun.timedOut
          ? `编译超时（>${compileTimeoutMs}ms），判定 CE；编译器原始报错见 compile.stderr。`
          : `编译失败，判定 CE（编译器退出码 ${compileRun.code ?? 'null'}）；编译器原始报错见 compile.stderr。`,
        ...workDirField,
      }
    }

    // 退出码 0 但没有产物：同样按 CE 处理，不硬跑。
    let exeReady = true
    try {
      await access(exePath)
    } catch {
      exeReady = false
    }
    if (!exeReady) {
      compile.stderr = truncateText(
        `${compileStderr}\n[judge] 编译器退出码 0，但未找到可执行文件 ${exeName}（无法运行测试点）。`.trim(),
        MAX_COMPILE_STDERR,
      )
      return {
        ok: false,
        accepted: 0,
        total,
        compile,
        results: [],
        source,
        failure: 'ce',
        message: `编译未产出可执行文件 ${exeName}，判定 CE。`,
        ...workDirField,
      }
    }
    compile.ok = true

    // ---- 逐点运行 ----
    const env = runtimeEnv(compiler)
    /** @type {TestResult[]} */
    const results = []
    /** @type {number | undefined} */
    let firstFailIndex

    for (let index = 0; index < total; index += 1) {
      const testCase = tests[index] ?? { input: '', expected: '' }
      const input = typeof testCase.input === 'string' ? testCase.input : String(testCase.input ?? '')
      const expectedRaw = typeof testCase.expected === 'string' ? testCase.expected : String(testCase.expected ?? '')
      const name =
        typeof testCase.name === 'string' && testCase.name.trim() !== '' ? testCase.name.trim() : `测试点 ${index + 1}`

      /** @type {string} */
      let outputRaw = ''
      /** @type {string} */
      let consoleStdout = ''
      let runResult
      let extraStderrNote = ''

      if (fileIo) {
        const plan = plans[index]
        await mkdir(plan.dir, { recursive: true })
        // 清掉本点目录里**所有** .out，而不是只清候选名。
        // 否则复用同一个 workDir 时，上一轮留下的非候选名（如 poison.out）会被
        // 下面的兜底读回，让「程序什么都没写」的一轮被判成 AC —— 静默错判。
        for (const stale of (await readdir(plan.dir).catch(() => [])).filter(file => /\.out$/i.test(file))) {
          await rm(join(plan.dir, stale), { force: true }).catch(() => {})
        }
        for (const outputName of plan.outputNames) {
          await rm(join(plan.dir, outputName), { force: true }).catch(() => {})
        }
        for (const stem of plan.inputStems) {
          await writeFile(join(plan.dir, `${stem}.in`), input, 'utf8')
        }
        runResult = await runProcess(exePath, [], {
          timeoutMs: timeLimitMs,
          cwd: plan.dir,
          env,
          ...(signal !== undefined ? { signal } : {}),
        })
        consoleStdout = runResult.stdout
        // 只按源码里探测到的候选名读回。不做「目录内任意 .out」兜底：
        // 那会让残留文件冒充本点输出，把 WA 变成 AC。读不到就按空输出比对（会判 WA）。
        let found
        for (const outputName of plan.outputNames) {
          try {
            found = await readFile(join(plan.dir, outputName), 'utf8')
            break
          } catch {
            // 试下一个候选
          }
        }
        if (found === undefined) {
          found = ''
          // 只列出目录里实际出现的 .out 作为人工线索，**不读内容、不参与比对**。
          // 目的：处理「输出文件名由变量/拼接构造、源码探测不到」的罕见写法时，
          // 让使用者一眼看出程序到底写了什么名字，而不是对着一句「找不到」发呆。
          const seen = (await readdir(plan.dir).catch(() => [])).filter(file => /\.out$/i.test(file)).sort()
          const hint = seen.length > 0 ? `目录内实际出现的 .out：${seen.join('、')}（未参与比对）` : '目录内没有任何 .out 文件'
          extraStderrNote = `[judge] 未找到程序写出的候选 .out 文件（候选：${plan.outputNames.join('、')}）；已按空输出比对。` +
            `${hint}。若程序确实写到了别的文件名，请把该文件名告知评测方（或改用 stdin/stdout，或把文件名写成字面量以便自动探测）。`
        }
        outputRaw = found
      } else {
        runResult = await runProcess(exePath, [], {
          input,
          timeoutMs: timeLimitMs,
          cwd: workDirAbs,
          env,
          ...(signal !== undefined ? { signal } : {}),
        })
        outputRaw = runResult.stdout
      }

      const verdict = verdictFor({
        timedOut: runResult.timedOut,
        code: runResult.code,
        output: outputRaw,
        expected: expectedRaw,
      })

      const stdoutShown = truncateText(outputRaw, MAX_VALUE_TEXT)
      const stderrShown = truncateText(runResult.stderr, MAX_VALUE_TEXT)
      const expectedShown = truncateText(expectedRaw, MAX_VALUE_TEXT)
      const truncated =
        outputRaw.length > stdoutShown.length ||
        runResult.stderr.length > stderrShown.length ||
        expectedRaw.length > expectedShown.length ||
        consoleStdout.length > MAX_VALUE_TEXT
      const stderrParts = [stderrShown]
      if (extraStderrNote !== '') stderrParts.push(extraStderrNote)
      if (fileIo && consoleStdout.length > 0) {
        stderrParts.push(`[judge] 程序写向标准输出（fileIo 模式仅比对 .out 文件）：\n${truncateText(consoleStdout, MAX_VALUE_TEXT)}`)
      }

      results.push({
        index: index + 1,
        name,
        verdict,
        runtimeMs: runResult.durationMs,
        stdout: stdoutShown,
        stderr: stderrParts.filter((part) => part !== '').join('\n'),
        expected: expectedShown,
        truncated,
      })

      if (verdict !== 'AC' && firstFailIndex === undefined) firstFailIndex = index + 1
      if (signal !== undefined && signal.aborted === true) throw abortError()
    }

    const accepted = results.filter((result) => result.verdict === 'AC').length
    const ok = total > 0 && accepted === total
    const firstFailVerdict = firstFailIndex === undefined ? undefined : results[firstFailIndex - 1]?.verdict
    const message = ok
      ? `全部 ${total} 个测试点通过（AC）`
      : `${accepted}/${total} 个测试点通过；第一个未通过的是第 ${firstFailIndex} 个测试点（${firstFailVerdict ?? '未知'}）。`

    return {
      ok,
      accepted,
      total,
      compile,
      ...(firstFailIndex !== undefined ? { firstFailIndex } : {}),
      results,
      source,
      failure: 'none',
      message,
      ...workDirField,
    }
  } catch (error) {
    // 只有「外部取消」才拒绝，且必须是 AbortError（DOMException）。
    // 额外挂上 failure='aborted' 与已知进度，让 FailureKind 里的 'aborted' 有落点，
    // 调用方在取消后仍能如实记录「评测未完成」，而不是假装跑完。
    if (error instanceof DOMException && error.name === 'AbortError') throw abortError()
    throw error
  } finally {
    if (!keepWorkDir) {
      await rm(workDirAbs, { recursive: true, force: true }).catch(() => {})
    }
  }
}

// ---------------------------------------------------------------------------
// 编译器体检（additive 工具，不属于冻结接口；对应 skills/oi-senior/check_gpp.cjs）
// ---------------------------------------------------------------------------

const COMPILER_ADVICE = [
  '安装 g++（需支持 C++14，GCC ≥ 5）：',
  '  Windows : winget install -e --id Mingw-w64（或装 TDM-GCC，把其 bin\\ 目录加入 PATH）',
  '  Linux   : sudo apt-get install -y g++（Fedora/RHEL: sudo dnf install -y gcc-c++）',
  '  macOS   : brew install gcc（装出 g++-<ver>，建软链或调用写全名）',
  '装完后重开终端，运行 g++ --version 确认能看到版本号再继续评测。',
].join('\n')

/**
 * 检测编译器是否可用（找不到/版本偏旧都作为领域结果返回，不抛异常）。
 * @param {string} [command]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ ok: boolean, command: string, version?: string, headline?: string, versionMajor?: number, message?: string, advice?: string }>}
 */
export async function checkCompiler(command = DEFAULT_COMPILER, signal) {
  const result = await runProcess(command, ['--version'], {
    timeoutMs: 10_000,
    ...(signal !== undefined ? { signal } : {}),
  })
  if (result.error !== undefined || result.timedOut || result.code !== 0) {
    return {
      ok: false,
      command,
      message:
        result.error !== undefined
          ? `未检测到编译器「${command}」：${result.error}`
          : result.timedOut
            ? `调用「${command} --version」超时`
            : `「${command} --version」退出码 ${result.code ?? 'null'}`,
      advice: COMPILER_ADVICE,
    }
  }
  const output = `${result.stdout}\n${result.stderr}`.trim()
  const headline = output.split('\n')[0]?.trim() ?? ''
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(output)
  const version = match === null ? undefined : `${match[1]}.${match[2]}.${match[3]}`
  const major = match === null ? undefined : Number.parseInt(match[1] ?? '0', 10)
  if (major !== undefined && major < 5) {
    return {
      ok: false,
      command,
      ...(version !== undefined ? { version } : {}),
      headline,
      versionMajor: major,
      message: `编译器主版本 ${major} < 5，对 C++14 支持可能不完整`,
      advice: COMPILER_ADVICE,
    }
  }
  return {
    ok: true,
    command,
    ...(version !== undefined ? { version } : {}),
    headline,
    ...(major !== undefined ? { versionMajor: major } : {}),
  }
}
