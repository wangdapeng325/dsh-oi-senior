/**
 * 插件接线测试：验证 4 个工具的注册结果与被模型看到的 schema 是否自洽。
 *
 * 这里不启动 DSH 运行时，而是加载已构建的 dist/index.js，用一个最小的
 * ctx.tools.register 收集工具定义 —— 与 scripts/verify-real.mjs 同思路，
 * 但断言的是「schema 契约」这一层，用于防止以下这类静默回归：
 *
 *   - defineTool 的 parameters 是**平铺的 参数名 -> 规格 映射**，不是
 *     JSON Schema 的 { type, properties }。写错时不会报错，但模型看到的
 *     参数名会变成字面量 "type" / "properties"，工具直接不可用。
 *   - 忘记给必需参数加 `required: true`，模型就会省略它，
 *     归档会写出缺字段的残缺笔记、评测会收到空代码。
 *
 * 注意：dist 产物里的 parameters 已经被 defineTool 转成了 JSON Schema，
 * 所以断言必须针对转换后的形态（type='object' + properties + required）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DIST_ENTRY = join(ROOT, 'dist', 'index.js')
const SRC_ENTRY = join(ROOT, 'src', 'index.ts')

/** dist 优先；dist 不存在时回退 src（与其它测试一致）。 */
async function loadPlugin() {
  const entry = existsSync(DIST_ENTRY) ? DIST_ENTRY : SRC_ENTRY
  const mod = await import(pathToFileURL(entry).href)
  const registered = []
  const sections = []
  // 插件 inject 了 ['tools', 'systemPrompt']，这里两个都提供，贴近真实加载环境
  const ctx = {
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
    systemPrompt: { section: (definition) => { sections.push(definition); return () => {} } },
  }
  const config = {
    judge: { compiler: 'g++', std: '-std=c++14', optimization: '-O2', timeLimitMs: 2000, compileTimeoutMs: 30000, workDir: '' },
    ima: { enabled: false, cliPath: '', clientId: '', apiKey: '', timeoutMs: 20000 },
  }
  mod.apply(ctx, config)
  return { entry, registered, sections }
}

const EXPECTED_TOOLS = ['oi_solve', 'oi_judge', 'oi_archive', 'oi_doctor']

test('插件导出契约：name / inject / apply / Config', async () => {
  const mod = await import(pathToFileURL(existsSync(DIST_ENTRY) ? DIST_ENTRY : SRC_ENTRY).href)
  assert.equal(mod.name, 'dsh-oi-senior')
  assert.ok(Array.isArray(mod.inject) && mod.inject.includes('tools'), 'inject 必须声明 tools')
  assert.equal(typeof mod.apply, 'function')
  assert.notEqual(mod.Config, undefined)
})

test('插件版本取自 package.json，且会随 oi_solve / oi_doctor 暴露出来', async () => {
  const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/, 'package.json 版本必须是 x.y.z')

  const mod = await import(pathToFileURL(existsSync(DIST_ENTRY) ? DIST_ENTRY : SRC_ENTRY).href)
  assert.equal(mod.PLUGIN_VERSION, manifest.version, 'PLUGIN_VERSION 必须与 package.json 一致（不得两处硬编码漂移）')

  const { registered } = await loadPlugin()
  const solve = registered.find(tool => tool.name === 'oi_solve')
  const solveValue = await solve.execute({ topic: 'P7077' }, { signal: undefined })
  assert.equal(solveValue.plugin.version, manifest.version)
  assert.ok(
    solve.output.render({}, solveValue)[0].text.includes(`v${manifest.version}`),
    '规程文本应带上插件版本',
  )

  const doctor = registered.find(tool => tool.name === 'oi_doctor')
  const doctorValue = await doctor.execute({}, { signal: undefined })
  assert.equal(doctorValue.pluginVersion, manifest.version)
  assert.equal(doctorValue.archiver, '信奥学长插件')
})

