#!/usr/bin/env python3
"""
Full inventory of the preclinical MRI segmentation project folder.

Walks every session folder, finds the T2w axial DICOM series, finds the
segmentation NIfTI, checks that they sit on the same voxel grid, and computes
tumor volume. Writes derived/inventory_raw.csv.

Read-only with respect to the raw study data.

Usage:  .venv/bin/python src/inventory.py
"""
from __future__ import annotations

import glob
import os
import re
import sys
import warnings
import xml.etree.ElementTree as ET

import numpy as np
import pandas as pd
import pydicom
import SimpleITK as sitk

warnings.filterwarnings("ignore")

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "derived")

# The scanner writes SeriesDescription == "MRI 'FSE26' Scan" for the T2 axial,
# the T2 coronal AND the T1 axial. The only field that separates them is
# SequenceName (0018,0024), which is VR SH so it is truncated to 16 chars:
#   "T2w FSE (axial,n"   <- the stack we segment
#   "T2w FSE (cor,n)"
#   "T1w FSE (axial,n"
T2_AXIAL_PREFIX = "T2w FSE (axial"

SESSION_RE = re.compile(r"^(\d{3,4})(?:\s+(.*))?$")


def parse_folder_name(name: str) -> dict:
    """'SESSION_0001' -> session_id, mouse_label, sex, day_label, flags."""
    m = SESSION_RE.match(name)
    if not m:
        return {}
    session_id, rest = m.group(1), (m.group(2) or "")
    tokens = rest.split()
    out = {"session_id": session_id, "folder_suffix": rest, "flags": ""}
    flags = [t for t in tokens if t.upper() in ("FAILED", "REDO", "REDONE")]
    out["flags"] = ",".join(f.upper() for f in flags)
    for t in tokens:
        if t.lower() in ("male", "female"):
            out["sex_folder"] = t.capitalize()
        elif re.fullmatch(r"d\d+", t.lower()):
            out["day_folder"] = int(t[1:])
        elif re.fullmatch(r"\d{3}[NLR]\d?", t.upper()):
            out["mouse_folder"] = t.upper()
    return out


def series_dirs(session_dir: str):
    """DICOM/<seriesno>/1/ directories holding .dcm files."""
    return sorted(glob.glob(os.path.join(session_dir, "DICOM", "*", "*")))


def read_series_meta(d: str) -> dict | None:
    files = sorted(glob.glob(os.path.join(d, "*.dcm")))
    if not files:
        return None
    heads = []
    for f in files:
        try:
            heads.append(pydicom.dcmread(f, stop_before_pixels=True))
        except Exception:
            pass
    if not heads:
        return None
    heads.sort(key=lambda h: int(getattr(h, "InstanceNumber", 0)))
    h = heads[0]
    ipp = np.array([[float(v) for v in x.ImagePositionPatient] for x in heads])
    step = None
    if len(ipp) > 1:
        d3 = np.diff(ipp, axis=0)
        step = float(np.median(np.linalg.norm(d3, axis=1)))
    return {
        "dir": d,
        "series_folder": os.path.basename(os.path.dirname(d)),
        "n_files": len(files),
        "series_desc": str(getattr(h, "SeriesDescription", "")),
        "sequence_name": str(getattr(h, "SequenceName", "")),
        "rows": int(h.Rows),
        "cols": int(h.Columns),
        "pixel_spacing": [float(v) for v in h.PixelSpacing],
        "slice_thickness": float(h.SliceThickness),
        "spacing_between": float(getattr(h, "SpacingBetweenSlices", 0) or 0),
        "ipp_step": step,
        "iop": [float(v) for v in h.ImageOrientationPatient],
        "ipp_first": ipp[0].tolist(),
        "ipp_last": ipp[-1].tolist(),
        "patient_name": str(getattr(h, "PatientName", "")),
        "patient_id": str(getattr(h, "PatientID", "")),
        "sex": str(getattr(h, "PatientSex", "")),
        "weight": str(getattr(h, "PatientWeight", "")),
        "study_date": str(getattr(h, "StudyDate", "")),
        "series_time": str(getattr(h, "SeriesTime", "")),
        "TR": float(h.RepetitionTime),
        "TE": float(h.EchoTime),
        "protocol": str(getattr(h, "ProtocolName", "")),
        "study_desc": str(getattr(h, "StudyDescription", "")),
    }


