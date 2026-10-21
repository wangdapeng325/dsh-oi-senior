"""给源图叠加坐标网格，便于人工读出二维码本体的精确边界。

用法：python scripts/qr-grid.py
输出：%TEMP%/qr-grid-<name>.png
"""

from __future__ import annotations

import os
import tempfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC_DIR = ROOT / "assets" / "qrcodes"
FILES = ["shipinhao.jpg", "zhishiku.jpg"]


def main() -> None:
    out_dir = Path(tempfile.gettempdir())
    for name in FILES:
        image = Image.open(SRC_DIR / name).convert("RGB")
        draw = ImageDraw.Draw(image)
        step = 100
        for x in range(0, image.width, step):
            color = (255, 0, 0) if x % 500 == 0 else (255, 160, 160)
            draw.line([(x, 0), (x, image.height)], fill=color, width=1)
            draw.text((x + 3, 3), str(x), fill=(255, 0, 0))
        for y in range(0, image.height, step):
            color = (0, 0, 255) if y % 500 == 0 else (160, 160, 255)
            draw.line([(0, y), (image.width, y)], fill=color, width=1)
            draw.text((3, y + 1), str(y), fill=(0, 0, 255))
        target = out_dir / f"qr-grid-{Path(name).stem}.png"
        image.save(target)
        print(f"{name}  {image.width}x{image.height} -> {target}")


if __name__ == "__main__":
    main()
