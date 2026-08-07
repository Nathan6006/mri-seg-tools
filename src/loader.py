#!/usr/bin/env python3
"""
Canonical loader for the preclinical MRI segmentation project.

Every downstream script must load scans through here. The geometry rules are
subtle and getting them wrong is silent: the mask lands in the wrong place and
all volumes are quietly incorrect.

Key facts this module encodes (all verified against the raw data):

  * A session folder holds SEVERAL DICOM series. SeriesDescription is
    "MRI 'FSE26' Scan" for the T2 axial, the T2 coronal AND the T1 axial, so it
    cannot be used to pick the right one. SequenceName (0018,0024) can:
    "T2w FSE (axial,n" is the stack that gets segmented.
  * Series are stored as DICOM/<series_no>/1/*.dcm. Series numbers ascend with
    acquisition time, so when a session has repeat T2 axial scans (a redo), the
    highest series number is the last acquisition.
  * SliceThickness is 1.00 mm but SpacingBetweenSlices is 1.10 mm: there is a
    0.10 mm gap. Volume must use 1.10, which is what SimpleITK reports and what
    ITK-SNAP used for the manual volumes.
  * DICOM slices run from high z to low z with InstanceNumber, while the mask
    NIfTI has +z direction. Never sort slices yourself by InstanceNumber and
    stack them; SimpleITK's ImageSeriesReader sorts by ImagePositionPatient
    along the slice normal and produces a volume that matches the mask.
  * SimpleITK applies RescaleSlope/RescaleIntercept automatically.
"""
from __future__ import annotations

import glob
import os

import numpy as np
import pydicom
import SimpleITK as sitk

T2_AXIAL_SEQUENCE_PREFIX = "T2w FSE (axial"


def sequence_name_of(series_dir: str) -> str:
    """SequenceName (0018,0024) of a series directory, or '' if not readable."""
    files = glob.glob(os.path.join(series_dir, "*.dcm"))
    if not files:
        return ""
    h = pydicom.dcmread(sorted(files)[0], stop_before_pixels=True)
    return str(getattr(h, "SequenceName", ""))


def find_t2_axial_series(session_dir: str) -> list[str]:
    """All T2-axial series directories in a session, ordered by series number."""
    hits = [sdir for sdir in glob.glob(os.path.join(session_dir, "DICOM", "*", "*"))
            if os.path.isdir(sdir)
            and sequence_name_of(sdir).startswith(T2_AXIAL_SEQUENCE_PREFIX)]
    return sorted(hits, key=lambda p: int(os.path.basename(os.path.dirname(p))))


def load_series(series_dir: str) -> sitk.Image:
    """Load one DICOM series directory as a geometry-correct SimpleITK image."""
    reader = sitk.ImageSeriesReader()
    ids = reader.GetGDCMSeriesIDs(series_dir)
    if not ids:
        raise RuntimeError(f"no DICOM series found in {series_dir}")
    if len(ids) > 1:
        raise RuntimeError(f"{len(ids)} series share one directory: {series_dir}")
    reader.SetFileNames(reader.GetGDCMSeriesFileNames(series_dir, ids[0]))
    return reader.Execute()


def load_mask(mask_path: str, reference: sitk.Image | None = None) -> sitk.Image:
    """Load a segmentation NIfTI, optionally asserting it matches `reference`."""
    m = sitk.ReadImage(mask_path)
    if reference is not None:
        assert_same_grid(m, reference, mask_path)
    return m


def assert_same_grid(a: sitk.Image, b: sitk.Image, what: str = "") -> None:
    """Raise unless two images sit on exactly the same voxel grid."""
    problems = []
    if a.GetSize() != b.GetSize():
        problems.append(f"size {a.GetSize()} != {b.GetSize()}")
    if not np.allclose(a.GetSpacing(), b.GetSpacing(), atol=1e-4):
        problems.append(f"spacing {a.GetSpacing()} != {b.GetSpacing()}")
    if not np.allclose(a.GetOrigin(), b.GetOrigin(), atol=1e-3):
        problems.append(f"origin {a.GetOrigin()} != {b.GetOrigin()}")
    if not np.allclose(a.GetDirection(), b.GetDirection(), atol=1e-3):
        problems.append(f"direction {a.GetDirection()} != {b.GetDirection()}")
    if problems:
        raise ValueError(f"grid mismatch {what}: " + "; ".join(problems))


def voxel_volume_mm3(img: sitk.Image) -> float:
    """Volume of one voxel. Uses SpacingBetweenSlices (1.10), not thickness."""
    return float(np.prod(img.GetSpacing()))


def tumor_volume_mm3(mask: sitk.Image) -> float:
    a = sitk.GetArrayFromImage(mask)
    return float((a > 0).sum() * voxel_volume_mm3(mask))


def dicom_meta(series_dir: str) -> dict:
    """Selected metadata from the first slice of a series."""
    f = sorted(glob.glob(os.path.join(series_dir, "*.dcm")))[0]
    h = pydicom.dcmread(f, stop_before_pixels=True)
    return {
        "mouse_from_dicom": str(getattr(h, "PatientName", "")),
        "session_from_dicom": str(getattr(h, "PatientID", "")),
        "sex": str(getattr(h, "PatientSex", "")),
        "weight": str(getattr(h, "PatientWeight", "")),
        "study_date": str(getattr(h, "StudyDate", "")),
        "series_time": str(getattr(h, "SeriesTime", "")),
        "sequence_name": str(getattr(h, "SequenceName", "")),
        "slice_thickness": float(h.SliceThickness),
        "spacing_between_slices": float(getattr(h, "SpacingBetweenSlices", 0) or 0),
        "TR": float(h.RepetitionTime),
        "TE": float(h.EchoTime),
    }