test('注册且只注册了 4 个约定工具', async () => {
  const { registered } = await loadPlugin()
  assert.deepEqual(registered.map(tool => tool.name).sort(), [...EXPECTED_TOOLS].sort())
})

test('每个工具的 parameters 都必须是转换后的 object schema（防止把 {type,properties} 当输入规格）', async () => {
  const { registered } = await loadPlugin()
  for (const tool of registered) {
    assert.equal(tool.parameters?.type, 'object', `${tool.name}.parameters.type`)
    assert.equal(typeof tool.parameters.properties, 'object', `${tool.name}.parameters.properties`)
    const keys = Object.keys(tool.parameters.properties)
    // 平铺规格被误写成 {type,properties} 时，转换结果会出现这两个字面量键
    assert.ok(!keys.includes('type'), `${tool.name} 的参数里混入了字面量 "type" —— parameters 被写成了 JSON Schema`)
    assert.ok(!keys.includes('properties'), `${tool.name} 的参数里混入了字面量 "properties" —— parameters 被写成了 JSON Schema`)
  }
})

test('参数名与 execute 读取的字段一一对应', async () => {
  const { registered } = await loadPlugin()
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  const propsOf = (name) => Object.keys(byName[name].parameters.properties).sort()

  assert.deepEqual(propsOf('oi_solve'), ['code', 'mode', 'problem', 'topic'])
  assert.deepEqual(
    propsOf('oi_judge'),
    ['code', 'fileIo', 'recursion', 'source', 'std', 'tests', 'timeLimitMs', 'workDir'],
  )
  assert.deepEqual(
    propsOf('oi_archive'),
    ['approach', 'code', 'complexity', 'concepts', 'difficulty', 'gist', 'mode',
      'pitfalls', 'promo', 'promoText', 'qrcodes', 'related', 'source', 'title', 'verdictEvidence'],
  )
  assert.deepEqual(propsOf('oi_doctor'), [])
})

test('必需参数都带 required: true（缺了会写出残缺归档 / 空代码评测）', async () => {
  const { registered } = await loadPlugin()
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))
  const requiredOf = (name) => (byName[name].parameters.required ?? []).slice().sort()

  // oi_solve 没有必需参数（只用于取规程；缺省走默认模式）
  assert.deepEqual(requiredOf('oi_solve'), [])

  // 评测没有代码或没有测试点都无法进行
  assert.deepEqual(requiredOf('oi_judge'), ['code', 'tests'])

  // 技能 Step 4 的 10 个正文字段（related 可选、mode 可选）
  assert.deepEqual(requiredOf('oi_archive'), [
    'approach', 'code', 'complexity', 'concepts', 'difficulty',
    'gist', 'pitfalls', 'source', 'title', 'verdictEvidence',
  ])

  assert.deepEqual(requiredOf('oi_doctor'), [])

  // tests 数组内每个元素的 input / expected 也必须是必需的
  const testsSchema = byName['oi_judge'].parameters.properties.tests
  assert.equal(testsSchema.type, 'array')
  assert.equal(testsSchema.items.type, 'object')
  assert.deepEqual((testsSchema.items.required ?? []).slice().sort(), ['expected', 'input'])
})

test('每个工具都有可渲染的 output 与可调用的 execute', async () => {
  const { registered } = await loadPlugin()
  for (const tool of registered) {
    assert.equal(typeof tool.description, 'string')
    assert.ok(tool.description.length >= 20, `${tool.name} description 过短`)
    assert.equal(typeof tool.execute, 'function', `${tool.name}.execute`)
    assert.equal(typeof tool.output?.render, 'function', `${tool.name}.output.render`)
    assert.notEqual(tool.output?.schema, undefined, `${tool.name}.output.schema`)
  }
})

