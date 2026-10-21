# oi_tools · 信奥学长提速工具链

随 `oi-senior` 技能提供的通用工具，避免每题重复现写脚本。不写死任何本机绝对路径，跨平台可用。

## build_all.sh — 一键编译三版

```bash
bash oi_tools/build_all.sh [dir] <stem>
```

- `dir`：代码所在目录（可选，默认当前目录）
- `stem`：文件名主干，编译 `<stem>_v1/v2/v3.cpp` 为同名可执行文件
- 编译参数：`g++ -std=c++14 -O2 -Wall -static`，**零警告才算过**
- 编译器探测：优先 PATH 的 `g++`，否则依次尝试常见安装路径；可用 `OI_GXX=/path/to/g++` 指定

## checker_lib.py — 对拍驱动

在你自己的 `check_<题号>.py` 里：

```python
import sys, os
sys.path.insert(0, os.path.join("<技能目录>", "oi_tools"))
from checker_lib import run

def gen(rng):
    ...   # 用 rng 造一组随机输入，返回 str
def oracle(inp):
    ...   # 暴力/正解真值，返回 str

run(400, "P1001_v3.exe", gen, oracle)
```

`run(n, exe, gen, oracle)` 自动完成：喂输入 → 调被测程序 → 2s 超时强杀（TLE）→ 非零退出（RE）→ OI 宽松比对（忽略行尾空白与末尾空行）→ 打印 mismatch。返回 `fails` 数，`0` 即全部一致。

## archive_note.cjs — 通用归档到 ima

```bash
node oi_tools/archive_note.cjs <folder_id> <md_file>
```

- `folder_id`：ima 笔记本「信奥学长-题解复盘」的 folder_id（用 `list_notebook` 查）
- `md_file`：含 Step 4 全部字段的归档 markdown
- 自动定位 `ima_api.cjs`（环境变量 `IMA_API_CJS` → 否则在 skills/plugins 目录下搜），读取 `~/.config/ima` 凭证（显式传 options，避开 200002），调 `import_doc` 写入，成功打印 `note_id`
