#!/usr/bin/env python3
"""
Generate QC images for every session in the manifest.

Two modes:

  overlay  - the mask contour drawn on the slices that contain tumor. Use this
             to sanity-check that annotations sit where they should, and to
             review model output later.

  montage  - all slices, no mask, no mouse ID in the title. Use this to score
             image quality BLIND, before training. Filenames are the session ID
             only, so the scorer cannot see the treatment arm or tumor status.

Writes derived/qc/overlay/*.png and derived/qc/montage/*.png.

Usage:
    .venv/bin/python src/qc_overlays.py --mode overlay
    .venv/bin/python src/qc_overlays.py --mode montage
    .venv/bin/python src/qc_overlays.py --mode both
"""
from __future__ import annotations

import argparse
import os
import sys
import warnings

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd
import SimpleITK as sitk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from loader import assert_same_grid, load_series

warnings.filterwarnings("ignore")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "derived")


def window(a: np.ndarray) -> tuple[float, float]:
    """Display window. Percentile-based so one bright artifact can't wash it out."""
    return float(np.percentile(a, 0.5)), float(np.percentile(a, 99.5))


def overlay_figure(arr, mask, title, max_panels=6):
    zs = np.where(mask.any(axis=(1, 2)))[0] if mask is not None and mask.any() else []
    if len(zs) == 0:
        zs = np.linspace(0, arr.shape[0] - 1, min(max_panels, arr.shape[0])).astype(int)
    elif len(zs) > max_panels:
        zs = zs[np.linspace(0, len(zs) - 1, max_panels).astype(int)]
    lo, hi = window(arr)
    fig, axes = plt.subplots(1, len(zs), figsize=(3.2 * len(zs), 3.6))
    for ax, z in zip(np.atleast_1d(axes), zs):
        ax.imshow(arr[z], cmap="gray", vmin=lo, vmax=hi)
        if mask is not None and mask[z].any():
            ax.contour(mask[z], levels=[0.5], colors="r", linewidths=1.2)
            ax.set_title(f"slice {z}   {int(mask[z].sum())} px", fontsize=9)
        else:
            ax.set_title(f"slice {z}", fontsize=9)
        ax.axis("off")
    fig.suptitle(title, fontsize=11)
    fig.tight_layout()
    return fig


def montage_figure(arr, title, ncol=6):
    n = arr.shape[0]
    nrow = int(np.ceil(n / ncol))
    lo, hi = window(arr)
    fig, axes = plt.subplots(nrow, ncol, figsize=(2.1 * ncol, 2.2 * nrow))
    for i, ax in enumerate(np.atleast_1d(axes).ravel()):
        if i < n:
            ax.imshow(arr[i], cmap="gray", vmin=lo, vmax=hi)
            ax.set_title(str(i), fontsize=7)
        ax.axis("off")
    fig.suptitle(title, fontsize=10)
    fig.tight_layout()
    return fig


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["overlay", "montage", "both"], default="both")
    ap.add_argument("--limit", type=int, default=None)
    args = ap.parse_args()

    man = pd.read_csv(os.path.join(OUT, "manifest.csv"))
    if args.limit:
        man = man.head(args.limit)

    for sub in ("overlay", "montage"):
        os.makedirs(os.path.join(OUT, "qc", sub), exist_ok=True)

    n_ok = n_err = 0
    for _, r in man.iterrows():
        first_img = str(r.image_path).split(";")[0]
        try:
            img = load_series(os.path.join(ROOT, first_img))
            arr = sitk.GetArrayFromImage(img).astype(float)
        except Exception as e:
            print(f"  !! {r.session_id}: {str(e)[:80]}")
            n_err += 1
            continue

        mask = None
        if pd.notna(r.mask_path) and r.mask_grid_ok is True:
            m = sitk.ReadImage(os.path.join(ROOT, str(r.mask_path).split(";")[0]))
            try:
                assert_same_grid(m, img)
                mask = sitk.GetArrayFromImage(m) > 0
            except ValueError:
                mask = None

        stem = str(r.session_id).replace(";", "-")

        if args.mode in ("overlay", "both"):
            vol = "" if pd.isna(r.tumor_volume_mm3) else f"   {r.tumor_volume_mm3:.2f} mm3"
            mouse = r.mouse_id if pd.notna(r.mouse_id) else "unmapped"
            day = "" if pd.isna(r.day_post_inoculation) else f" d{int(r.day_post_inoculation)}"
            fig = overlay_figure(arr, mask, f"{stem}  {mouse}{day}{vol}")
            fig.savefig(os.path.join(OUT, "qc", "overlay", f"{stem}.png"), dpi=85)
            plt.close(fig)

        if args.mode in ("montage", "both"):
            # deliberately no mouse / arm / tumor info: this is scored blind
            fig = montage_figure(arr, f"session {stem}")
            fig.savefig(os.path.join(OUT, "qc", "montage", f"{stem}.png"), dpi=70)
            plt.close(fig)

        n_ok += 1

    print(f"wrote QC images for {n_ok} sessions ({n_err} errors) -> {os.path.join(OUT,'qc')}")
    if args.mode in ("montage", "both"):
        print("\nBlind quality scoring: review derived/qc/montage/, then fill in the\n"
              "qc_flag column of derived/manifest.csv with one of:\n"
              "  ok | grainy | motion | wrap | coverage | unusable\n"
              "Score BEFORE training and never revise it based on model output.")


if __name__ == "__main__":
    main()