test('oi_solve 返回的规程守住关键约定（称呼 / 归档笔记本 / 测试点来源免责）', async () => {
  const { registered } = await loadPlugin()
  const solve = registered.find(tool => tool.name === 'oi_solve')
  const value = await solve.execute({ topic: 'P7077 函数调用', mode: 'solve' }, { signal: undefined })

  assert.equal(value.persona.self, '学长')
  assert.ok(value.persona.user.includes('学弟'))
  // 核心反模式：绝不能称呼用户为「学长」
  assert.ok(
    value.persona.rules.some(rule => rule.includes('绝不要把用户称为“学长”')),
    '规程必须明确禁止称用户为「学长」',
  )
  // 「只写不读 ima」与「不假装归档」
  assert.equal(value.archive.notebook, '信奥学长-题解复盘')
  assert.ok(value.archive.rules.some(rule => rule.includes('静默')))
  // 评测必须写明测试点来源、不得暗示私密测试点
  assert.ok(value.judgeRules.some(rule => rule.includes('测试点来源')))
  // 三版代码规范必须齐三版
  assert.equal(value.codeStyle.versions.length, 3)

  const rendered = solve.output.render({}, value)
  assert.equal(rendered[0].type, 'text')
  assert.ok(rendered[0].text.includes('学长'))
  assert.ok(rendered[0].text.includes('信奥学长-题解复盘'))
})

