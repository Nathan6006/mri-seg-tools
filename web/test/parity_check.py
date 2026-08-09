#!/usr/bin/env python3
"""
The SimpleITK half of the browser-pipeline parity test.

Reads what `node web/test/parity.mjs` recorded, loads the same sessions through
`src/loader.py`, and compares. Anything that disagrees is printed with the
actual numbers, because "geometry mismatch" on its own is useless -- what you
need to see is 1.10 against 1.00.

    node web/test/parity.mjs
    .venv/bin/python web/test/parity_check.py
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import warnings

import numpy as np
import SimpleITK as sitk

warnings.filterwarnings("ignore")

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "src"))

# The study data is not in this repo. Look beside it, or wherever MRI_RAW says.
RAW = os.environ.get("MRI_RAW") or next(
    (p for p in (os.path.join(ROOT, "raw"), os.path.join(ROOT, "..", "raw"))
     if os.path.isdir(p)), os.path.join(ROOT, "raw"))
from loader import find_t2_axial_series, load_series  # noqa: E402

OUT = os.environ.get("PARITY_OUT",
                    os.path.join(tempfile.gettempdir(), "mri-parity"))

# Voxel values are float32 on the JS side (which is what src/batch.py writes
# too) against float64 from SimpleITK, and GDCM's rescale arithmetic is not
# bit-identical to numpy's -- it differs around the 1e-13 mark on values in the
# thousands. So voxels are compared as float32, exactly, after casting both.
ATOL_SPACING = 1e-6
ATOL_ORIGIN = 1e-4
ATOL_DIRECTION = 1e-6


def fail(msg: str) -> None:
    print(f"    FAIL  {msg}")


def check_numerics() -> int:
    """
    The two numeric ports that reading a scan does not exercise: the signed
    distance transform behind slice interpolation, and connected-component
    labelling behind `n_components`.
    """
    path = os.path.join(OUT, "js_numerics.json")
    if not os.path.exists(path):
        print("\nno js_numerics.json -- skipping the numeric checks")
        return 0
    data = json.load(open(path))
    problems = 0

    print("\nsigned distance transform (vs SignedMaurerDistanceMap)")
    for name, s in data["sdf"].items():
        nx, ny = s["nx"], s["ny"]
        m = np.array(s["mask"], np.uint8).reshape(ny, nx)
        js = np.array(s["d"], np.float32).reshape(ny, nx)
        d = sitk.SignedMaurerDistanceMap(sitk.GetImageFromArray(m),
                                         insideIsPositive=False,
                                         squaredDistance=False,
                                         useImageSpacing=False)
        py = sitk.GetArrayFromImage(d).astype(np.float32)
        # float32 against ITK's float64 accumulation: last-bit agreement is not
        # expected, but anything above 1e-5 voxels would be a different formula.
        err = float(np.abs(py - js).max())
        if err > 1e-5:
            fail(f"{name}: max difference {err:.6g} voxels")
            problems += 1
        else:
            print(f"    ok    {name:<10} max difference {err:.2e} voxels")

    print("\nconnected components (vs ConnectedComponent, fullyConnected=False)")
    cc = data["cc"]
    vol = np.array(cc["mask"], np.uint8).reshape(cc["nz"], cc["ny"], cc["nx"])
    lab = sitk.ConnectedComponent(sitk.GetImageFromArray(vol))
    stats = sitk.LabelShapeStatisticsImageFilter()
    stats.Execute(lab)
    py_sizes = sorted(stats.GetNumberOfPixels(l) for l in stats.GetLabels())
    if py_sizes != cc["sizes"]:
        fail(f"component sizes {py_sizes} vs js {cc['sizes']}")
        problems += 1
    else:
        print(f"    ok    {len(py_sizes)} components, sizes {py_sizes}")
        # The corner-touching pair is the whole point of this fixture: if the
        # port had used 26-connectivity it would report one component here.
        if len(py_sizes) < 3:
            fail("the fixture should produce 3 components (two corner-touching "
                 "blocks plus a lone voxel) -- it did not, so this check proves "
                 "nothing about connectivity")
            problems += 1
    return problems


def main() -> int:
    report_path = os.path.join(OUT, "js_report.json")
    if not os.path.exists(report_path):
        raise SystemExit(f"no {report_path} -- run `node web/test/parity.mjs` first")
    report = json.load(open(report_path))

    problems = 0
    for row in report:
        name = row["session"]
        print(f"\n{name}")
        session_dir = os.path.join(RAW, name)

        found = find_t2_axial_series(session_dir)
        py_series = [int(os.path.basename(os.path.dirname(s))) for s in found]
        if py_series != row["seriesNumbers"]:
            fail(f"series discovery differs: python {py_series} vs js "
                 f"{row['seriesNumbers']}")
            problems += 1
        else:
            print(f"    ok    found the same {len(py_series)} T2 axial series")

        img = load_series(found[-1])
        if str(row["chosenSeries"]) != os.path.basename(os.path.dirname(found[-1])):
            fail(f"chose a different series: js {row['chosenSeries']} vs python "
                 f"{os.path.basename(os.path.dirname(found[-1]))}")
            problems += 1

        # --- geometry ------------------------------------------------------
        if list(img.GetSize()) != row["size"]:
            fail(f"size {img.GetSize()} vs {row['size']}")
            problems += 1
        if not np.allclose(img.GetSpacing(), row["spacing"], atol=ATOL_SPACING):
            fail(f"spacing {img.GetSpacing()} vs {row['spacing']}")
            problems += 1
        if not np.allclose(img.GetOrigin(), row["origin"], atol=ATOL_ORIGIN):
            fail(f"origin {img.GetOrigin()} vs {row['origin']}")
            problems += 1
        if not np.allclose(img.GetDirection(), row["direction"], atol=ATOL_DIRECTION):
            fail(f"direction {img.GetDirection()} vs {row['direction']}")
            problems += 1
        print(f"    ok    size {img.GetSize()}  spacing "
              f"{tuple(round(s, 5) for s in img.GetSpacing())}  "
              f"voxel {np.prod(img.GetSpacing()):.7f} mm3")

        # --- voxels --------------------------------------------------------
        py = sitk.GetArrayFromImage(img).astype(np.float32)
        js = sitk.GetArrayFromImage(sitk.ReadImage(row["niiPath"])).astype(np.float32)
        if py.shape != js.shape:
            fail(f"array shape {py.shape} vs {js.shape}")
            problems += 1
        else:
            same = np.array_equal(py, js)
            diff = np.abs(py.astype(np.float64) - js.astype(np.float64))
            if same:
                print(f"    ok    all {py.size:,} voxels identical as float32")
            else:
                n = int((py != js).sum())
                rel = diff.max() / max(float(np.abs(py).max()), 1e-9)
                # A handful of last-bit differences is GDCM vs plain double
                # arithmetic on the rescale, not a decoding error. Anything
                # bigger means the pixels themselves were read differently.
                if rel < 1e-6:
                    print(f"    ok    {n:,}/{py.size:,} voxels differ in the last "
                          f"float32 bit (max {diff.max():.3e}, relative "
                          f"{rel:.2e}) -- rescale rounding, not a decode error")
                else:
                    fail(f"{n:,} voxels differ, max {diff.max():.6g} "
                         f"(relative {rel:.3e})")
                    problems += 1

        # --- the file ITK-SNAP will open ------------------------------------
        js_img = sitk.ReadImage(row["niiPath"])
        for what, a, b, atol in [
            ("size", js_img.GetSize(), img.GetSize(), 0),
            ("spacing", js_img.GetSpacing(), img.GetSpacing(), ATOL_SPACING),
            ("origin", js_img.GetOrigin(), img.GetOrigin(), ATOL_ORIGIN),
            ("direction", js_img.GetDirection(), img.GetDirection(), ATOL_DIRECTION),
        ]:
            ok = (list(a) == list(b)) if atol == 0 else np.allclose(a, b, atol=atol)
            if not ok:
                fail(f"NIfTI written by JS has {what} {a}, SimpleITK reads the "
                     f"scan as {b}")
                problems += 1
        print("    ok    SimpleITK reads the JS-written NIfTI on the same grid")

    problems += check_numerics()

    print(f"\n{'=' * 62}")
    if problems:
        print(f"{problems} problem(s). The browser pipeline does NOT match "
              f"SimpleITK. Do not use it for real volumes until it does.")
        return 1
    print("Browser pipeline matches SimpleITK on every session checked.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
