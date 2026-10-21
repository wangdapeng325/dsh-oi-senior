"""裁剪候选预览：把若干候选框分别裁出来并排拼成一张，便于人工比较。

用法：python scripts/qr-crop-preview.py <name> <x1> <y1> <x2> <y2> [<x1> <y1> <x2> <y2> ...]
例：  python scripts/qr-crop-preview.py shipinhao.jpg 150 350 800 1000 100 300 750 950
输出：%TEMP%/qr-crop-preview.png
"""

from __future__ import annotations

import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "assets" / "qrcodes"
PREVIEW = 260


def main() -> int:
    if len(sys.argv) < 6:
        print(__doc__, file=sys.stderr)
        return 64
    name = sys.argv[1]
    numbers = [int(v) for v in sys.argv[2:]]
    if len(numbers) % 4 != 0:
        print("坐标必须 4 个一组", file=sys.stderr)
        return 64
    boxes = [tuple(numbers[i:i + 4]) for i in range(0, len(numbers), 4)]

    source = Image.open(SRC_DIR / name).convert("RGB")
    gap = 20
    canvas = Image.new("RGB", (len(boxes) * (PREVIEW + gap) + gap, PREVIEW + 60), "white")
    draw = ImageDraw.Draw(canvas)

    for index, box in enumerate(boxes):
        cropped = source.crop(box)
        # 等比缩放预览，保持可见
        cropped.thumbnail((PREVIEW, PREVIEW), Image.LANCZOS)
        x = gap + index * (PREVIEW + gap)
        y = 40
        canvas.paste(cropped, (x, y))
        draw.text((x, 12), f"#{index + 1} {box}", fill=(200, 0, 0))
        draw.rectangle([x, y, x + cropped.width, y + cropped.height], outline=(0, 120, 255), width=2)

    target = Path(tempfile.gettempdir()) / "qr-crop-preview.png"
    canvas.save(target)
    print(f"已生成 {target}   源图 {source.width}x{source.height}   候选 {len(boxes)} 个")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
