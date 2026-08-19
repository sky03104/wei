#!/usr/bin/env python3
"""
產生 PWA 圖示（docs/icons/*.png）。

刻意不依賴 Pillow — 像素圖的色彩單純，用 zlib + struct 直接寫 PNG 就夠了，
少一個安裝步驟，之後想改配色隨時能重跑：

    python3 tools/make-icons.py

圖案來源是 tools/pixel-machine.txt，與畫面上的 SVG 同一份，
所以 App 圖示跟你在 App 裡看到的娃娃機長得一模一樣。
"""

import os
import struct
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
MAP_FILE = os.path.join(HERE, 'pixel-machine.txt')
OUT_DIR = os.path.join(HERE, '..', 'docs', 'icons')

# 與 docs/styles.css 的深色主題一致
BACKGROUND = (0x10, 0x13, 0x1A, 0xFF)

PALETTE = {
    '.': None,                       # 透明
    'K': (0x0B, 0x0E, 0x14, 0xFF),   # 外框
    'B': (0x4F, 0x7B, 0xE8, 0xFF),   # 機身主色
    'L': (0x86, 0xA9, 0xFF, 0xFF),   # 機身亮部
    'G': (0x1B, 0x23, 0x33, 0xFF),   # 玻璃
    'C': (0xB8, 0xC0, 0xD0, 0xFF),   # 金屬
    'W': (0xFF, 0xFF, 0xFF, 0xFF),   # 高光
    'P': (0xFF, 0x6F, 0xA5, 0xFF),   # 娃娃（粉）
    'Y': (0xFF, 0xD3, 0x4D, 0xFF),   # 娃娃（黃）
    'S': (0x4A, 0xDE, 0x80, 0xFF),   # 狀態燈（營運中）
}


def load_map():
    rows = []
    with open(MAP_FILE, encoding='utf-8') as fh:
        for line in fh:
            line = line.rstrip('\n')
            if not line.strip() or line.lstrip().startswith('#'):
                continue
            rows.append(line)
    widths = {len(r) for r in rows}
    if len(widths) != 1:
        raise SystemExit('圖案每列寬度必須一致，實際有 %s' % sorted(widths))
    return rows


def write_png(path, width, height, pixels):
    """pixels: list of rows, each row a list of (r,g,b,a)."""
    raw = bytearray()
    for row in pixels:
        raw.append(0)  # filter type 0
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        out = struct.pack('>I', len(data)) + tag + data
        return out + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    header = struct.pack('>IIBBBBB', width, height, 8, 6, 0, 0, 0)
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', header)
           + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as fh:
        fh.write(png)


def rounded(x, y, size, radius):
    """圖示外框的圓角判斷，讓方形圖示在各家系統上都不會太生硬。"""
    for cx, cy in ((radius, radius), (size - 1 - radius, radius),
                   (radius, size - 1 - radius), (size - 1 - radius, size - 1 - radius)):
        if (x < radius and y < radius and (cx, cy) == (radius, radius)) \
           or (x > size - 1 - radius and y < radius and (cx, cy) == (size - 1 - radius, radius)) \
           or (x < radius and y > size - 1 - radius and (cx, cy) == (radius, size - 1 - radius)) \
           or (x > size - 1 - radius and y > size - 1 - radius and (cx, cy) == (size - 1 - radius, size - 1 - radius)):
            if (x - cx) ** 2 + (y - cy) ** 2 > radius ** 2:
                return False
    return True


def render(size, art, padding_ratio, corner_ratio):
    art_h = len(art)
    art_w = len(art[0])

    usable = size * (1 - padding_ratio * 2)
    scale = max(1, int(min(usable / art_w, usable / art_h)))
    draw_w, draw_h = art_w * scale, art_h * scale
    off_x = (size - draw_w) // 2
    off_y = (size - draw_h) // 2

    radius = int(size * corner_ratio)
    transparent = (0, 0, 0, 0)

    pixels = []
    for y in range(size):
        row = []
        for x in range(size):
            row.append(BACKGROUND if rounded(x, y, size, radius) else transparent)
        pixels.append(row)

    for ay in range(art_h):
        for ax in range(art_w):
            color = PALETTE[art[ay][ax]]
            if color is None:
                continue
            for dy in range(scale):
                for dx in range(scale):
                    px, py = off_x + ax * scale + dx, off_y + ay * scale + dy
                    if 0 <= px < size and 0 <= py < size:
                        pixels[py][px] = color
    return pixels


def main():
    art = load_map()
    os.makedirs(OUT_DIR, exist_ok=True)

    # maskable 圖示要留安全區：Android 會把它裁成圓形等形狀，內容太滿會被切掉
    targets = [
        ('icon-192.png', 192, 0.10, 0.18),
        ('icon-512.png', 512, 0.10, 0.18),
        ('icon-maskable-512.png', 512, 0.22, 0.0),
        ('apple-touch-icon-180.png', 180, 0.10, 0.0),
    ]

    for name, size, pad, corner in targets:
        path = os.path.join(OUT_DIR, name)
        write_png(path, size, size, render(size, art, pad, corner))
        print('%-28s %4d x %-4d %6d bytes' % (name, size, size, os.path.getsize(path)))


if __name__ == '__main__':
    main()
