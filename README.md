# dsh-oi-senior v1.0.8 —— 信奥学长 DSH 插件

把技能包 **oi-senior（信奥学长）** 落地成 DeepSeek Harness 插件：面向 GESP 1~8 级、CSP-J/S、NOIP、NOI 学习者的**算法竞赛陪练学长**。

学长的定位是「陪你刷、给参考实现」：独立推导、一次给三版 C++14 代码（常规注释 / 详细讲解 / 极简可提交）、附一份解题说明，并用**本机 g++ 真编译真评测**，做题记录归档到 ima 笔记本「**信奥学长-题解复盘**」。

> 与「信奥教练 oi-coach」的分工：oi-coach 是苏格拉底式教练，逼你自己想、默认不给答案；本插件是给你对照实现的学长。两者评测与归档逻辑一致，可并行使用。

> **使用者请先看 [USER-GUIDE.md](USER-GUIDE.md)**（安装、四种用法、评测与归档说明、常见问题）；本文档偏实现与维护。
>
> 对外介绍/推荐给同学家长可发这篇公众号文章：《「信奥学长」刷题好搭档上线 WorkBuddy：题意拆解、考点梳理、解题思路、易错点、三版代码、真评测带归档》 <https://mp.weixin.qq.com/s/6xZbOt232HGVZfLxKrzpKA>
>
> 另有 3 篇配套说明（学习路线 / 教练介绍 / 错题讲解实战），按场景挑一条发，见下文「参考阅读」。

---

## 提供的工具

| 工具 | 作用 | 何时使用 |
| --- | --- | --- |
| `oi_solve` | 接题工作台：返回学长规程（角色称呼、独立推导纪律、三版代码规范、解题说明骨架、改代码模式、归档格式、随包资源路径） | 用户以「学长 / 信奥学长 / oi学长 / oi-senior」开头，或贴出题面 / 题号 / 洛谷链接 / 自己的半成品代码 |
| `oi_judge` | **真编译真评测**：`g++ -std=c++14 -O2 -Wall` 编译后逐点判定 AC / WA / TLE / RE / CE，回填每点耗时、期望与实际输出 | 批改提交、验证参考实现、改代码模式下的真编译 |
| `oi_archive` | 按技能 Step 4 的 10 字段与 6 条格式细则生成归档 markdown，并写入 ima 笔记本「信奥学长-题解复盘」 | 一道题讲完后归档题解复盘 |
| `oi_doctor` | 环境自检：ima 调用器、凭证来源、目标笔记本 folder_id、本机 g++ 是否可用 | 排查「归档为什么没生效 / 能不能真评测」 |

### 为什么要有 `oi_solve`

技能规程（三版代码、10 字段归档格式、评测边界、称呼规则）如果只写在 SKILL.md 里，会随上下文被压缩掉。`oi_solve` 把这些**机器可读地**固化成一次工具调用，保证每一轮回复都守得住规程——尤其是容易漂移的三条：

- 自称「学长」、称用户「学弟 / 学妹」，**绝不把用户叫成「学长」**；
- 三版代码只改注释不改逻辑，且 v3 必须提醒「先自己写自己交」；
- 评测必须写明测试点来源，**不得暗示跑了 OJ 私密测试点**。

---

## 目录结构