def load_dicom_volume(d: str) -> sitk.Image:
    """Load a DICOM series directory as a SimpleITK image (geometry-correct)."""
    r = sitk.ImageSeriesReader()
    ids = r.GetGDCMSeriesIDs(d)
    if not ids:
        raise RuntimeError(f"no GDCM series in {d}")
    if len(ids) > 1:
        raise RuntimeError(f"{len(ids)} series in one folder: {d}")
    r.SetFileNames(r.GetGDCMSeriesFileNames(d, ids[0]))
    return r.Execute()


def geom(img: sitk.Image) -> dict:
    return {
        "size": tuple(img.GetSize()),
        "spacing": tuple(round(x, 5) for x in img.GetSpacing()),
        "origin": tuple(round(x, 3) for x in img.GetOrigin()),
        "direction": tuple(round(x, 3) for x in img.GetDirection()),
    }


def parse_itksnap(path: str) -> dict:
    """Return {role: absolute_path} from an ITK-SNAP .itksnap workspace file."""
    out = {}
    try:
        tree = ET.parse(path)
    except Exception:
        return out
    # Structure: nested <folder>s of <entry key=... value=.../>. Each layer
    # folder holds both an "AbsolutePath" and a "Role" entry somewhere under it.
    for folder in tree.iter("folder"):
        entries = {e.get("key"): e.get("value") for e in folder.findall("entry")}
        if "AbsolutePath" in entries and "Role" in entries:
            out.setdefault(entries["Role"], []).append(entries["AbsolutePath"])
    return out


def parse_volume_txt(path: str) -> dict:
    """ITK-SNAP 'Volumes and statistics' export -> {label_id: (n_vox, mm3)}."""
    out = {}
    try:
        with open(path) as fh:
            lines = fh.read().splitlines()
    except Exception:
        return out
    for ln in lines[1:]:
        parts = ln.split("\t")
        if len(parts) < 4:
            continue
        try:
            out[int(parts[0])] = (int(parts[2]), float(parts[3]))
        except ValueError:
            continue
    return out


