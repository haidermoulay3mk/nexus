"""Generate the Nexus logo: a minimalist dark rounded square with a geometric
blue 'N' and a small node dot. Produces nexus.ico (Windows) and nexus.png.

Run:  python assets/make_logo.py
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent

BG = (15, 17, 21, 255)        # #0F1115 (matches dashboard)
BLUE = (59, 130, 246, 255)    # #3B82F6
NODE = (96, 165, 250, 255)    # #60A5FA


def render(size: int = 1024) -> Image.Image:
    # Render large, then downscale for crisp anti-aliased edges.
    scale = size / 256
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    def s(v: float) -> float:
        return v * scale

    # Rounded square background.
    d.rounded_rectangle([s(8), s(8), s(248), s(248)], radius=s(56), fill=BG)

    # Geometric 'N': left bar, diagonal, right bar — with rounded caps/joints.
    w = int(s(26))
    r = w // 2
    xl, xr, yt, yb = s(90), s(166), s(82), s(174)
    segments = [((xl, yb), (xl, yt)), ((xl, yt), (xr, yb)), ((xr, yb), (xr, yt))]
    for p1, p2 in segments:
        d.line([p1, p2], fill=BLUE, width=w)
        for (x, y) in (p1, p2):
            d.ellipse([x - r, y - r, x + r, y + r], fill=BLUE)

    # Accent node dot at the top-right of the N.
    dr = s(15)
    d.ellipse([xr - dr, yt - dr, xr + dr, yt + dr], fill=NODE)

    return img


def main() -> None:
    big = render(1024)
    png = big.resize((256, 256), Image.LANCZOS)
    png.save(HERE / "nexus.png")
    sizes = [(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)]
    png.save(HERE / "nexus.ico", sizes=sizes)
    print("wrote", HERE / "nexus.png", "and", HERE / "nexus.ico")


if __name__ == "__main__":
    main()
