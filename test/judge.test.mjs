/**
 * dsh-oi-senior · 评测引擎（src/judge.ts）冒烟测试。
 * 运行：cd dsh-oi-senior && node --test test/
 *
 * 说明：
 * - 本文件不依赖 g++ 也能跑通；真实评测用例在本机检测到 g++ 时才执行，否则按 skip 语义跳过。
 * - 所有断言基于结构化返回值，不解析渲染文本。
 * - 需要临时文件时一律用系统临时目录，并在用例内自行清理。
 *
 * 实现加载策略：优先 dist/judge.js（构建产物，项目约定：package.json build 把 src/*.ts 拷贝为
 * dist/*.js），dist 不存在时回退直接加载 src/judge.ts（内容是合法 ESM JS，Node 24 可直接 import）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let loadedFrom = ''
let judge = undefined
let loadError = undefined
for (const specifier of ['../dist/judge.js', '../src/judge.ts']) {
  try {
    judge = await import(specifier)
    loadedFrom = specifier
    break
  } catch (error) {
    loadError = error
    if (error?.code !== 'ERR_MODULE_NOT_FOUND') throw error
  }
}
if (judge === undefined) throw loadError ?? new Error('无法加载 judge 实现')
const { judgeCpp, normalizeOutput, MAX_VALUE_TEXT } = judge
console.log(`[judge.test] 已加载实现：${loadedFrom}`)

// ---------------------------------------------------------------------------
// 真实 g++ 探测（找不到就 skip，而不是失败）
// ---------------------------------------------------------------------------
function detectCompiler() {
  const candidates = [
    process.env.OI_GXX,
    'g++',
    // 本仓库开发机已知的 MinGW 路径；其他环境走 PATH / OI_GXX 即可。
    'C:\\Users\\83245\\mingw64\\bin\\g++.exe',
  ].filter((item) => typeof item === 'string' && item !== '')
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true })
    const text = `${result.stdout ?? ''}${result.stderr ?? ''}`
    if (!result.error && result.status === 0 && /g\+\+|gcc|clang/i.test(text)) return candidate
  }
  return undefined
}

const GPP = detectCompiler()
const REAL = GPP === undefined ? '本机未检测到 g++（PATH / OI_GXX），跳过真实编译评测用例' : false
if (GPP === undefined) console.log(`[judge.test] ${REAL}`)
else console.log(`[judge.test] 真实编译器：${GPP}`)

const A_PLUS_B = [
  '#include <iostream>',
  'using namespace std;',
  'int main(){ int a=0,b=0; if(!(cin>>a>>b)) return 0; cout << (a+b) << endl; return 0; }',
  '',
].join('\n')

// ---------------------------------------------------------------------------
// normalizeOutput：OI 宽松空白约定
// ---------------------------------------------------------------------------
test('normalizeOutput：CRLF、行尾空白、末尾空行都归一化', () => {
  assert.equal(normalizeOutput('1 2  \n4\t\n\n\n'), '1 2\n4')
  assert.equal(normalizeOutput('a\r\nb\r\n'), 'a\nb')
  assert.equal(normalizeOutput('a\rb\r'), 'a\nb')
  assert.equal(normalizeOutput(''), '')
  assert.equal(normalizeOutput('  \n\t\n'), '')
  assert.equal(normalizeOutput('  1 2  3  \n'), '  1 2  3') // 只去行尾，行首空白保留
  assert.equal(normalizeOutput(null), '')
})

// ---------------------------------------------------------------------------
// 空测试点
// ---------------------------------------------------------------------------
test('judgeCpp：tests 为空时 total=0、ok=false，且不启动编译器', async () => {
  const result = await judgeCpp({
    code: 'int main(){}',
    tests: [],
    compiler: 'definitely-not-a-compiler-xyz',
  })
  assert.equal(result.total, 0)
  assert.equal(result.accepted, 0)
  assert.equal(result.ok, false)
  assert.deepEqual(result.results, [])
  assert.equal(result.failure, 'none')
  assert.equal(result.compile.command, '')
  assert.match(result.source, /无测试点/)
  assert.match(result.message, /没有提供测试数据/)
})

// ---------------------------------------------------------------------------
// 无编译器兜底（不抛异常、不假称跑过）
// ---------------------------------------------------------------------------
test('judgeCpp：编译器不存在时返回 failure=no_compiler，不抛异常', async () => {
  const result = await judgeCpp({
    code: 'int main(){}',
    tests: [
      { input: '1 2', expected: '3' },
      { input: '5 6', expected: '11' },
    ],
    compiler: 'definitely-not-a-compiler-xyz',
  })
  assert.equal(result.ok, false)
  assert.equal(result.failure, 'no_compiler')
  assert.equal(result.total, 2) // total 恒等于 tests.length
  assert.equal(result.accepted, 0)
  assert.deepEqual(result.results, [])
  assert.equal(result.compile.ok, false)
  assert.match(result.message, /编译器/)
  assert.equal(result.workDir, undefined) // 临时目录已清理 / 不回填
})

// ---------------------------------------------------------------------------
// 编译命令拼装（走「找不到编译器」路径即可断言 command，无需真编译）
// ---------------------------------------------------------------------------
test('judgeCpp：默认编译参数为 -std=c++14 -O2 -Wall，且默认不含 bigStack 链接选项', async () => {
  const result = await judgeCpp({
    code: 'int main(){}',
    tests: [{ input: '', expected: '' }],
    compiler: 'definitely-not-a-compiler-xyz',
  })
  assert.match(result.compile.command, /^definitely-not-a-compiler-xyz /)
  assert.ok(result.compile.command.includes('-std=c++14'))
  assert.ok(result.compile.command.includes('-O2'))
  assert.ok(result.compile.command.includes('-Wall'))
  assert.ok(result.compile.command.includes('main.cpp'))
  assert.ok(result.compile.command.includes('-o'))
  assert.ok(!result.compile.command.includes('--stack'))
  assert.ok(/main\.exe|-o .*main$/.test(result.compile.command))
})

test('judgeCpp：bigStack=true 时编译命令附加 -Wl,--stack,16777216', async () => {
  const result = await judgeCpp({
    code: 'int main(){}',
    tests: [{ input: '', expected: '' }],
    compiler: 'definitely-not-a-compiler-xyz',
    bigStack: true,
  })
  assert.ok(result.compile.command.includes('-Wl,--stack,16777216'))
})

test('judgeCpp：std / optimization / extraFlags / compiler 可覆盖，fileIo 如实写进 source', async () => {
  const result = await judgeCpp({
    code: 'int main(){}',
    tests: [{ name: '卡牌', input: '', expected: '' }],
    compiler: 'definitely-not-a-compiler-xyz',
    std: '-std=c++17',
    optimization: '-O0',
    extraFlags: ['-Wall', '-Wextra'],
    fileIo: true,
    bigStack: true,
  })
  const command = result.compile.command
  assert.ok(command.includes('-std=c++17'))
  assert.ok(command.includes('-O0'))
  assert.ok(command.includes('-Wextra'))
  assert.ok(command.includes('-Wl,--stack,16777216'))
  assert.match(result.source, /文件 IO 模式/)
  assert.match(result.source, /卡牌/)
  // fileIo 模式同样不因找不到编译器而抛异常
  assert.equal(result.failure, 'no_compiler')
  assert.equal(result.total, 1)
})

test('judgeCpp：extraFlags=[] 时不带 -Wall', async () => {
  const result = await judgeCpp({
    code: 'int main(){}',
    tests: [{ input: '', expected: '' }],
    compiler: 'definitely-not-a-compiler-xyz',
    extraFlags: [],
  })
  assert.ok(!result.compile.command.includes('-Wall'))
})

// ---------------------------------------------------------------------------
// AbortSignal 贯穿（不依赖 g++）
// ---------------------------------------------------------------------------
test('judgeCpp：已取消的 signal 立即以 AbortError 拒绝', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => judgeCpp({ code: 'int main(){}', tests: [{ input: '', expected: '' }] }, { signal: controller.signal }),
    (error) => {
      assert.ok(error instanceof DOMException)
      assert.equal(error.name, 'AbortError')
      assert.equal(error.failure, 'aborted') // 挂上 FailureKind 里的 'aborted'
      return true
    },
  )
})

// ---------------------------------------------------------------------------
// 保留 workDir
// ---------------------------------------------------------------------------
test('judgeCpp：workDir 非空时保留现场（含 main.cpp）；空则回填 undefined', async (t) => {
  const workDir = await mkdtemp(join(tmpdir(), 'dsh-oi-senior-judge-test-'))
  t.after(() => rm(workDir, { recursive: true, force: true }).catch(() => {}))
  const result = await judgeCpp({
    code: 'int main(){}',
    tests: [{ input: '', expected: '' }],
    compiler: 'definitely-not-a-compiler-xyz',
    workDir,
  })
  assert.equal(result.workDir, workDir)
  await access(join(workDir, 'main.cpp'))
  const source = await readFile(join(workDir, 'main.cpp'), 'utf8')
  assert.equal(source, 'int main(){}')
})

// ---------------------------------------------------------------------------
// 真实编译评测（无 g++ 时 skip）
// ---------------------------------------------------------------------------
test('真实评测：a+b 两测试点 → AC/AC，accepted=2，total=2', { skip: REAL }, async () => {
  const result = await judgeCpp({
    code: A_PLUS_B,
    tests: [
      { name: '样例1', input: '3 4\n', expected: '7\n' },
      { name: '样例2', input: '100 200\n', expected: '300' },
    ],
    compiler: GPP,
  })
  assert.equal(result.failure, 'none')
  assert.equal(result.compile.ok, true)
  assert.equal(result.total, 2)
  assert.equal(result.accepted, 2)
  assert.equal(result.ok, true)
  assert.deepEqual(result.results.map((item) => item.verdict), ['AC', 'AC'])
  assert.equal(result.firstFailIndex, undefined)
  assert.match(result.source, /样例 2 组/)
  assert.equal(result.results[0].index, 1)
  assert.equal(result.results[1].index, 2)
  assert.equal(result.results[0].name, '样例1')
  assert.ok(typeof result.results[0].runtimeMs === 'number' && result.results[0].runtimeMs >= 0)
  assert.ok(result.compile.durationMs >= 0)
  assert.equal(result.workDir, undefined) // 临时目录用后清理、不回填
})

test('真实评测：输出错误 → WA，firstFailIndex=1', { skip: REAL }, async () => {
  const result = await judgeCpp({
    code: A_PLUS_B,
    tests: [{ input: '1 1\n', expected: '3' }],
    compiler: GPP,
  })
  assert.equal(result.results[0].verdict, 'WA')
  assert.equal(result.firstFailIndex, 1)
  assert.equal(result.accepted, 0)
  assert.equal(result.ok, false)
  assert.equal(result.results[0].expected, '3')
  assert.match(result.message, /第 1 个测试点/)
})

test('真实评测：死循环 → TLE（单点时限强制生效）', { skip: REAL }, async () => {
  const result = await judgeCpp({
    code: '#include <cstdio>\nint main(){ volatile long long s=0; while(true){ s+=1; } }',
    tests: [{ input: '', expected: '' }],
    compiler: GPP,
    timeLimitMs: 500,
  })
  assert.equal(result.results[0].verdict, 'TLE')
  assert.equal(result.firstFailIndex, 1)
  assert.ok(result.results[0].runtimeMs >= 400, `runtimeMs=${result.results[0].runtimeMs}`)
  assert.ok(result.results[0].runtimeMs < 10_000)
})

test('真实评测：缺分号 → CE，保留编译器报错原文、results 为空', { skip: REAL }, async () => {
  const result = await judgeCpp({
    code: '#include <iostream>\nint main(){ std::cout << 1 }\n',
    tests: [{ input: '', expected: '1' }],
    compiler: GPP,
  })
  assert.equal(result.ok, false)
  assert.equal(result.failure, 'ce')
  assert.equal(result.total, 1) // 编译失败时 total 仍等于 tests.length
  assert.equal(result.accepted, 0)
  assert.deepEqual(result.results, [])
  assert.equal(result.compile.ok, false)
  assert.match(result.compile.stderr, /error:/)
  assert.ok(result.compile.command.includes('-std=c++14'))
  assert.match(result.message, /CE/)
})

test('真实评测：非零退出 → RE', { skip: REAL }, async () => {
  const result = await judgeCpp({
    code: '#include <cstdlib>\nint main(){ return 3; }',
    tests: [{ input: '', expected: '' }],
    compiler: GPP,
  })
  assert.equal(result.results[0].verdict, 'RE')
  assert.equal(result.firstFailIndex, 1)
  assert.equal(result.ok, false)
})

test('真实评测：fileIo（freopen）模式逐点独立命名、真跑真比对', { skip: REAL }, async (t) => {
  const code = [
    '#include <cstdio>',
    'int main(){',
    '  freopen("aplusb.in","r",stdin);',
    '  freopen("aplusb.out","w",stdout);',
    '  int a=0,b=0; if(scanf("%d %d",&a,&b)!=2) return 0;',
    '  printf("%d\\n", a+b);',
    '  fclose(stdout);',
    '  return 0;',
    '}',
    '',
  ].join('\n')
  const workDir = await mkdtemp(join(tmpdir(), 'dsh-oi-senior-judge-fileio-'))
  t.after(() => rm(workDir, { recursive: true, force: true }).catch(() => {}))
  const result = await judgeCpp({
    code,
    tests: [
      { name: '卡牌1', input: '2 5\n', expected: '7' },
      { name: '卡牌2', input: '10 20\n', expected: '30' },
    ],
    compiler: GPP,
    fileIo: true,
    workDir,
  })
  assert.equal(result.ok, true)
  assert.equal(result.accepted, 2)
  assert.deepEqual(result.results.map((item) => item.verdict), ['AC', 'AC'])
  assert.match(result.source, /文件 IO 模式/)
  // 每个测试点独占 case-<n>/ 子目录：证明「逐点独立命名、互不污染」
  assert.equal(await readFile(join(workDir, 'case-1', 'aplusb.in'), 'utf8'), '2 5\n')
  assert.equal(await readFile(join(workDir, 'case-2', 'aplusb.in'), 'utf8'), '10 20\n')
  assert.equal(await readFile(join(workDir, 'case-1', 'aplusb.out'), 'utf8').then(normalizeOutput), '7')
  assert.equal(await readFile(join(workDir, 'case-2', 'aplusb.out'), 'utf8').then(normalizeOutput), '30')
  // 程序写出的 .out 被读回成 stdout（供 WA 展示）
  assert.equal(normalizeOutput(result.results[0].stdout), '7')
})

test('真实评测（回归）：复用 workDir 时残留 .out 不得冒充本点输出造成假 AC', { skip: REAL }, async (t) => {
  // 真实事故：fileIo 模式早先会在「候选名都没命中」时回退读取目录内任意 .out。
  // 于是复用同一个 workDir 时，上一轮留下的非候选名 .out（如 poison.out）会被读回，
  // 让「程序什么都没写」的一轮被判成 AC —— 静默错判，且模型可通过 workDir 参数触达。
  const workDir = await mkdtemp(join(tmpdir(), 'dsh-oi-senior-judge-stale-'))
  t.after(() => rm(workDir, { recursive: true, force: true }).catch(() => {}))

  // 程序读 aplusb.in，但**什么都不写**（不产生任何 .out）
  const silentCode = [
    '#include <cstdio>',
    'int main(){',
    '  freopen("aplusb.in","r",stdin);',
    '  int a=0,b=0; scanf("%d %d",&a,&b);',
    '  return 0;',
    '}',
    '',
  ].join('\n')

  const result = await judgeCpp({
    code: silentCode,
    tests: [{ name: '样例1', input: '2 5\n', expected: '7' }],
    compiler: GPP,
    fileIo: true,
    workDir,
  })

  // 先手动埋一个残留文件，模拟「上一轮跑过、留下别的名字的 .out」
  const caseDir = join(workDir, 'case-1')
  await mkdir(caseDir, { recursive: true })
  await writeFile(join(caseDir, 'poison.out'), '7\n', 'utf8')

  const second = await judgeCpp({
    code: silentCode,
    tests: [{ name: '样例1', input: '2 5\n', expected: '7' }],
    compiler: GPP,
    fileIo: true,
    workDir,
  })

  assert.equal(result.results[0].verdict, 'WA', '程序没写输出时必须判 WA')
  assert.equal(second.results[0].verdict, 'WA', '残留 poison.out 绝不能冒充本点输出；否则就是把 WA 判成 AC')
  assert.notEqual(normalizeOutput(second.results[0].stdout), '7', '不得读回残留文件的内容')
  assert.match(second.results[0].stderr, /未找到程序写出的候选 \.out/)
})

test('真实评测：超大输出被截断（防刷屏）', { skip: REAL }, async () => {
  const code = [
    '#include <cstdio>',
    'int main(){ for(long long i=0;i<200000;i++) fputs("0123456789\\n", stdout); return 0; }',
    '',
  ].join('\n')
  const result = await judgeCpp({
    code,
    tests: [{ input: '', expected: '' }],
    compiler: GPP,
  })
  assert.equal(result.results[0].verdict, 'WA')
  assert.equal(result.results[0].truncated, true)
  assert.ok(result.results[0].stdout.length <= MAX_VALUE_TEXT + 200)
})

test('真实评测：运行中取消 → 子进程被杀、以 AbortError 拒绝', { skip: REAL }, async () => {
  const controller = new AbortController()
  const started = Date.now()
  const pending = judgeCpp(
    {
      code: '#include <cstdio>\nint main(){ volatile long long s=0; while(true){ s+=1; } }',
      tests: [{ input: '', expected: '' }],
      compiler: GPP,
      timeLimitMs: 60_000,
    },
    { signal: controller.signal },
  )
  setTimeout(() => controller.abort(), 400)
  await assert.rejects(pending, (error) => {
    assert.equal(error.name, 'AbortError')
    assert.equal(error.failure, 'aborted')
    return true
  })
  assert.ok(Date.now() - started < 30_000, '取消后应立即返回')
})
