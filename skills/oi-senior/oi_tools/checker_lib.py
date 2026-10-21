#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
oi-senior 随包工具：对拍驱动库（checker_lib）。

每题只需写一个 check_<题号>.py，定义两个函数：
    gen(rng)      -> 生成一组随机输入（返回 str）
    oracle(inp)   -> 用暴力/正解算出该输入的正确答案（返回 str）
然后调用：
    run(400, "P1001_v3.exe", gen, oracle)

run() 自动完成：喂输入 → 调用被测程序 → 超时强杀 → 宽松比对 → 打印 mismatch。
无需每题重写进程调用、比对、超时逻辑。跨平台（Windows 自动补 .exe）。
"""

import os
import sys
import random
import subprocess
import tempfile

# 单次运行超时（秒）
TIMEOUT_S = 2.0
# 输出捕获上限（字节），防死循环刷屏
MAX_OUT = 512 * 1024


def _norm(text):
    """OI 空白宽松约定：忽略每行行尾空白、忽略文件末尾空行。"""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    lines = [ln.rstrip() for ln in lines]
    while lines and lines[-1] == "":
        lines.pop()
    return "\n".join(lines)


def _resolve_exe(exe):
    """Windows 下自动补 .exe。"""
    if os.name == "nt" and not exe.lower().endswith(".exe"):
        cand = exe + ".exe"
        if os.path.exists(cand):
            return cand
    return exe


def run_case(exe, inp, timeout=TIMEOUT_S):
    """跑一组输入，返回 (status, out)；status ∈ {OK, TLE, RE}。"""
    exe = _resolve_exe(exe)
    try:
        p = subprocess.run(
            [exe],
            input=inp.encode("utf-8", "replace"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return "TLE", ""
    if p.returncode != 0:
        err = p.stderr.decode("utf-8", "replace")[:2000]
        return "RE", err
    out = p.stdout[:MAX_OUT].decode("utf-8", "replace")
    return "OK", out


def run(n=400, exe=None, gen=None, oracle=None, timeout=TIMEOUT_S, show=1):
    """
    对拍主入口。
      n       用例数（默认 400）
      exe     被测可执行文件（如 "P1001_v3" / "P1001_v3.exe"）
      gen     gen(rng) -> str
      oracle  oracle(inp) -> str
      timeout 单点超时（秒）
      show    最多打印几组 mismatch 的输入（默认 1）
    返回 fails 数量（0 表示全部一致）。
    """
    if exe is None or gen is None or oracle is None:
        print("[checker] 用法: run(n, exe, gen, oracle)")
        sys.exit(64)

    rng = random.Random()
    fails = 0
    shown = 0
    for i in range(1, n + 1):
        inp = gen(rng)
        exp = _norm(oracle(inp))
        status, out = run_case(exe, inp, timeout=timeout)

        if status == "TLE":
            print(f"[checker]  #{i} TLE（>{timeout}s）")
            fails += 1
        elif status == "RE":
            print(f"[checker]  #{i} RE")
            print("  stderr:", out.strip()[:500])
            fails += 1
        else:
            got = _norm(out)
            if got != exp:
                fails += 1
                if shown < show:
                    shown += 1
                    print(f"[checker]  #{i} WA")
                    print("  ---- 输入 ----")
                    print("  " + inp.replace("\n", "\n  "))
                    print("  ---- 期望 ----")
                    print("  " + exp.replace("\n", "\n  "))
                    print("  ---- 实际 ----")
                    print("  " + got.replace("\n", "\n  "))
        if i % 50 == 0:
            print(f"[checker]  ...已跑 {i}/{n}，累计 fails={fails}")

    if fails == 0:
        print(f"[checker] 全部通过：{n}/{n} 组一致，fails=0")
    else:
        print(f"[checker] 结束：{n} 组中 {fails} 组不一致。")
    return fails


if __name__ == "__main__":
    print("这是对拍库，不是可执行脚本。请在你自己的 check_<题号>.py 里：")
    print("  from checker_lib import run")
    print("  run(400, 'P1001_v3.exe', gen, oracle)")