def main():
    sessions = sorted(
        p for p in os.listdir(ROOT)
        if os.path.isdir(os.path.join(ROOT, p)) and SESSION_RE.match(p)
    )
    rows = []
    for name in sessions:
        sdir = os.path.join(ROOT, name)
        rec = {"folder": name}
        rec.update(parse_folder_name(name))

        # ---- DICOM series ----
        metas = [m for m in (read_series_meta(d) for d in series_dirs(sdir)) if m]
        rec["n_series"] = len(metas)
        rec["series_summary"] = "; ".join(
            f"{m['series_folder']}:{m['sequence_name']}:{m['n_files']}" for m in metas
        )
        t2 = [m for m in metas if m["sequence_name"].startswith(T2_AXIAL_PREFIX)]
        rec["n_t2ax_series"] = len(t2)
        if t2:
            m = t2[-1]  # if repeated, the last acquired is the keeper
            rec.update({
                "t2_series_folder": m["series_folder"],
                "t2_dir": os.path.relpath(m["dir"], ROOT),
                "n_slices": m["n_files"],
                "rows": m["rows"], "cols": m["cols"],
                "px_r": m["pixel_spacing"][0], "px_c": m["pixel_spacing"][1],
                "slice_thickness": m["slice_thickness"],
                "spacing_between": m["spacing_between"],
                "ipp_step": m["ipp_step"],
                "patient_name": m["patient_name"], "patient_id": m["patient_id"],
                "sex_dicom": m["sex"], "weight_dicom": m["weight"],
                "study_date": m["study_date"], "series_time": m["series_time"],
                "study_desc": m["study_desc"], "protocol": m["protocol"],
                "TR": m["TR"], "TE": m["TE"],
            })
            try:
                img = load_dicom_volume(m["dir"])
                g = geom(img)
                rec["t2_size"] = str(g["size"])
                rec["t2_spacing"] = str(g["spacing"])
                rec["t2_origin"] = str(g["origin"])
                rec["t2_direction"] = str(g["direction"])
            except Exception as e:
                rec["t2_load_error"] = str(e)[:120]

        # ---- segmentation NIfTI ----
        niis = sorted(glob.glob(os.path.join(sdir, "*.nii.gz"))) + \
               sorted(glob.glob(os.path.join(sdir, "*.nii")))
        rec["n_nifti"] = len(niis)
        rec["nifti_names"] = ";".join(os.path.basename(p) for p in niis)
        mask_path = None
        for p in niis:
            if os.path.basename(p).lower().endswith(".nii.gz"):
                mask_path = p
                break
        if mask_path is None and niis:
            mask_path = niis[0]
        if mask_path:
            rec["mask_path"] = os.path.relpath(mask_path, ROOT)
            try:
                mi = sitk.ReadImage(mask_path)
                a = sitk.GetArrayFromImage(mi)
                u = np.unique(a)
                g = geom(mi)
                sp = mi.GetSpacing()
                rec.update({
                    "mask_size": str(g["size"]), "mask_spacing": str(g["spacing"]),
                    "mask_origin": str(g["origin"]), "mask_direction": str(g["direction"]),
                    "mask_dtype": str(a.dtype), "mask_n_unique": len(u),
                    "mask_labels": ",".join(str(int(x)) for x in u[:8]),
                    "mask_voxels": int((a > 0).sum()),
                    "mask_frac_zero": float(np.mean(a == 0)),
                    "voxel_mm3": float(np.prod(sp)),
                    "tumor_volume_mm3": float((a > 0).sum() * np.prod(sp)),
                    "mask_slices_with_tumor": int((a.reshape(a.shape[0], -1) > 0).any(1).sum()),
                })
                if "t2_size" in rec:
                    rec["geom_match_t2"] = (
                        rec["mask_size"] == rec["t2_size"]
                        and rec["mask_spacing"] == rec["t2_spacing"]
                        and rec["mask_origin"] == rec["t2_origin"]
                        and rec["mask_direction"] == rec["t2_direction"]
                    )
                # which DICOM series does this mask's grid actually match?
                matches = []
                for mm in metas:
                    try:
                        gi = geom(load_dicom_volume(mm["dir"]))
                    except Exception:
                        continue
                    if (str(gi["size"]) == rec["mask_size"]
                            and str(gi["spacing"]) == rec["mask_spacing"]
                            and str(gi["origin"]) == rec["mask_origin"]):
                        matches.append(f"{mm['series_folder']}({mm['sequence_name']})")
                rec["mask_grid_matches_series"] = ";".join(matches)
            except Exception as e:
                rec["mask_load_error"] = str(e)[:120]

        # ---- ITK-SNAP workspace: what did the annotator actually open? ----
        ws = sorted(glob.glob(os.path.join(sdir, "*.itksnap")))
        if ws:
            roles = parse_itksnap(ws[0])
            rec["itksnap_file"] = os.path.basename(ws[0])
            for role, paths in roles.items():
                rec[f"ws_{role}"] = ";".join(
                    "/".join(p.rstrip("/").split("/")[-4:]) for p in paths
                )

        # ---- ITK-SNAP volume export (.txt) ----
        txts = [p for p in glob.glob(os.path.join(sdir, "*.txt"))]
        for p in txts:
            vals = parse_volume_txt(p)
            if 1 in vals:
                rec["itksnap_txt"] = os.path.basename(p)
                rec["itksnap_n_voxels"] = vals[1][0]
                rec["itksnap_volume_mm3"] = vals[1][1]
                if 0 in vals:
                    rec["itksnap_total_voxels"] = vals[0][0] + vals[1][0]
                break

        rows.append(rec)
        print(f"  {name}", flush=True)

    df = pd.DataFrame(rows)
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, "inventory_raw.csv")
    df.to_csv(path, index=False)
    print(f"\nwrote {path}  ({len(df)} sessions, {len(df.columns)} columns)")


if __name__ == "__main__":
    main()
