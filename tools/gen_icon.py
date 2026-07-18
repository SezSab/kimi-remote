#!/usr/bin/env python3
"""Generate icon-180.png and icon-512.png: dark tile with a green '>_ ' prompt glyph.
Zero dependencies — writes PNGs via zlib+struct."""

import struct
import zlib
import os

OUT = os.path.join(os.path.dirname(__file__), "..", "public")

BG = (13, 17, 23)       # #0d1117
FG = (63, 185, 80)      # #3fb950

# '>' glyph, 5 wide x 7 tall
GT = [
    "X....",
    ".X...",
    "..X..",
    "...X.",
    "..X..",
    ".X...",
    "X....",
]
# '_' glyph, 4 wide x 7 tall (only bottom row)
US = [
    "....",
    "....",
    "....",
    "....",
    "....",
    "....",
    "XXXX",
]
GLYPH = [g + "." + u for g, u in zip(GT, US)]  # 10 wide, 7 tall


def make_png(size):
    margin = size // 6
    cell = (size - 2 * margin) // len(GLYPH[0])
    gw, gh = cell * len(GLYPH[0]), cell * len(GLYPH)
    ox, oy = (size - gw) // 2, (size - gh) // 2
    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            c = BG
            gx, gy = (x - ox) // cell, (y - oy) // cell
            if 0 <= gy < len(GLYPH) and 0 <= gx < len(GLYPH[0]) and GLYPH[gy][gx] == "X":
                c = FG
            row += bytes((*c, 255))
        rows.append(b"\x00" + bytes(row))

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
        + chunk(b"IEND", b"")
    )


for s in (180, 512):
    p = os.path.join(OUT, f"icon-{s}.png")
    with open(p, "wb") as f:
        f.write(make_png(s))
    print("wrote", p)
