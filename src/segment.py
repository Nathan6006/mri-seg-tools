#!/usr/bin/env python3
"""
The lab-facing tool.

Point it at a scan folder, get back:
  - a tumor mask as .nii.gz, on the same voxel grid as the DICOM
  - the tumor volume in mm3
  - a QC overlay PNG
  - an ITK-SNAP workspace file, so it opens ready to inspect and correct

Usage:
    .venv/bin/python src/segment.py "SESSION_0001" --out results/
    .venv/bin/python src/segment.py /path/to/session --out results/ --model <nnunet_model_dir>

Without --model it runs in "prepare" mode: it converts the scan, writes the QC
montage and the ITK-SNAP workspace, and reports geometry, but produces no mask.
That mode is useful now, before a model is trained.

The output mask is written with the SAME size, spacing, origin and direction as
the source DICOM series, so it loads directly on top of the scan in ITK-SNAP
with no resampling and no shifting.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import shutil
import subprocess
import sys
import tempfile
import warnings
import xml.etree.ElementTree as ET

import numpy as np
import SimpleITK as sitk

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from loader import (assert_same_grid, dicom_meta, find_t2_axial_series,
                    load_series, tumor_volume_mm3)

warnings.filterwarnings("ignore")

LABEL_FILE = """################################################
# ITK-SnAP Label Description File
################################################
    0     0    0    0        0  0  0    "Clear Label"
    1   255    0    0        1  1  1    "Tumor"
