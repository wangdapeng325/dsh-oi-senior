#!/usr/bin/env bash
# oi-senior 随包工具：一键编译三版代码 <stem>_v1/v2/v3.cpp
# 用法：bash oi_tools/build_all.sh [dir] <stem>
#   dir  可选，代码所在目录（默认当前目录）
#   stem 文件名主干（生成 <stem>_v1 / <stem>_v2 / <stem>_v3，输出同名可执行文件）
# 说明：C++14、-O2、-Wall；零警告才算「过」。自动探测 g++（PATH → 常见安装路径）。

set -u

# ---- 参数解析 ----
if [ $# -eq 2 ]; then
  WORKDIR="$1"; STEM="$2"
elif [ $# -eq 1 ]; then
  WORKDIR="."; STEM="$1"
else
  echo "用法: bash oi_tools/build_all.sh [dir] <stem>"
  exit 64
fi

cd "$WORKDIR" || { echo "[build_all] 目录不存在: $WORKDIR"; exit 66; }

# ---- 探测 g++（不写死本机路径） ----
GXX=""
if command -v g++ >/dev/null 2>&1; then
  GXX="g++"
else
  # 常见安装位置 fallback（按优先级尝试）
  for cand in \
    "/c/msys64/mingw64/bin/g++.exe" \
    "/c/MinGW/bin/g++.exe" \
    "/c/mingw64/bin/g++.exe" \
    "/usr/bin/g++" \
    "/usr/local/bin/g++" \
    "/opt/homebrew/bin/g++" ; do
    if [ -x "$cand" ]; then GXX="$cand"; break; fi
  done
fi

if [ -z "$GXX" ]; then
  echo "[build_all] 未找到 g++，无法编译。"
  echo "  请先安装 C++ 编译器（需支持 C++14），或运行: node check_gpp.cjs 查看指引。"
  echo "  也可用环境变量指定: export OI_GXX=/path/to/g++"
  exit 2
fi
# 允许用 OI_GXX 显式覆盖
if [ -n "${OI_GXX:-}" ] && [ -x "$OI_GXX" ]; then GXX="$OI_GXX"; fi

echo "[build_all] 编译器: $GXX  ($($GXX --version | head -1))"
echo "[build_all] 工作目录: $(pwd)  主干: $STEM"

FAIL=0
for v in 1 2 3; do
  SRC="${STEM}_v${v}.cpp"
  OUT="${STEM}_v${v}"
  if [ ! -f "$SRC" ]; then
    echo "[build_all] 跳过 ${SRC}（不存在）"
    continue
  fi
  echo "[build_all] 编译 $SRC ..."
  if $GXX -std=c++14 -O2 -Wall -static "$SRC" -o "$OUT" 2> "${SRC}.build.log"; then
    if [ -s "${SRC}.build.log" ]; then
      echo "  ⚠ 有警告："
      sed 's/^/    /' "${SRC}.build.log"
      FAIL=1
    else
      echo "  ✓ $OUT 编译通过（零警告）"
    fi
    rm -f "${SRC}.build.log"
  else
    echo "  ✗ $SRC 编译失败："
    sed 's/^/    /' "${SRC}.build.log"
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo "[build_all] 存在编译失败或有警告，请修正后重试。"
  exit 1
fi
echo "[build_all] 三版全部通过（零警告）。"