```
dsh-oi-senior/
├── src/
│   ├── index.ts        # 插件入口：name/inject/apply/Config + 注册 4 个工具
│   ├── judge.ts        # C++14 评测引擎（纯 Node 内置模块，无框架依赖）
│   ├── ima.ts          # ima 归档引擎（纯 Node 内置模块，无框架依赖）
│   └── qrcodes.ts      # 关注二维码资源清单（公众号/视频号/知识库/小程序）
├── assets/qrcodes/     # 四张二维码原图（jpg，随包分发）
├── dist/               # 构建产物（加载时使用）
├── test/
│   ├── judge.test.mjs  # 评测引擎测试（本机有 g++ 时含真实编译评测用例）
│   ├── ima.test.mjs    # 归档引擎测试（本地假调用器，不依赖外网）
│   ├── qrcodes.test.mjs        # 二维码资源：文件真实存在、签名合法、体积合规
│   └── inline-images.test.mjs  # data URL 内嵌与大请求改走直连 HTTP
├── scripts/
│   ├── build.mjs       # 构建：src/*.ts -> dist/*.js + 语法校验（+ 可选桩自检）
│   ├── verify-real.mjs # 用**真实** @deepseek-ai/* 加载 dist 并调用 apply()
│   ├── e2e-archive.mjs # 真实归档链路验证（会真的往 ima 写一条笔记，默认不要跑）
│   ├── e2e-qrcode-note.mjs    # 真实写入带二维码的笔记（会真的写，用于验证渲染）
│   ├── e2e-list-notes.mjs # 只读盘点笔记本（不写）
│   ├── verify-prompt-section.mjs # 常驻提示段健壮性（有/抛错/缺失三种 ctx）
│   └── install.mjs     # 安装到 DSH profile / 卸载（含 YAML 复验）
├── skills/oi-senior/   # 随包技能原件（SKILL.md、templates/、oi_tools/）
├── cordis.patch.yml    # bundle 配置层（配合 `dsh plugin add` 使用）
└── package.json        # bundle manifest（声明 dsh.bundle）
```

> 说明：`src/*.ts` 的文件内容是**合法 ESM JavaScript**（无类型注解）。扩展名沿用 `.ts` 是为了与技能包命名习惯对齐；构建即「拷贝 + 改名」。

---

## 安装

### 快速安装（推荐）

```sh
cd dsh-oi-senior
node scripts/build.mjs          # 构建 dist/
node scripts/install.mjs        # 安装到 desktop profile
```

`install.mjs` 做三件事：

1. 在包内 `node_modules/@deepseek-ai` 下为 `dsh-tools`、`schemastery` 建立指向 DSH profile 自身副本的目录链接 —— 这是插件唯一的外部运行期依赖，指向同一份副本可保证版本天然对齐；
2. 在 `~/.dsh/profiles/<profile>/cordis.patch.yml` 追加一条 `oi-senior` 条目，入口用**绝对 `file:///` URL**，因此插件不必拷贝进 DSH 仓库、也不必成为 pnpm workspace 成员；
3. 落盘后用 profile 自带的 `js-yaml` **复验**：仍是合法顶层数组、`oi-senior` 恰好出现一次、入口文件可达。复验不过就报错，不会给 DSH 留下坏配置层。

> **为什么必须包在 `- insert:` 里**：profile 的 patch 层中，**平铺的 `- id: xxx` 是「覆盖既有节点」**，而「新增一个插件节点」必须写在 `- insert:` 列表下（DSH 各 bundle 的 `cordis.patch.yml` 都是这个形态）。把新插件写成平铺条目不会报错，但会被当成对不存在节点的覆盖而静默失效 —— 这是本项目踩过并已用复验堵住的坑。

常用参数：

```sh
node scripts/install.mjs --preview            # 只打印改动，不落盘
node scripts/install.mjs --profile web        # 指定 profile（默认 desktop）
node scripts/install.mjs --uninstall          # 移除条目
```

**装完需要重启 DSH**（或该条目被 HMR 热加载）后 4 个工具才会出现。

### 作为 bundle 安装（分发路径）

```sh
# 在 dsh 仓库根目录执行
pnpm dsh plugin --profile <name> add ./dsh-oi-senior
pnpm dsh --profile <name>
```

### 配置

在 `cordis.patch.yml`（或 bundle 配置层）的 `config` 中调整：

```yaml
config:
  judge:
    compiler: g++            # 编译器命令
    std: '-std=c++14'        # 语言标准（技能规定 C++14）
    optimization: '-O2'
    timeLimitMs: 2000        # 单点时限（毫秒）
    compileTimeoutMs: 30000
    workDir: ''              # 空 = 系统临时目录（评测后自动清理）
  ima:
    enabled: true            # 关掉则 oi_archive 静默跳过
    cliPath: ''              # ima_api.cjs 路径；空 = 自动定位
    clientId: ''             # 空 = 用环境变量 / ~/.config/ima/
    apiKey: ''
    timeoutMs: 20000
```

---

## ima 归档的前置条件

`oi_archive` 走的是技能自带的 **`ima_api.cjs` 调用器**形态（与 `oi_tools/archive_note.cjs` 一致）。要真正写入，需要：