"""


def write_itksnap_workspace(path, image_abs, seg_abs):
    """Minimal ITK-SNAP workspace so the result opens with one double-click."""
    root = ET.Element("registry")

    def folder(parent, key):
        f = ET.SubElement(parent, "folder")
        f.set("key", key)
        return f

    def entry(parent, key, value):
        e = ET.SubElement(parent, "entry")
        e.set("key", key)
        e.set("value", str(value))

    layers = folder(root, "Layers")
    for i, (p, role) in enumerate([(image_abs, "MainRole"), (seg_abs, "SegmentationRole")]):
        if p is None:
            continue
        lay = folder(layers, f"Layer[{i:03d}]")
        entry(lay, "AbsolutePath", p)
        entry(lay, "Role", role)
        entry(lay, "Tags", "")
    ET.ElementTree(root).write(path, encoding="utf-8", xml_declaration=True)


def qc_png(arr, mask, out_png, title):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    lo, hi = np.percentile(arr, 0.5), np.percentile(arr, 99.5)
    if mask is not None and mask.any():
        zs = np.where(mask.any(axis=(1, 2)))[0]
        if len(zs) > 6:
            zs = zs[np.linspace(0, len(zs) - 1, 6).astype(int)]
    else:
        zs = np.linspace(0, arr.shape[0] - 1, min(6, arr.shape[0])).astype(int)
    fig, axes = plt.subplots(1, len(zs), figsize=(3.2 * len(zs), 3.6))
    for ax, z in zip(np.atleast_1d(axes), zs):
        ax.imshow(arr[z], cmap="gray", vmin=lo, vmax=hi)
        if mask is not None and mask[z].any():
            ax.contour(mask[z], levels=[0.5], colors="r", linewidths=1.2)
        ax.set_title(f"slice {z}", fontsize=9)
        ax.axis("off")
    fig.suptitle(title, fontsize=11)
    fig.tight_layout()
    fig.savefig(out_png, dpi=90)
    plt.close(fig)


def run_nnunet(image_nii, model_dir, workdir):
    """Run nnU-Net v2 inference on a single case. Returns path to predicted mask."""
    ind = os.path.join(workdir, "in")
    outd = os.path.join(workdir, "out")
    os.makedirs(ind, exist_ok=True)
    os.makedirs(outd, exist_ok=True)
    shutil.copy(image_nii, os.path.join(ind, "CASE_0000.nii.gz"))
    cmd = ["nnUNetv2_predict", "-i", ind, "-o", outd, "-d", "001",
           "-c", "3d_fullres", "-f", "all", "--disable_tta"]
    env = dict(os.environ, nnUNet_results=model_dir)
    subprocess.run(cmd, check=True, env=env)
    return os.path.join(outd, "CASE.nii.gz")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("session", help="path to a session folder containing DICOM/")
    ap.add_argument("--out", default="results")
    ap.add_argument("--model", default=None,
                    help="nnU-Net results dir. Omit to run in prepare-only mode.")
    ap.add_argument("--series", default=None,
                    help="series number to use, if the session has several T2 axials")
    args = ap.parse_args()

    session = os.path.abspath(args.session)
    name = os.path.basename(session.rstrip("/"))
    os.makedirs(args.out, exist_ok=True)

    series = find_t2_axial_series(session)
    if not series:
        raise SystemExit(f"no T2w axial series found under {session}/DICOM/. "
                         "Expected SequenceName starting 'T2w FSE (axial'.")
    if args.series:
        series = [s for s in series
                  if os.path.basename(os.path.dirname(s)) == str(args.series)]
        if not series:
            raise SystemExit(f"series {args.series} is not a T2 axial series here")
    if len(series) > 1:
        print(f"note: {len(series)} T2 axial series found "
              f"({', '.join(os.path.basename(os.path.dirname(s)) for s in series)}); "
              f"using the last one. Override with --series.")
    sdir = series[-1]

    img = load_series(sdir)
    meta = dicom_meta(sdir)
    arr = sitk.GetArrayFromImage(img).astype(float)

    print(f"session      {name}")
    print(f"series       {os.path.basename(os.path.dirname(sdir))}  ({meta['sequence_name']})")
    print(f"mouse        {meta['mouse_from_dicom']}   scanned {meta['study_date']}")
    print(f"size         {img.GetSize()}")
    print(f"spacing      {tuple(round(x, 4) for x in img.GetSpacing())} mm "
          f"(thickness {meta['slice_thickness']}, gap "
          f"{meta['spacing_between_slices'] - meta['slice_thickness']:.2f})")
    print(f"voxel volume {np.prod(img.GetSpacing()):.7f} mm3")

    stem = os.path.join(args.out, name.replace(" ", "_"))
    image_nii = f"{stem}_T2ax.nii.gz"
    sitk.WriteImage(sitk.Cast(img, sitk.sitkFloat32), image_nii, True)

    mask_arr, seg_path, volume = None, None, None
    if args.model:
        with tempfile.TemporaryDirectory() as wd:
            pred = run_nnunet(image_nii, args.model, wd)
            m = sitk.ReadImage(pred)
            m = sitk.Cast(m > 0, sitk.sitkUInt8)
            m.CopyInformation(img)          # guarantee identical geometry
            assert_same_grid(m, img, "prediction")
            seg_path = f"{stem}_tumor.nii.gz"
            sitk.WriteImage(m, seg_path, True)
            mask_arr = sitk.GetArrayFromImage(m) > 0
            volume = tumor_volume_mm3(m)
        print(f"\ntumor volume {volume:.3f} mm3   "
              f"({int(mask_arr.sum())} voxels, "
              f"{int(mask_arr.reshape(mask_arr.shape[0], -1).any(1).sum())} slices)")
        if not mask_arr.any():
            print("  -> no tumor detected. For this study that is a meaningful "
                  "result, not a failure:\n     tumor-free scans are real and "
                  "concentrated in the treated arms.")
    else:
        print("\nprepare-only mode (no --model): wrote the converted scan, "
              "QC image and ITK-SNAP\nworkspace, but no mask.")

    png = f"{stem}_qc.png"
    title = f"{name}" + (f"   {volume:.2f} mm3" if volume is not None else "")
    qc_png(arr, mask_arr, png, title)

    ws = f"{stem}.itksnap"
    write_itksnap_workspace(ws, os.path.abspath(image_nii),
                            os.path.abspath(seg_path) if seg_path else None)
    with open(os.path.join(args.out, "Tumor label.txt"), "w") as fh:
        fh.write(LABEL_FILE)

    result = dict(session=name, series=os.path.basename(os.path.dirname(sdir)),
                  mouse_from_dicom=meta["mouse_from_dicom"],
                  study_date=meta["study_date"],
                  size=list(img.GetSize()), spacing=list(img.GetSpacing()),
                  voxel_volume_mm3=float(np.prod(img.GetSpacing())),
                  tumor_volume_mm3=volume,
                  tumor_present=bool(mask_arr.any()) if mask_arr is not None else None,
                  image=image_nii, mask=seg_path, qc=png, workspace=ws)
    with open(f"{stem}_result.json", "w") as fh:
        json.dump(result, fh, indent=2)

    print(f"\nwrote:\n  {image_nii}")
    if seg_path:
        print(f"  {seg_path}")
    print(f"  {png}\n  {ws}\n  {stem}_result.json")
    print(f"\nOpen {os.path.basename(ws)} in ITK-SNAP to inspect or correct the mask.")


if __name__ == "__main__":
    main()