test('oi_solve 带上推广规则与「介绍资料」指路（用户不会用时发文章/读本地文档）', async () => {
  const { registered } = await loadPlugin()
  const solve = registered.find(tool => tool.name === 'oi_solve')
  const value = await solve.execute({ topic: 'P7077' }, { signal: undefined })

  // 推广：对话回复末尾要附上，不要每条都提的老规则已改掉
  assert.ok(value.promo.rules.some(rule => rule.includes('对话回复的末尾')), '必须要求附在回复末尾')
  assert.ok(value.promo.rules.some(rule => rule.includes('chatFooter')), '必须指明用 chatFooter 原样附上')
  assert.deepEqual(value.promo.channels, [
    '欣泽编程 公众号', '欣泽编程 视频号', '欣泽编程-信奥知识大全 知识库', '信奥编程算法 小程序',
  ])

  // 可直接粘贴的底部推广块
  const footer = value.promo.chatFooter
  assert.ok(footer.markdown.startsWith('---\n'), '末尾推广块应以分隔线开头')
  assert.ok(footer.markdown.includes('想学更多信奥知识，请关注'), '缺少推广文案')
  assert.ok(footer.markdown.includes('combined.png'), '应指向二维码合成图')
  assert.ok(existsSync(footer.imagePath), `合成图必须存在：${footer.imagePath}`)
  assert.equal(footer.leftToRight.split(' / ').length, 4)

  const rendered = solve.output.render({}, value)[0].text
  assert.ok(rendered.includes('回复末尾请原样附上'), '渲染里要提示附在末尾')
  assert.ok(rendered.includes(footer.markdown), '渲染里要给出可直接粘贴的整段')

  // 介绍资料
  assert.match(value.intro.article.url, /^https:\/\/mp\.weixin\.qq\.com\/s\//)
  assert.ok(value.intro.article.title.includes('信奥学长'))
  assert.ok(
    existsSync(value.intro.guide.path) && value.intro.guide.path.endsWith('USER-GUIDE.md'),
    `本地使用说明必须随包存在：${value.intro.guide.path}`,
  )

  const text = solve.output.render({}, value)[0].text
  assert.ok(text.includes('## 介绍资料'), '渲染里必须有介绍资料段')
  assert.ok(text.includes(value.intro.article.url), '渲染里必须带上文章链接')
  assert.ok(text.includes('USER-GUIDE.md'), '渲染里必须指向本地使用说明')
})

test('参考阅读：4 篇公众号文章登记齐全，且渲染进规程（按场景挑一条）', async () => {
  const { registered } = await loadPlugin()
  const solve = registered.find(tool => tool.name === 'oi_solve')
  const value = await solve.execute({ topic: 'P7077' }, { signal: undefined })

  const articles = value.references.articles
  assert.equal(articles.length, 4, '必须登记 4 篇参考文章')

  // 期望的 4 个链接（顺序固定：学习系统 → 教练上线 → 错题实战 → 学长上线）
  assert.deepEqual(articles.map(a => a.url), [
    'https://mp.weixin.qq.com/s/wCZ45tAxpPhkA7z5YpnvMg',
    'https://mp.weixin.qq.com/s/wCnaFl_hdgbWMS10qbizCg',
    'https://mp.weixin.qq.com/s/gJ7AuyBbYIyUTTzLmF9hqw',
    'https://mp.weixin.qq.com/s/6xZbOt232HGVZfLxKrzpKA',
  ])
  assert.deepEqual(articles.map(a => a.key), ['learning-system', 'coach-launch', 'coach-debug-demo', 'senior-launch'])
  assert.equal(articles[0].title, '学习系统和AI工具')
  for (const article of articles) {
    assert.match(article.url, /^https:\/\/mp\.weixin\.qq\.com\/s\/[A-Za-z0-9_-]+$/, `链接格式不对：${article.url}`)
    assert.ok(article.title.trim() !== '', '标题不能为空')
    assert.ok(article.when.trim() !== '', `${article.key} 缺少适用场景说明`)
  }
  // 最后一篇必须与 intro 文章一致
  assert.equal(articles[3].url, value.intro.article.url)

  // 投放纪律
  const rules = value.references.rules.join('\n')
  assert.ok(rules.includes('只挑一条') || rules.includes('只发最贴切'), '必须要求按场景只发一条')
  assert.ok(rules.includes('同一轮'), '必须限制同一轮最多一次')

  // 渲染进规程
  const text = solve.output.render({}, value)[0].text
  assert.ok(text.includes('## 参考阅读'), '渲染里必须有参考阅读段')
  for (const article of articles) {
    assert.ok(text.includes(article.url), `渲染里缺链接：${article.title}`)
    assert.ok(text.includes(article.when), `渲染里缺适用场景：${article.title}`)
  }
})

test('常驻提示段：即使模型不调用 oi_solve，也能知道「不会用时发文章」', async () => {
  const entry = existsSync(DIST_ENTRY) ? DIST_ENTRY : SRC_ENTRY
  const mod = await import(pathToFileURL(entry).href)

  const sections = []
  const ctx = {
    tools: { register: () => () => {} },
    // 插件通过 ctx.systemPrompt 访问服务（与官方 dsh-tool-bash 同款用法）
    systemPrompt: { section: (definition) => { sections.push(definition); return () => {} } },
  }
  mod.apply(ctx, {
    judge: { compiler: 'g++', std: '-std=c++14', optimization: '-O2', timeLimitMs: 2000, compileTimeoutMs: 30000, workDir: '' },
    ima: { enabled: false, cliPath: '', clientId: '', apiKey: '', timeoutMs: 20000 },
  })

  assert.equal(sections.length, 1, '应注册恰好一个常驻提示段')
  const [section] = sections
  assert.equal(section.name, 'plugin:dsh-oi-senior')
  assert.equal(typeof section.order, 'number')
  assert.ok(section.text.includes('mp.weixin.qq.com/s/'), '常驻段必须带上公众号文章链接（用户不会用时发给他）')
  assert.ok(section.text.includes('不会使用'), '常驻段必须写明触发条件')
  assert.ok(section.text.includes('oi_solve'), '常驻段应指引先调 oi_solve')

  // systemPrompt 服务缺失 / 访问抛错时都不得影响工具注册
  const bare = { tools: { register: () => () => {} } }
  assert.doesNotThrow(() => mod.apply(bare, { judge: {}, ima: {} }), '无 systemPrompt 时必须静默跳过')
  const hostile = {
    tools: { register: () => () => {} },
    get systemPrompt() { throw new Error('service unavailable') },
  }
  assert.doesNotThrow(() => mod.apply(hostile, { judge: {}, ima: {} }), 'systemPrompt 抛错时必须被吞掉')
})

test('oi_archive 在 ima 关闭时必须静默跳过，且对合规输入不报格式问题', async () => {
  const { registered } = await loadPlugin()
  const archive = registered.find(tool => tool.name === 'oi_archive')
  const value = await archive.execute({
    title: 'P7077 [CSP-S 2020] 函数调用 - 树形DP+拓扑序',
    source: '洛谷 P7077 [CSP-S 2020] 函数调用 （ https://www.luogu.com.cn/problem/P7077 ）',
    difficulty: '（蓝题）提高+/省选−',
    gist: '给定函数调用关系，求最终序列。',
    concepts: '拓扑排序与逆序处理。',
    approach: '先建图，再按调用顺序处理。',
    pitfalls: '注意乘法的逆元与取模。',
    code: 'int main(){return 0;}',
    complexity: '时间 O(n+m)，空间 O(n+m)。',
    verdictEvidence: '与暴力对拍 200 组随机数据全部一致，并用公开样例真编译评测 2 组 AC。',
    related: 'P3953 逛公园',
  }, { signal: undefined })

  assert.equal(value.action, 'skipped', 'ima 关闭时必须 skipped，绝不能假装写入')
  assert.equal(value.silent, true, '失败 / 跳过必须静默')
  assert.equal(value.statusLine, '', '静默时不能有归档状态行')
  assert.deepEqual(value.formatIssues, [], `合规归档不应有格式问题：${JSON.stringify(value.formatIssues)}`)
  assert.ok(value.markdownPreview.startsWith('# P7077'), '预览应以 H1 标题开头')
  assert.match(
    value.markdownPreview,
    /^# P7077[^\n]*\n\n---\n\n归档人：信奥学长插件\n\n归档时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\n\n---\n/,
    '首部必须是 标题 → --- → 归档人 → 归档时间 → ---，且两行是无符号普通段落（前后留空行）',
  )
  assert.ok(!/^- 归档人/m.test(value.markdownPreview), '归档人不能是列表项（会显示圆点）')
  assert.ok(!value.markdownPreview.includes('记录时间'), '首部不应再有记录时间')

  const rendered = archive.output.render({}, value)
  assert.ok(rendered[0].text.includes('静默'))
})

/**
 * 递归找出所有「键存在但值为 undefined」的路径。
 * 这类值会让框架的 lossless-JSON 快照校验失败（tool returned invalid output），
 * 而且 JSON.stringify 会静默丢键，所以必须显式扫描。
 */
function undefinedPaths(value, path = '') {
  if (value === undefined) return [path === '' ? '(root)' : path]
  if (value === null || typeof value !== 'object') return []
  if (Array.isArray(value)) return value.flatMap((item, index) => undefinedPaths(item, `${path}[${index}]`))
  return Object.keys(value).flatMap((key) => (
    value[key] === undefined ? [`${path}.${key}`] : undefinedPaths(value[key], `${path}.${key}`)
  ))
}

function assertLossless(value, label) {
  const bad = undefinedPaths(value)
  assert.deepEqual(bad, [], `${label} 返回值含 undefined 键，会被框架判定为非 lossless JSON`)
  const roundTripped = JSON.parse(JSON.stringify(value))
  assert.deepEqual(roundTripped, JSON.parse(JSON.stringify(value)), `${label} JSON 往返不一致`)
}

test('每个工具的返回值都必须是 lossless JSON（无 undefined 键，键不丢）', async () => {
  const { registered } = await loadPlugin()
  const byName = Object.fromEntries(registered.map(tool => [tool.name, tool]))

  // oi_solve：只给题号 / 只给题面 / 什么都不给 / 只给代码 —— 都必须可序列化。
  // 真实事故：`topic: cond ? undefined : topic` 让「只给题号」这一最常见入口
  // 直接报 tool returned invalid output。
  for (const args of [{ topic: 'P7077' }, { problem: '题面' }, {}, { code: 'int main(){}' }]) {
    const value = await byName['oi_solve'].execute(args, { signal: undefined })
    assertLossless(value, `oi_solve(${JSON.stringify(args)})`)
  }

  // oi_judge：编译器缺失路径与编译失败路径的可选字段最容易漏。
  const judgeNoCompiler = await byName['oi_judge'].execute(
    { code: 'int main(){}', tests: [{ input: '', expected: '' }], compiler: 'definitely-not-a-compiler-xyz' },
    { signal: undefined },
  )
  assertLossless(judgeNoCompiler, 'oi_judge(no_compiler)')

  // oi_archive：跳过路径 / 格式不合格路径
  const goodArgs = {
    title: 'P7077 [CSP-S 2020] 函数调用 - 树形DP+拓扑序',
    source: '洛谷 （ https://www.luogu.com.cn/problem/P7077 ）',
    difficulty: '（蓝题）提高+/省选−',
    gist: 'g', concepts: 'c', approach: 'a', pitfalls: 'p',
    code: 'int main(){}', complexity: 'O(1)', verdictEvidence: '样例 AC',
  }
  assertLossless(await byName['oi_archive'].execute(goodArgs, { signal: undefined }), 'oi_archive(skipped)')
  assertLossless(
    await byName['oi_archive'].execute({ ...goodArgs, title: '未命名题解' }, { signal: undefined }),
    'oi_archive(invalid)',
  )

  // oi_doctor：ima 关闭路径（可选字段最多）
  assertLossless(await byName['oi_doctor'].execute({}, { signal: undefined }), 'oi_doctor')
})

test('oi_solve 在只给题号时也必须能正常返回（回归：最常见入口曾整体失败）', async () => {
  const { registered } = await loadPlugin()
  const solve = registered.find(tool => tool.name === 'oi_solve')
  const value = await solve.execute({ topic: 'P7077 [CSP-S 2020] 函数调用' }, { signal: undefined })
  assert.equal(value.topic, 'P7077 [CSP-S 2020] 函数调用')
  assert.equal(Object.hasOwn(value, 'problem'), false, '未给题面时不应存在 problem 键')
  const rendered = solve.output.render({}, value)[0].text
  assert.ok(rendered.includes('P7077'), '只给题号时渲染也必须包含题号')
})

test('oi_archive 对格式不合格的输入必须拒绝写入（不能报告成功）', async () => {
  const { registered } = await loadPlugin()
  const archive = registered.find(tool => tool.name === 'oi_archive')

  // 标题缺少「 - 简短主题」分隔符 —— 这在真实 ima 上曾被照写进去，留下一条脏笔记
  const value = await archive.execute({
    title: '未命名题解',
    source: '洛谷 （ https://www.luogu.com.cn/problem/P1000 ）',
    difficulty: '（红题）入门',
    gist: '大意。',
    concepts: '考点。',
    approach: '思路。',
    pitfalls: '坑。',
    code: 'int main(){}',
    complexity: 'O(1)。',
    verdictEvidence: '样例评测 AC。',
  }, { signal: undefined })

  assert.equal(value.action, 'invalid', '格式不合格必须拒绝写入')
  assert.notEqual(value.action, 'imported', '绝不能报告写入成功')
  assert.equal(value.noteId, undefined, '拦截时不应有 note_id')
  assert.ok(value.formatIssues.length > 0, '必须给出具体格式问题')
  assert.ok(value.formatIssues.some(issue => issue.field === '标题'), '应指出标题问题')

  const rendered = archive.output.render({}, value)[0].text
  assert.ok(rendered.includes('本次没有写入任何内容'), '必须在渲染里明确告知未写入')
  assert.ok(!rendered.includes('[归档：成功'), '拦截时绝不能出现成功状态行')
})