1. 已安装腾讯 ima 桌面端并登录；
2. 已安装 **ima-skill**（内含 `ima_api.cjs`）；插件按
   `配置 cliPath → 环境变量 IMA_API_CJS → ~/.workbuddy/skills、~/.dsh/skills、~/.claude/skills、~/.codex/skills、~/.cursor/skills、~/.workbuddy/plugins` 的顺序定位；
3. 已在 <https://ima.qq.com/agent-interface> 生成自己的 Client ID / API Key，写入 `~/.config/ima/{client_id,api_key}`；
4. 已在 ima 客户端**手动创建**笔记本「**信奥学长-题解复盘**」（API 无法自动建笔记本）。

任一条件缺失 → 本轮归档**静默跳过**，绝不假装存过、绝不把笔记落到根目录。先用 `oi_doctor` 自检最省事。

### 归档格式要点（技能 Step 4 + 本项目扩展）

- H1 **不含日期时间**，洛谷题格式：`# P7077 [CSP-S 2020] 函数调用 - 树形DP+拓扑序`（题号在最前，题名与主题之间用英文半角 ` - `）；
- 正文**最上边的固定版式**（由插件自动写入，模型不需要也不应该自己拼）：
  ```
  # P7077 [CSP-S 2020] 函数调用 - 树形DP+拓扑序

  ---

  归档人：信奥学长插件

  归档时间：2026-10-05 09:47:09

  ---
  ```
  「归档人」是固定署名（`ARCHIVER` 常量，见 `src/ima.ts`）；两条 `---` 分隔线分别夹在「标题与归档人之间」和「归档时间与正文之间」；归档时间精确到秒；
- **两行用「普通段落 + 前后空行」**（无项目符号、不加粗），结构与「信奥教练」的笔记一致。实测过的四种写法：

  | 写法 | 是否加粗 | 项目符号 | 归档时间下方的 `---` |
  | --- | --- | --- | --- |
  | 普通段落，`---` 后**不留空行** | ❌ 加粗 | 无 | 正常 |
  | 缩进两格 `  归档人：…` | ❌ 加粗 | 无 | **被吃掉，不显示** |
  | 列表项 `- 归档人：…` | ✅ 不加粗 | ❌ 有一个小圆点 | 正常 |
  | **普通段落 + 前后各留一个空行（当前采用）** | ✅ 不加粗 | ✅ 无 | 正常 |

  关键在**空行**：空行把两行各自切成独立段落，ima 就不会把「分隔线 `---` 之后的第一段」当标签行加粗。
- **首部没有「记录时间」**：已按要求去掉，`记录时间` 不再出现；
- URL 前后各留一个空格（否则 ima 里点链接会 404）；
- 难度写「（蓝题）提高+/省选−」，中文全角括号，且难度值要**从洛谷题目页「难度[xxx]」字段抓取**，禁止凭记忆估；
- 章节顺序固定：题目来源 → 题目难度 → 题目大意 → 考点梳理 → 解题思路 → 易错点 → 参考代码 → 复杂度 → **评测结论**（不叫「状态」）→ 关联题目；
- **正文末尾自动追加推广小节**（`## 推荐关注`），内容为「想学更多信奥知识，请关注 欣泽编程 公众号、欣泽编程 视频号、欣泽编程-信奥知识大全 知识库、信奥编程算法 小程序。」：渠道清单是 `src/ima.ts` 里的 `PROMO_CHANNELS` 常量，改一处即可；`oi_archive` 传 `promo: false` 可关闭、传 `promoText` 可覆盖文案；
- 成功时回复末尾附 `[归档：成功 note_id=...]`；失败 / 无凭证 / 笔记本不存在时**静默**，不打印任何归档标签。

### 关注二维码（笔记里也能扫码）

四张二维码随包放在 `assets/qrcodes/`（公众号 / 视频号 / ima 知识库 / 小程序），清单见 `src/qrcodes.ts`。

