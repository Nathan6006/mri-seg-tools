#!/usr/bin/env python3
"""
Evaluation protocol for automated tumor segmentation.

The metric split is deliberate and must not be collapsed into a single number:

  1. DETECTION, per scan. "Is there a tumor at all?" Reported as sensitivity and
     specificity. This matters because tumor-free scans are real and are
     concentrated in the treated arms. A model that hallucinates a small tumor in
     a mouse that responded to treatment would erase the treatment effect --
     and that failure is invisible in a Dice average.

  2. OVERLAP, on tumor-positive scans ONLY. Dice and HD95. Averaging Dice over
     empty ground truths is meaningless: Dice is undefined when both masks are
     empty, and defining it as 1.0 lets a model that predicts nothing anywhere
     score well.

  3. VOLUME AGREEMENT. This is what the lab actually cares about, because the
     biology is a growth curve. Absolute and percent volume error, Bland-Altman
     limits of agreement, and ICC(2,1) against the manual volumes.

  4. STRATIFIED. All of the above, broken down by tumor size and by day post
     inoculation. Lesion volumes in a treatment study typically span several
     orders of magnitude, so a global mean is dominated by a handful of large
     lesions.

Usage:
    .venv/bin/python src/evaluate.py --pred-dir <dir of predicted *.nii.gz> \\
                                     --out derived/eval
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
import warnings

import numpy as np
import pandas as pd
import SimpleITK as sitk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from loader import assert_same_grid

warnings.filterwarnings("ignore")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "derived")

SIZE_BINS = [0, 10, 50, 200, np.inf]
SIZE_LABELS = ["<10 mm3", "10-50", "50-200", ">200"]


def dice(a: np.ndarray, b: np.ndarray) -> float:
    s = a.sum() + b.sum()
    if s == 0:
        return np.nan          # both empty: undefined, NOT 1.0
    return float(2 * np.logical_and(a, b).sum() / s)


def hd95(gt: sitk.Image, pred: sitk.Image) -> float:
    """95th-percentile Hausdorff distance in mm. NaN if either mask is empty."""
    g = sitk.Cast(gt > 0, sitk.sitkUInt8)
    p = sitk.Cast(pred > 0, sitk.sitkUInt8)
    if sitk.GetArrayViewFromImage(g).sum() == 0 or sitk.GetArrayViewFromImage(p).sum() == 0:
        return np.nan
    # distance from each surface to the other, pooled, then 95th percentile
    def surf_dists(a, b):
        dm = sitk.Abs(sitk.SignedMaurerDistanceMap(b, squaredDistance=False,
                                                   useImageSpacing=True))
        contour = sitk.LabelContour(a, False)
        d = sitk.GetArrayViewFromImage(dm)[sitk.GetArrayViewFromImage(contour) > 0]
        return d
    d = np.concatenate([surf_dists(g, p), surf_dists(p, g)])
    return float(np.percentile(d, 95)) if d.size else np.nan


def icc21(x: np.ndarray, y: np.ndarray) -> float:
    """ICC(2,1), two-way random effects, absolute agreement, single measurement."""
    m = np.vstack([x, y]).T
    n, k = m.shape
    if n < 2:
        return np.nan
    grand = m.mean()
    ms_r = k * ((m.mean(1) - grand) ** 2).sum() / (n - 1)
    ms_c = n * ((m.mean(0) - grand) ** 2).sum() / (k - 1)
    ms_e = ((m - m.mean(1, keepdims=True) - m.mean(0, keepdims=True) + grand) ** 2).sum() \
        / ((n - 1) * (k - 1))
    denom = ms_r + (k - 1) * ms_e + k * (ms_c - ms_e) / n
    return float((ms_r - ms_e) / denom) if denom else np.nan


def bland_altman(x: np.ndarray, y: np.ndarray) -> dict:
    """x = manual, y = automated. Returns bias and 95% limits of agreement."""
    d = y - x
    bias, sd = float(d.mean()), float(d.std(ddof=1))
    return {"bias_mm3": bias, "loa_lower_mm3": bias - 1.96 * sd,
            "loa_upper_mm3": bias + 1.96 * sd, "sd_mm3": sd}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pred-dir", required=True,
                    help="directory of predicted masks named <case>.nii.gz")
    ap.add_argument("--cases", default=os.path.join(OUT, "nnunet_cases.csv"))
    ap.add_argument("--split", default="test", choices=["test", "dev", "all"])
    ap.add_argument("--out", default=os.path.join(OUT, "eval"))
    args = ap.parse_args()

    cases = pd.read_csv(args.cases)
    if args.split != "all":
        cases = cases[cases.split == args.split]
    os.makedirs(args.out, exist_ok=True)

    rows = []
    for _, r in cases.iterrows():
        pp = os.path.join(args.pred_dir, f"{r.case}.nii.gz")
        if not os.path.exists(pp):
            print(f"  !! missing prediction for {r.case}")
            continue
        gt_dir = "labelsTs" if r.split == "test" else "labelsTr"
        gp = os.path.join(OUT, "nnunet_raw", "Dataset001_Tumor", gt_dir,
                          f"{r.case}.nii.gz")
        g, p = sitk.ReadImage(gp), sitk.ReadImage(pp)
        assert_same_grid(p, g, r.case)
        ga = sitk.GetArrayFromImage(g) > 0
        pa = sitk.GetArrayFromImage(p) > 0
        vox = float(np.prod(g.GetSpacing()))
        rows.append(dict(
            case=r.case, mouse_id=r.mouse_id, arm=r.arm, day=r.day,
            gt_present=bool(ga.any()), pred_present=bool(pa.any()),
            gt_volume_mm3=ga.sum() * vox, pred_volume_mm3=pa.sum() * vox,
            dice=dice(ga, pa),
            hd95_mm=hd95(g, p) if (ga.any() and pa.any()) else np.nan,
        ))

    df = pd.DataFrame(rows)
    if df.empty:
        raise SystemExit("no predictions matched")
    df["volume_err_mm3"] = df.pred_volume_mm3 - df.gt_volume_mm3
    df["volume_pct_err"] = np.where(df.gt_volume_mm3 > 0,
                                    100 * df.volume_err_mm3 / df.gt_volume_mm3, np.nan)
    df["size_bin"] = pd.cut(df.gt_volume_mm3, SIZE_BINS, labels=SIZE_LABELS)
    df.to_csv(os.path.join(args.out, f"per_case_{args.split}.csv"), index=False)

    # ---------- 1. detection ----------
    tp = int((df.gt_present & df.pred_present).sum())
    fn = int((df.gt_present & ~df.pred_present).sum())
    tn = int((~df.gt_present & ~df.pred_present).sum())
    fp = int((~df.gt_present & df.pred_present).sum())
    det = {"tp": tp, "fn": fn, "tn": tn, "fp": fp,
           "sensitivity": tp / (tp + fn) if tp + fn else np.nan,
           "specificity": tn / (tn + fp) if tn + fp else np.nan}

    # ---------- 2. overlap, positives only ----------
    pos = df[df.gt_present]
    ov = {"n_positive": len(pos),
          "dice_mean": float(pos.dice.mean()), "dice_median": float(pos.dice.median()),
          "dice_iqr": [float(pos.dice.quantile(.25)), float(pos.dice.quantile(.75))],
          "hd95_median_mm": float(pos.hd95_mm.median()),
          "n_missed": int((~pos.pred_present).sum())}

    # ---------- 3. volume agreement, positives only ----------
    v = pos.dropna(subset=["gt_volume_mm3", "pred_volume_mm3"])
    vol = {"n": len(v),
           "median_abs_pct_err": float(v.volume_pct_err.abs().median()),
           "icc_2_1": icc21(v.gt_volume_mm3.values, v.pred_volume_mm3.values),
           **bland_altman(v.gt_volume_mm3.values, v.pred_volume_mm3.values)}
    # on the log scale too, since volumes span four orders of magnitude
    lv = v[(v.gt_volume_mm3 > 0) & (v.pred_volume_mm3 > 0)]
    vol["icc_2_1_log10"] = icc21(np.log10(lv.gt_volume_mm3.values),
                                 np.log10(lv.pred_volume_mm3.values))

    summary = {"split": args.split, "n_cases": len(df),
               "detection": det, "overlap_positives_only": ov, "volume": vol}
    with open(os.path.join(args.out, f"summary_{args.split}.json"), "w") as fh:
        json.dump(summary, fh, indent=2, default=float)

    # ---------- 4. stratified ----------
    by_size = pos.groupby("size_bin", observed=True).agg(
        n=("dice", "size"), dice_median=("dice", "median"),
        detected=("pred_present", "mean"),
        median_abs_pct_err=("volume_pct_err", lambda s: s.abs().median()))
    by_day = pos.groupby("day", observed=True).agg(
        n=("dice", "size"), dice_median=("dice", "median"),
        detected=("pred_present", "mean"),
        median_abs_pct_err=("volume_pct_err", lambda s: s.abs().median()))
    by_arm = df.groupby("arm", observed=True).agg(
        n=("dice", "size"), dice_median=("dice", "median"),
        false_pos_rate=("pred_present", lambda s: np.nan))
    by_size.to_csv(os.path.join(args.out, f"by_size_{args.split}.csv"))
    by_day.to_csv(os.path.join(args.out, f"by_day_{args.split}.csv"))

    # ---------- report ----------
    print(f"=== {args.split} split, {len(df)} scans ===\n")
    print("DETECTION (per scan)")
    print(f"  sensitivity {det['sensitivity']:.3f}   specificity {det['specificity']:.3f}")
    print(f"  TP {tp}  FN {fn}  TN {tn}  FP {fp}")
    print(f"  false positives are the dangerous ones here: {fp} tumor-free scans "
          f"given a tumor")
    print("\nOVERLAP (tumor-positive scans only, n=%d)" % ov["n_positive"])
    print(f"  Dice  median {ov['dice_median']:.3f}  mean {ov['dice_mean']:.3f}  "
          f"IQR [{ov['dice_iqr'][0]:.3f}, {ov['dice_iqr'][1]:.3f}]")
    print(f"  HD95  median {ov['hd95_median_mm']:.2f} mm")
    print(f"  completely missed: {ov['n_missed']}")
    print("\nVOLUME AGREEMENT (n=%d)" % vol["n"])
    print(f"  median |%err|  {vol['median_abs_pct_err']:.1f}%")
    print(f"  ICC(2,1)       {vol['icc_2_1']:.3f}   (log10 scale {vol['icc_2_1_log10']:.3f})")
    print(f"  Bland-Altman   bias {vol['bias_mm3']:+.2f} mm3, "
          f"95% LoA [{vol['loa_lower_mm3']:.1f}, {vol['loa_upper_mm3']:.1f}]")
    print("\nBY TUMOR SIZE"); print(by_size.to_string())
    print("\nBY DAY POST INOCULATION"); print(by_day.to_string())
    print(f"\nwrote {args.out}/")
    print("\nNOTE: there is still no intra-rater Dice ceiling for this dataset. "
          "Until the\nblind re-segmentations come back, a Dice of X is not "
          "interpretable as good or bad.")


if __name__ == "__main__":
    main()
