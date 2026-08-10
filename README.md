# mri-seg-tools

Tooling for building a tumor-segmentation dataset from **preclinical (small-animal) MRI**
exported as DICOM, and for evaluating segmentation models on it honestly.

Written for an MR Solutions MRS3000 3 T scanner and T2-weighted fast spin echo, but most of
it applies to any anisotropic preclinical MRI study where masks were hand-drawn in
[ITK-SNAP](http://www.itksnap.org/).

This repo contains **tooling only**. No imaging data, no study metadata, no results.

## Why this exists

Loading a preclinical DICOM study and its hand-drawn masks is deceptively easy to get
wrong, and the failure mode is silent: the mask lands slightly off, or flipped, and every
volume you compute afterwards is quietly incorrect while looking completely plausible.

These scripts encode the checks that catch that.

## The gotchas it handles

**Several series share one `SeriesDescription`.** On our scanner, the T2 axial, the T2
coronal *and* the T1 axial are all labelled `MRI 'FSE26' Scan`. Slice count doesn't
separate them either — the T2 axial and T2 coronal both had 18 slices. The field that
works is `SequenceName` (0018,0024), which is VR `SH` and therefore truncated to 16
characters. Select on that, and never on position within the folder: repeat acquisitions
shift it.

**Slice thickness is not slice spacing.** Ours were 1.00 mm thick, spaced 1.10 mm apart —
a 0.10 mm gap. Volume must use the spacing. Using thickness underestimates every volume by
9%. Always cross-check `SliceThickness` against `SpacingBetweenSlices` *and* against the
actual step between consecutive `ImagePositionPatient` values.

**Never sort slices by `InstanceNumber` and stack them.** DICOM slices often run from high
z to low z as `InstanceNumber` increases, while the NIfTI mask has +z direction. A
hand-rolled stack is z-flipped relative to the mask — the lesion lands at the wrong end of
the animal, and Dice comes out near zero for a reason that is very hard to see.
`SimpleITK.ImageSeriesReader` sorts by `ImagePositionPatient` along the slice normal.
Use it.

**Point GDCM at the leaf directory.** `GetGDCMSeriesIDs()` must receive the directory that
directly contains the `.dcm` files. Aimed at a parent folder it reports `No Series were
found`, which reads like a corrupt-file problem and is not one. Preclinical DICOM is
usually perfectly standard; reach for `force=True` or a vendor-specific reader only after
you have ruled this out.

**Localizer series can have zero slice spacing** and will throw
`Zero-valued spacing is not supported`. Filter to your target sequence before loading.

**Verify with something external.** ITK-SNAP's *Volumes and Statistics* export gives voxel
count, volume, and mean/SD inside each label. If your loader reproduces all three exactly,
your geometry and your intensity rescaling are both right. That check is worth more than
any amount of staring at overlays.

## Contents

| File | What it does |
|---|---|
| `src/loader.py` | Canonical scan/mask loading. Series selection, geometry assertions, voxel volume. **Start here.** |
| `src/inventory.py` | Walks a study tree and reports every series' geometry, mask stats, and mismatches |
| `src/checksum_raw.py` | SHA-256 baseline over read-only raw data, so accidental writes are detectable |
| `src/qc_overlays.py` | Mask-contour overlays, plus deliberately blinded slice montages for quality scoring |
| `src/splits.py` | Subject-level, group-stratified train/test split and K folds |
| `src/export_nnunet.py` | nnU-Net v2 raw dataset, with custom folds that override nnU-Net's random ones |
| `src/evaluate.py` | Detection / overlap / volume-agreement metrics |
| `src/segment.py` | Single-scan tool: folder in, mask + volume + QC image + ITK-SNAP workspace out |
| `web/` | The review tool: a browser app that does all of the above with **no server**. See [web/README.md](web/README.md) |

## The browser tool

`web/` is a static site — `index.html` plus ES modules, no build step, no
dependencies, no backend. Point it at a folder of DICOM and it converts, runs a
model, computes volumes, renders QC images, and gives you a three-plane viewer
with a full mask editor: freehand, polygon, brush, adaptive brush, flood fill,
cut, ruler, shape-based slice interpolation, window/level, and undo across the
whole volume.

**Nothing is uploaded.** The DICOM is decoded and segmented inside the browser
tab, and `web/_headers` sets `connect-src 'self'` so the page is not permitted
to contact any other host. That is what makes it safe to host on a public URL:
the page is static and the data never leaves the machine it is already on.

```bash
python3 -m http.server 8000 --directory web     # then open localhost:8000
npx wrangler pages deploy web                   # or host it
```

It is a port of a Flask app, and the geometry is the part worth trusting:

* `web/test/parity.mjs` + `parity_check.py` compare the browser pipeline against
  SimpleITK on real scans — series discovery, geometry, every voxel, the written
  NIfTI read back, the signed distance transform against
  `SignedMaurerDistanceMap`, and connected components against
  `ConnectedComponent`. On a 20-session sweep **every voxel was identical as
  float32**, and every distance field exact.
* `web/test/run_selftest.py` runs 37 end-to-end checks in a real browser against
  synthetic DICOM it writes itself, so it needs no data and can be run anywhere:

  ```bash
  python3 web/test/run_selftest.py            # headless Chrome
  python3 web/test/run_selftest.py --serve    # any browser
  ```

Two limits worth knowing up front. A web page **cannot launch ITK-SNAP** — on
Chrome and Edge it shares a folder with it instead, via the File System Access
API, which gets the round trip down to two clicks; elsewhere it hands over a
zip. And results live in **IndexedDB**, so they are per-browser and per-machine
until you export them.

A trained network runs **in the tab**, as ONNX under onnxruntime-web — WebGPU
where it is available, WebAssembly everywhere else. Both 2D and 3D
configurations are supported, and a deployment can serve several and let the
user switch; only the one in use is downloaded. Weights are not in this repo:
they are a derivative of whatever imaging they were trained on, so publishing
them is the data owner's call, not a build step's. The tool loads them from
`web/model/` if a deployment serves it, or from a folder the user picks; with
neither it falls back to a deterministic stub and shows a permanent banner
saying the masks are synthetic.

The preprocessing around the network — normalise, pad, slide the window, mirror,
argmax — is the part that can be silently wrong, so it is written twice and
cross-checked. `web/test/run_onnx_parity.py` drives real scans through the
browser and compares them voxel by voxel against masks produced outside it.
**On the CPU backend the browser is exact.** The GPU backend differs by a
handful of boundary voxels, which is half-precision arithmetic rather than a
defect — so for numbers that go in a paper, use the command-line pipeline,
which is deterministic.

Two details in the 3D path are worth knowing if you port this. Window origins
are computed with round-half-to-even, which `Math.round` is not, and the
one-voxel shift that follows from getting it wrong is invisible. And the
Gaussian importance map that weights overlapping windows is exactly separable,
so the exporter ships three 1-D vectors rather than asking JavaScript to
reproduce `scipy.ndimage.gaussian_filter`.

## Three opinions baked in

**Split by subject, never by scan.** Longitudinal timepoints of the same animal look
nearly identical. A scan-level split puts the same animal on both sides and inflates every
metric. `splits.py` splits by subject and stratifies by study group.

**Empty masks can be real.** In a treatment study, "no lesion" is a meaningful result and
those scans are concentrated in the treated groups. A model that hallucinates a small
lesion in a responder erases the treatment effect — and that failure is invisible in a
Dice average. `evaluate.py` reports detection sensitivity and specificity separately, and
computes Dice **only over lesion-positive scans**. `dice()` returns `NaN` when both masks
are empty rather than 1.0, because scoring 1.0 rewards a model that predicts nothing
anywhere.

**Don't resample anisotropic data to isotropic.** Upsampling through-plane invents detail
that was never acquired.

## nnU-Net folds

`export_nnunet.py` writes a `splits_final.json` alongside the dataset. Copy it into
`nnUNet_preprocessed/<dataset>/` before training:

```bash
cp <dataset>/splits_final.json $nnUNet_preprocessed/<dataset>/
```

This is not optional. nnU-Net's default cross-validation splits by case — which for
longitudinal data means by scan — so the same subject lands in both train and validation.

## Usage

```bash
python -m venv .venv && .venv/bin/pip install pydicom SimpleITK numpy pandas matplotlib openpyxl

.venv/bin/python src/inventory.py                       # survey a study tree
.venv/bin/python src/checksum_raw.py write              # baseline the raw data
.venv/bin/python src/splits.py --test-size 8 --folds 5
.venv/bin/python src/export_nnunet.py
.venv/bin/python src/qc_overlays.py --mode both
.venv/bin/python src/segment.py SESSION_0001 --out results/
```

Study-specific values are configurable:

```bash
export STUDY_ARMS="Treated,Control"      # stratification groups for splits.py
export STUDY_NON_ARM="Excluded"          # a group that is not a real arm
```

`src/loader.py` has `T2_AXIAL_SEQUENCE_PREFIX` at the top — change it to whatever
`SequenceName` prefix identifies your target series.

### Expected manifest

`splits.py`, `export_nnunet.py` and `qc_overlays.py` read a `derived/manifest.csv` with one
row per imaging session. The columns they use:

```
session_id, mouse_id, arm, day_post_inoculation, image_path, mask_path,
n_slices, voxel_spacing, voxel_volume_mm3, mask_voxels, tumor_volume_mm3,
mask_grid_ok, tumor_present, qc_flag, usable_for_training, exclusion_reason
```

`image_path` points at a DICOM series directory; `mask_path` at a `.nii.gz`, or is empty
for a lesion-free scan. Building that file is study-specific — it depends entirely on how
your lab records which folder belongs to which animal — so the builder is not included
here.

## A note on scope

The manifest builder and metadata crosswalk from the original project are **not** in this
repo. They are welded to one lab's spreadsheet layout and encode specific corrections to
unpublished data, so they wouldn't be reusable and shouldn't be public. Everything here is
the part that generalizes.

For the same reason the code here is generalized rather than copied verbatim: study
names, animal and session identifiers, and measured volumes are stripped on the way in
by a script that then re-reads every file and refuses to publish if a single one
survived. If you find something that looks like it belongs to a specific study, that is
a bug — please open an issue.

## License

MIT. See [LICENSE](LICENSE).