- **归档笔记**：推广小节（`## 推荐关注` + 一句话渠道文案）之后，**直接跟一张二维码合成图**，
  没有小节标题、没有图注（与「信奥教练」笔记本的版式一致）。
  合成图里四张二维码各 120×120、间隔 60，整张 **660×120**（`assets/qrcodes/combined.png`），
  笔记里以 `<img width="660" height="120">` 显示。

  > 为什么不放四张独立图：四张原图宽高比不同，即使写死 `width`/`height`，渲染端仍按原比例缩放，
  > 结果高度参差不齐、看起来偏大（实测过）。合成图正解。
  > 附带好处：笔记体积从 ~585KB 降到 ~107KB。

  **视频号 / 知识库两张必须裁剪**：这两个原图带顶部标题、底部说明和 App logo，
  整体缩进 120 的格子后二维码本体只剩 ~80px，手机扫不出。裁剪时要注意：

  - **裁剪框必须是正方形**，否则四张渲染出来尺寸不一致（脚本会校验，非正方形直接报错）；
  - **别裁掉二维码图案本身**：视频号的放射状装饰点与三个定位角、知识库的绿色底与右下角 `ima` 字样，
    都属于二维码图案，切边就扫不出；
  - 只裁掉纯装饰文字（顶部标题、底部「扫一扫二维码…」「扫码订阅ima知识库」）。

  裁剪框是人工用网格量出来的（`scripts/qr-grid.py` 叠坐标 + `scripts/qr-crop-preview.py` 并排预览比较），
  不用自动检测——自动检测会被中间那个彩色 logo 吸走，把二维码边缘切掉。
  改了四张原图后要重跑 `python scripts/make-qr-composite.py`；
  布局常量在 `src/qrcodes.ts`：`QR_CELL = 120`、`QR_GAP = 60`、`COMBINED_WIDTH = 660`、`COMBINED_HEIGHT = 120`。
  `oi_archive` 传 `qrcodes: false` 可关闭二维码。
- **对话回复**：`oi_solve` 返回的「关注二维码」小节给出四张图的绝对路径，模型用 `![](绝对路径)` 直接渲染成图片。

**为什么不走 ima 的图片上传接口**：`openapi/mcp_cloud_agent/upload_temp_file` 在当前凭证下返回
`100001 session ID is required`（连 ima-skill 自带的 `note-images.cjs --url` 也一样失败），拿不到 `download_url`。
因此改为**把图片以 data URL 内嵌进笔记正文**（已实测 ima 能正常渲染）。

**由此带来的两个实现约束**：

1. 带 data URL 的正文会把请求体撑到 ~586KB，塞进命令行参数会 `spawn ENAMETOOLONG`，
   所以 `callImaAuto` 在请求体超过 16KB 时**自动改走直连 HTTP**（协议与 `ima_api.cjs` 等价）。
2. 每条笔记会因此变大（四张二维码约 +438KB → base64 约 +584KB）。内嵌总量有上限
   `MAX_INLINE_IMAGE_BYTES = 4 MiB`，超限的图片会被跳过并保留原引用（不阻断归档）。

### 推广推荐的插入时机

**对话回复末尾也带推广 + 二维码图**：`oi_solve` 返回 `promo.chatFooter.markdown`（分隔线 + 一句话渠道文案 + 同一张二维码合成图），
模型把它原样附在回复最后。插件级**常驻提示段**（`systemPrompt.section`，名字 `plugin:dsh-oi-senior`，order 106）
里也内联了这整段，所以即使模型没调用 `oi_solve` 也知道要附。

- 同一轮对话只出现一次，不要改写渠道名、不要自己另拼图片路径；
- 例外：用户正在排错调 bug、或只问一个极小的问题时可以省略；其余实质回答（讲题、讲解、评测、复盘）都附在末尾；
- 对话里的图片用 `![...](<正斜杠绝对路径>)`，DSH 直接读本地文件渲染；笔记里则内嵌为 data URL。

`oi_solve` 还会返回**四张单图**的路径（`qrcodes.items`），用户想看单个渠道时模型可以逐张贴。

### 参考阅读（4 篇公众号文章）

常量 `REFERENCE_ARTICLES`（`src/index.ts`）里登记了 4 篇说明文章，每篇带 `title / url / when`：

| key | 文章 | 适用场景 |
| --- | --- | --- |
| `learning-system` | 学习系统和AI工具 | 问学习路线、AI 工具怎么用 |
| `coach-launch` | 「信奥教练」上线 WorkBuddy | 想了解教练能做什么 |
| `coach-debug-demo` | 信奥教练错题讲解实战 | 问错题怎么讲、家长怎么陪 |
| `senior-launch` | 「信奥学长」刷题好搭档 | 了解/推荐本插件（即 `INTRO_ARTICLE`） |

