"""把四张二维码裁到「二维码本体」后拼成一张 660×120 的合成图。

布局：每张裁出的区域等比缩放到 120×120 的格子，间隔 60
      → 4*120 + 3*60 = 660 宽，120 高。

三条设计约束：
1. **裁剪框必须是正方形**，这样四张渲染出来都是 120×120，视觉上一致。
   脚本会校验，不是正方形直接报错。
2. **不裁掉二维码本体**：微信视频号的二维码带放射状装饰点、ima 知识库的带绿色底，
   这些属于二维码图案本身，切边就扫不出来。
3. **裁掉纯装饰文字**：顶部标题、底部「扫一扫二维码…」「扫码订阅ima知识库」与 App logo，
   否则整体缩小后二维码本体只剩 ~80px，手机扫不出。

裁剪框是**人工用网格量**出来的（scripts/qr-grid.py 叠坐标 + scripts/qr-crop-preview.py 预览比较），
不用自动检测——自动检测会被中间那个彩色 logo 吸走，把二维码边缘切掉。
换了源图就要重新量一次。
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "assets" / "qrcodes"

CELL = 120
GAP = 60
OUT = SRC_DIR / "combined.png"

# 文件名 -> 二维码本体的裁剪框 (left, top, right, bottom)，右/下为闭区间
CROPS: dict[str, tuple[int, int, int, int]] = {
    # 二维码本来就铺满整张图
    "gongzhonghao.jpg": (0, 0, 430, 430),
    # 去掉顶部头像+「欣泽编程」标题、底部「扫一扫二维码，关注我的视频号」
    # 保留放射状装饰点、三个定位角与右下角视频号 logo（都属于二维码图案）
    "shipinhao.jpg": (100, 320, 980, 1200),
    # 去掉顶部「欣泽编程-信奥知识大全」标题、底部「扫码订阅ima知识库」
    # 保留绿色底与右下角 ima 字样（属于二维码图案）
    "zhishiku.jpg": (65, 245, 845, 1025),
    # 二维码铺满整张图（右下角绿色小程序 logo 属于原图图案）
    "xiaochengxu.jpg": (0, 0, 430, 430),
}


def main() -> int:
    files = list(CROPS)
    missing = [name for name in files if not (SRC_DIR / name).exists()]
    if missing:
        print(f"缺少源图：{', '.join(missing)}", file=sys.stderr)
        return 1

    # 先校验：所有裁剪框必须等宽等高，否则四张渲染尺寸会不一致
    for name, (left, top, right, bottom) in CROPS.items():
        box_w = right - left
        box_h = bottom - top
        if box_w != box_h:
            print(f"{name} 裁剪框不是正方形：{box_w}x{box_h}（要求等宽等高）", file=sys.stderr)
            return 1

    canvas_width = CELL * len(files) + GAP * (len(files) - 1)
    canvas = Image.new("RGB", (canvas_width, CELL), "white")

    for index, name in enumerate(files):
        source = Image.open(SRC_DIR / name).convert("RGB")
        box = CROPS[name]
        cropped = source.crop(box)
        cropped = cropped.resize((CELL, CELL), Image.LANCZOS)
        canvas.paste(cropped, (index * (CELL + GAP), 0))
        side = box[2] - box[0]
        print(f"{name}: 原图 {source.width}x{source.height} 裁 {side}x{side} -> {CELL}x{CELL}")

    canvas.save(OUT, format="PNG", optimize=True)
    print(f"\n已生成 {OUT}  {canvas.size[0]}x{canvas.size[1]}  {OUT.stat().st_size} 字节")
    print("四张均为 120x120，视觉一致 ✅")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
