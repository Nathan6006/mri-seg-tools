#!/usr/bin/env python3
"""
Build mouse-level, arm-stratified train/test splits and 5-fold CV folds.

Writes derived/splits.json.

Why mouse-level: each mouse contributes 4-6 timepoints that look nearly
identical. Splitting by scan puts the same animal on both sides of the split and
inflates every metric. Splitting by mouse is the only honest option.

Why stratified by arm: with only ~9 mice per arm, an unstratified random split
can easily produce a fold with almost no controls, and the treatment arms differ
systematically in tumor size (treated mice have small or absent tumors).

The `Excluded / no visible tumor` group is NOT a treatment arm. It is two mice
the lab dropped from the treatment summary. Their scans are valid imaging data,
so they go into training, but they are never used as a stratification level and
never enter the test set.

Usage:  .venv/bin/python src/splits.py [--test-size 8] [--folds 5] [--seed 0]
"""
from __future__ import annotations

import argparse
import json
import os

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "derived")

REAL_ARMS = os.environ.get("STUDY_ARMS", "ArmA,ArmB,ArmC,Control").split(",")
NON_ARM = os.environ.get("STUDY_NON_ARM", "Excluded")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--test-size", type=int, default=8)
    ap.add_argument("--folds", type=int, default=5)
    ap.add_argument("--seed", type=int, default=0)
    args = ap.parse_args()

    man = pd.read_csv(os.path.join(OUT, "manifest.csv"))
    usable = man[man.usable_for_training & man.mouse_id.notna()]

    mice = (usable.groupby("mouse_id")
                  .agg(arm=("arm", "first"), n_sessions=("session_id", "size"),
                       n_pos=("tumor_present", lambda s: int((s == True).sum())))
                  .reset_index())

    rng = np.random.default_rng(args.seed)

    # ---- held-out test set: equal per real arm, never touched until the end ----
    per_arm = args.test_size // len(REAL_ARMS)
    test = []
    for arm in REAL_ARMS:
        pool = mice[mice.arm == arm].mouse_id.tolist()
        test += list(rng.choice(pool, size=min(per_arm, len(pool)), replace=False))
    test = sorted(test)

    dev = mice[~mice.mouse_id.isin(test)].copy()

    # ---- 5-fold CV over the remaining mice, stratified by arm ----
    folds = [[] for _ in range(args.folds)]
    for arm, grp in dev.groupby("arm"):
        ms = grp.mouse_id.tolist()
        rng.shuffle(ms)
        # deal round-robin starting at a rotating offset so small arms spread out
        start = rng.integers(args.folds)
        for j, m in enumerate(ms):
            folds[(start + j) % args.folds].append(m)
    folds = [sorted(f) for f in folds]

    splits = {
        "seed": args.seed,
        "test_mice": test,
        "dev_mice": sorted(dev.mouse_id.tolist()),
        "folds": [{"fold": i,
                   "val_mice": f,
                   "train_mice": sorted(set(dev.mouse_id) - set(f))}
                  for i, f in enumerate(folds)],
    }
    path = os.path.join(OUT, "splits.json")
    with open(path, "w") as fh:
        json.dump(splits, fh, indent=2)

    # ---- report ----
    def summarise(names, label):
        sub = usable[usable.mouse_id.isin(names)]
        arms = mice[mice.mouse_id.isin(names)].arm.value_counts().to_dict()
        print(f"{label:10s} mice={len(names):3d}  sessions={len(sub):3d}  "
              f"pos={int((sub.tumor_present == True).sum()):3d} "
              f"neg={int((sub.tumor_present == False).sum()):3d}  "
              f"arms={ {k: arms.get(k, 0) for k in REAL_ARMS + [NON_ARM]} }")

    print(f"total usable: {len(mice)} mice, {len(usable)} sessions\n")
    summarise(test, "TEST")
    summarise(splits["dev_mice"], "DEV")
    print()
    for f in splits["folds"]:
        summarise(f["val_mice"], f"  fold{f['fold']} val")
    print(f"\nwrote {path}")


if __name__ == "__main__":
    main()