投放纪律（`REFERENCE_RULES`）：**按场景只挑一条**发，说清是公众号文章；同一轮最多发一次链接；正在排错时不插。用户问「还有别的资料吗」再给其余的。

同时暴露在 `oi_solve` 的 `references.articles` 与常驻提示段里，本地文档见 [USER-GUIDE.md](USER-GUIDE.md) §八。

---

## 评测规程要点

- 默认只用题目**公开样例**；OJ 不公开完整测试点，本地通常只有样例。要全量验证就用随包的 `skills/oi-senior/oi_tools/checker_lib.py` 自造对拍数据。每轮评测必须在回复里写明测试点来源。
- 输出比对遵循 **OI 宽松空白约定**：忽略每行行尾空白、忽略文件末尾空行，其余逐字符比较。
- 递归深题用 `recursion: true`（加 `-Wl,--stack,16777216`）避免假 RE。
- 文件 IO 题（`freopen xxx.in / xxx.out`）用 `fileIo: true`，评测不走 stdin 重定向。
- special judge / 浮点多解不能逐字符比时必须先声明，改用容差比对，否则会误判 WA。
- 找不到编译器 → 如实告知「本环境无 C++ 编译器，无法真实评测」，退回静态审阅，**绝不谎称跑了**。

---

## 开发

```sh
node scripts/build.mjs --check     # 构建 + 语法校验
node scripts/build.mjs --selftest  # 额外跑桩接线自检（沙箱，不碰本包 node_modules）
node scripts/verify-real.mjs       # 用真实 @deepseek-ai/* 加载 dist 并调用 apply()（推荐）
node scripts/verify-prompt-section.mjs  # 常驻提示段：有服务 / 抛错 / 缺失三种 ctx 都必须不影响工具注册
node scripts/e2e-list-notes.mjs    # 只读盘点 ima 笔记本（不写任何东西）
node --test "test/*.test.mjs"      # 单元测试
```

`verify-real.mjs` 是本插件的关键验证手段：它用 DSH profile 里**真实的** `@deepseek-ai/dsh-tools` 与 `schemastery` 加载 `dist/index.js`、跑真实 `Config` 解析与 `defineTool` 参数校验，因此能证明「插件在真实框架下可用」，而不只是「语法没错」。

---

## 安全提示

`oi_judge` 会在 DSH 进程所在机器上**真实编译并运行**提交的代码（等同 `bash` 工具执行命令）。只评测可信来源的提交；生产环境建议把评测放进隔离沙箱或容器。

---

## 验证状态（交付时 · v1.0.8）

| 项目 | 结果 |
| --- | --- |
| 单元测试 | **87/87 通过**（评测引擎 18 + 归档引擎 35 + 工具接线 15 + 二维码资源 9 + 内嵌图片与传输 10），`node --test "test/*.test.mjs"` |
| 真实框架加载 | `node scripts/verify-real.mjs` 全通过：真实 `Config` 解析、4 工具注册、参数硬校验、lossless JSON |
| 真实编译器评测 | g++ 16.2.0 真编译真跑：AC / WA / TLE / RE / CE、fileIo、超大输出截断、运行中取消全部实测通过 |
| 真实 ima 归档 | `openapi/note/v1/import_doc` 返回 `code=0` 并取得真实 `note_id`（端到端写入成功） |
| 真实 ima 只读 | `list_notebook` / `list_note` 均 `code=0`；`limit` 边界实测 `20→ok`、`21/50→code=51` |
| 独立验收 | 两轮外部验收（task-3 七节 + 缺陷复核五项）全部通过，报告见 `review/REPORT-task3.md`、`review/RECHECK-round2.md` |

### 生效前提：需要重启 DSH

profile 配置已写入，插件**已能被 DSH 加载并调用**（实测 harness 派发成功）。但 DSH 是在启动时装配 cordis 配置树的，**本轮修复需要重启 DSH（或触发该条目 HMR 重载）后才会生效**。

重启后建议按这个顺序自检：

```
oi_doctor()                      # 应显示 ima 已连通、笔记本就绪、g++ 可用
oi_solve(topic="P7077")          # 只给题号也应正常返回规程
oi_judge(code=..., tests=[...])  # 真编译真评测
```

