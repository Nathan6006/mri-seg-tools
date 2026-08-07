#!/usr/bin/env python3
"""
Export the dataset in nnU-Net v2 raw format, plus a splits_final.json that
forces nnU-Net to use OUR mouse-level folds instead of its own random ones.

That last part matters. nnU-Net's default 5-fold CV splits by case, which here
means by scan -- the same mouse would land in both train and val and every
reported number would be inflated. Writing splits_final.json into the
preprocessed directory overrides that.

Case IDs are CASE_<series_number>. Series numbers are unique across the whole
study (40001-40986), so one ID always means one acquisition.

Tumor-free sessions are exported with an all-zero label. They are real, curated
negatives and the model must see them, otherwise it learns that every scan
contains a tumor.

Output layout:
    derived/nnunet_raw/Dataset001_Tumor/
        imagesTr/CASE_40004_0000.nii.gz     <- dev-set scans (train + val folds)
        labelsTr/CASE_40004.nii.gz
        imagesTs/CASE_40133_0000.nii.gz     <- held-out test mice
        labelsTs/CASE_40133.nii.gz
        dataset.json
        splits_final.json                  <- copy into nnUNet_preprocessed/<dataset>/

Usage:  .venv/bin/python src/export_nnunet.py
"""
from __future__ import annotations

import json
import os
import re
import sys
import warnings

import numpy as np
import pandas as pd
import SimpleITK as sitk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from loader import assert_same_grid, load_series

warnings.filterwarnings("ignore")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "derived")
DATASET = "Dataset001_Tumor"


def case_id(image_path: str) -> str:
    """CASE_<series_number> from a path like 'DICOM/40004/1'."""
    m = re.search(r"DICOM/(\d+)/", image_path + "/")
    return f"CASE_{m.group(1)}"


def main():
    man = pd.read_csv(os.path.join(OUT, "manifest.csv"))
    pairs = pd.read_csv(os.path.join(OUT, "pairs.csv"))
    with open(os.path.join(OUT, "splits.json")) as fh:
        splits = json.load(fh)

    base = os.path.join(OUT, "nnunet_raw", DATASET)
    for sub in ("imagesTr", "labelsTr", "imagesTs", "labelsTs"):
        os.makedirs(os.path.join(base, sub), exist_ok=True)

    test_mice = set(splits["test_mice"])
    pairs = pairs[pairs.usable_for_training].copy()
    pairs["case"] = pairs.image_path.map(case_id)
    pairs["is_test"] = pairs.mouse_id.isin(test_mice)

    if pairs.case.duplicated().any():
        dup = pairs[pairs.case.duplicated(keep=False)].case.tolist()
        raise SystemExit(f"duplicate case IDs, refusing to write: {dup}")

    written = []
    for _, r in pairs.iterrows():
        img = load_series(os.path.join(ROOT, r.image_path))
        if pd.notna(r.mask_path):
            lab = sitk.ReadImage(os.path.join(ROOT, r.mask_path))
            assert_same_grid(lab, img, r.mask_path)
            lab = sitk.Cast(lab > 0, sitk.sitkUInt8)
            lab.CopyInformation(img)
        else:
            # tumor-free scan: an explicit all-zero label, on the image grid
            lab = sitk.Cast(sitk.Image(img.GetSize(), sitk.sitkUInt8), sitk.sitkUInt8)
            lab.CopyInformation(img)

        sub = "Ts" if r.is_test else "Tr"
        sitk.WriteImage(sitk.Cast(img, sitk.sitkFloat32),
                        os.path.join(base, f"images{sub}", f"{r.case}_0000.nii.gz"), True)
        sitk.WriteImage(lab, os.path.join(base, f"labels{sub}", f"{r.case}.nii.gz"), True)
        written.append(dict(case=r.case, split="test" if r.is_test else "dev",
                            mouse_id=r.mouse_id, arm=r.arm,
                            day=r.day_post_inoculation,
                            tumor_present=bool(r.tumor_present),
                            session_id=r.session_id, image_path=r.image_path,
                            mask_path=r.mask_path))

    w = pd.DataFrame(written)
    w.to_csv(os.path.join(OUT, "nnunet_cases.csv"), index=False)

    n_tr = int((~pairs.is_test).sum())
    with open(os.path.join(base, "dataset.json"), "w") as fh:
        json.dump({
            "channel_names": {"0": "T2w"},
            "labels": {"background": 0, "tumor": 1},
            "numTraining": n_tr,
            "file_ending": ".nii.gz",
            "description": "preclinical rodent T2w FSE axial, "
                           "0.1613 x 0.1563 x 1.10 mm. Empty labels are curated "
                           "tumor-free scans, not missing annotations.",
        }, fh, indent=2)

    # our mouse-level folds, in nnU-Net's splits_final.json format
    dev = w[w.split == "dev"]
    final = []
    for f in splits["folds"]:
        val = sorted(dev[dev.mouse_id.isin(f["val_mice"])].case)
        trn = sorted(dev[~dev.mouse_id.isin(f["val_mice"])].case)
        final.append({"train": trn, "val": val})
    with open(os.path.join(base, "splits_final.json"), "w") as fh:
        json.dump(final, fh, indent=2)

    print(f"wrote {base}")
    print(f"  imagesTr/labelsTr : {n_tr} cases  "
          f"({int((~pairs.is_test & (pairs.tumor_present == True)).sum())} pos, "
          f"{int((~pairs.is_test & (pairs.tumor_present != True)).sum())} neg)")
    print(f"  imagesTs/labelsTs : {int(pairs.is_test.sum())} cases  "
          f"({int((pairs.is_test & (pairs.tumor_present == True)).sum())} pos, "
          f"{int((pairs.is_test & (pairs.tumor_present != True)).sum())} neg)")
    print(f"  splits_final.json : {len(final)} folds")
    for i, f in enumerate(final):
        print(f"    fold {i}: train={len(f['train'])} val={len(f['val'])}")
    print(f"\nwrote {os.path.join(OUT, 'nnunet_cases.csv')}")


if __name__ == "__main__":
    main()
