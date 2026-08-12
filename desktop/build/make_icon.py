"""App icon for the desktop shell: a slice with a segmentation outline.

Drawn with matplotlib (already in the venv), rendered at every size macOS
wants, compiled to .icns with iconutil. Generic imagery only.
"""
import os
import subprocess
import sys

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.patches import FancyBboxPatch, Ellipse

OUT = sys.argv[1]                      # .../desktop/build
ICONSET = os.path.join(OUT, "icon.iconset")
os.makedirs(ICONSET, exist_ok=True)


def draw(px: int, path: str) -> None:
    fig = plt.figure(figsize=(1, 1), dpi=px)
    ax = fig.add_axes([0, 0, 1, 1])
    ax.set_xlim(0, 1); ax.set_ylim(0, 1)
    ax.axis("off")

    # macOS-style rounded square, dark slate.
    pad = 0.055
    box = FancyBboxPatch((pad, pad), 1 - 2 * pad, 1 - 2 * pad,
                         boxstyle=f"round,pad=0,rounding_size={0.22}",
                         facecolor="#171c22", edgecolor="none")
    ax.add_patch(box)

    # A soft grey "anatomy" blob, like tissue on a T2 slice.
    ax.add_patch(Ellipse((0.5, 0.47), 0.62, 0.5, angle=-8,
                         facecolor="#3c4653", edgecolor="none"))
    ax.add_patch(Ellipse((0.42, 0.52), 0.30, 0.22, angle=12,
                         facecolor="#525f6f", edgecolor="none"))

    # The segmentation: a bright dashed contour around a filled region.
    t = np.linspace(0, 2 * np.pi, 200)
    r = 0.13 * (1 + 0.18 * np.sin(3 * t) + 0.07 * np.cos(5 * t))
    x = 0.60 + r * np.cos(t) * 1.15
    y = 0.42 + r * np.sin(t)
    ax.fill(x, y, color="#e0417c", alpha=0.45)
    ax.plot(x, y, color="#ff5c92", lw=px * 0.018 / 4, solid_capstyle="round")

    # Crosshair ticks, the viewer's signature.
    for (x0, y0, x1, y1) in [(0.60, 0.80, 0.60, 0.88), (0.60, 0.04 + 0.08, 0.60, 0.04),
                             (0.16, 0.42, 0.08, 0.42), (0.94, 0.42, 0.86, 0.42)]:
        ax.plot([x0, x1], [y0, y1], color="#8fa3b8", lw=px * 0.012 / 4,
                solid_capstyle="round")

    fig.savefig(path, transparent=True)
    plt.close(fig)


SIZES = [16, 32, 64, 128, 256, 512, 1024]
for s in SIZES:
    draw(s, os.path.join(ICONSET, f"icon_{s}x{s}.png"))
    if s <= 512:
        draw(s * 2, os.path.join(ICONSET, f"icon_{s}x{s}@2x.png"))

subprocess.run(["iconutil", "-c", "icns", ICONSET,
                "-o", os.path.join(OUT, "icon.icns")], check=True)
print("wrote", os.path.join(OUT, "icon.icns"))