### 已知的验收残留

- `~/.dsh/profiles/desktop/cordis.patch.yml.bak-oi-senior` 是安装前的备份，确认新配置可用后可删除。
- 本次为验证真实写入，在 ima 中留下 2 条笔记（见下方「本次交付期间写入 ima 的两条笔记」）。
- 「重启后 `oi_archive` 对非法格式是否确实拦截」属**未验证**：验证它需要拿非法格式触发一次真实归档，而若拦截尚未加载就会真的写库，因此在重启前刻意没做。

## 已知限制

- 评测为单进程顺序执行、简单超时终止；**内存限制未强制**（可在题目描述中约定）。
- 没有特殊评测（special judge）能力；浮点多解需人工容差判断。
- 归档依赖外部 `ima_api.cjs`；未安装 ima-skill 时只能生成 markdown 供人工保存。
- 随包技能资源（`skills/oi-senior/`）与插件**同号为 1.0.8**：技能原件的 frontmatter `version` 与归档首部说明已随本次改版一起更新，因此它**不再是**上游 1.0.2 的逐字节副本 —— 相对上游的差异只有「归档正文首部版式」这一处。插件版本见 `package.json`，也会随 `oi_solve`（`plugin.version`）与 `oi_doctor`（`pluginVersion`）暴露出来，便于确认运行实例加载的是哪一版。
- **插件按技能纪律不实现删除接口**（只写不读、且只有 list/import/append）。误写的笔记只能到 ima 客户端手动删除。
- **归档正文首部相对上游技能新增（有意为之）**：本项目按使用要求，在标题与正文之间插入了 `---` + `归档人：…` + `归档时间：…` + `---` 的首部（两行为普通段落、前后留空行，无项目符号、不加粗），并去掉了上游的 `记录时间`。随包 `skills/oi-senior/SKILL.md` 的 frontmatter 已更新为 1.0.8，Step 4/5.3 的首部描述也已同步改写成本项目口径。首部版式以本插件工具的格式校验为准——`oi_archive` 会强制两条分隔线的位置与「无符号普通段落」写法。
- `skills/oi-senior/oi_tools/archive_note.cjs` 里写的接口路径是 `/openapi/wiki/import_doc`，与 ima 官方 notes 模块的 `openapi/note/v1/import_doc` 不一致（本插件用后者，已在真实账号验证 `code=0`）。该脚本疑为技能包自身的 bug，已如实记录、未照抄。
- **fileIo 模式只认「源码里出现的 `.out` 字面量」与测试点名**。若程序用变量 / 字符串拼接构造输出文件名，探测不到 → 判 **WA**（fail-loud；stderr 会列出目录里实际出现的 `.out` 文件名供人工判断，但**不读其内容、不参与比对**）。
- 进一步边界：若程序**写了多个 `.out`**，候选顺序是「源码中**靠前**出现的 `.out` → 源码 `.in` 名 → 测试点 `name` → `main`」，因此源码里靠前的辅助 `.out` 可能被先读走而误判 WA（低概率；方向仍是**可见的假 WA**，不是假 AC）。正常 OI 写法（一题只写一个 `.out`）不受影响。

## 本次交付期间写入 ima 的两条笔记（需人工清理）

为验证真实写入链路，本次在「信奥学长-题解复盘」中产生了 2 条记录。插件按技能纪律**不实现删除接口**，请到 ima 客户端按需处理：

| note_id | 标题 | 说明 |
| --- | --- | --- |
| `7515384269769076` | 未命名题解 | **建议删除**。独立验收过程中误写入的垃圾笔记（正文只有一行记录时间），根因是当时「格式校验不拦截写入」的缺陷；该缺陷已修复并加了回归测试。 |
| `7515384139774210` | 信奥学长插件自检 - 题解复盘归档链路验证 - ima归档与评测联动 | 建议保留或删除均可。这是经用户授权做的一次有意归档，用来证明 `import_doc` 端到端可用（返回 `code=0` 并拿到真实 `note_id`）。 |

该笔记本原有的 6 条记录未受影响。验收期间另有一条自检笔记已由**用户本人在 ima 客户端删除**（插件无删除能力）。
