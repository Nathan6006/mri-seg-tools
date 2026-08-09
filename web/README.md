# The static build

The same review tool as `src/app.py`, with no Python and no server. It runs
entirely in the browser, so it can be put on a URL and handed to someone, and it
also runs from a folder on a laptop with nothing installed.

This exists for two reasons. The first is that it can be **shown to the lab
before there is a model** — the tool is the deliverable they will actually
touch, and their feedback is more useful now than after V1 is frozen. The
second is that `src/app.py` has no authentication, which is the one thing
blocking it from being hosted; this build removes the problem rather than
solving it, because there is nothing to authenticate to.

## Running it

It cannot be opened with `file://` — ES modules are blocked by the browser's
same-origin rules on local files, and `crypto.subtle` is unavailable outside a
secure context. Serve the folder instead:

```bash
cd <the repo root>
python3 -m http.server 8000 --directory web
# then open http://localhost:8000
```

`localhost` counts as a secure context, so everything works. Any static server
does — `npx serve web`, `caddy file-server`, whatever is to hand. There is no
build step and no dependencies: the files you edit are the files that run.

## Deploying it

**Cloudflare Pages**, from this repo:

```bash
npx wrangler pages deploy web --project-name mri-review
```

Or connect the repo in the Cloudflare dashboard with build command *(none)* and
output directory `web`.

Get the output directory right. With it set to `web`, Pages uploads `web/` and
nothing else. Set to `/` it would publish the entire repository, which is the
one configuration mistake here with real consequences.

`_headers` is read by Pages (and Netlify) and sets a strict Content-Security
-Policy. GitHub Pages ignores it, which is one reason to prefer Pages; the other
is that Pages supports Cloudflare Access, so the site can be put behind a Google
or email login in about two minutes without writing any auth code.


## What it does with your data: nothing leaves the machine

Scans are read, decoded and segmented **in the browser tab**. There is no
upload, no API call, and no analytics. `connect-src 'self'` in `_headers` means
the page is not permitted to talk to any other host, so this is enforced rather
than promised.

Results are kept in **IndexedDB**, which is per-browser and per-machine. This
is the real cost of having no server: results do not follow you to another
computer, and clearing site data deletes them.

### How long does that storage last?

Not one answer — four, and they differ enough that the app works out which one
applies and prints it in the header.

| | How long |
|---|---|
| Chrome / Edge, persistence granted | **Indefinitely.** Never evicted automatically; goes only when someone clears site data. This is what the app requests on startup, and Chrome grants it silently once the site has any engagement history. |
| Chrome / Edge, persistence refused | Until the disk gets tight, then origins are evicted least-recently-used. No warning, no time limit. |
| **Safari** | **About 7 days.** Safari's tracking prevention deletes all script-writable storage, IndexedDB included, after seven days of browsing without visiting the page. Asking for persistence does *not* exempt you; only adding the page to the Home Screen as a web app does. |
| Private / incognito, any browser | Gone when the window closes. |

Firefox behaves like Chrome but prompts the user rather than deciding
heuristically.

The Safari row is the one that actually catches people out — a reviewer who
comes back to a cohort a fortnight later finds it empty, with no warning and
nothing to do about it. If the lab uses Safari, either add the page to the Home
Screen or treat **Download all** as mandatory at the end of each session.

**Download all** writes a zip you control — masks, QC images, `volumes.csv`,
`results.json`. Nothing else here is a backup.

## What is different from the Flask build

| | `src/app.py` | this |
|---|---|---|
| Input | upload each folder to the server | read locally, nothing uploaded |
| Results | a folder on disk | IndexedDB in this browser |
| Open in ITK-SNAP | launches it with `subprocess` | writes to a shared folder, or a zip |
| Picking up corrections | re-reads the shared folder | same, on Chrome/Edge; else a file picker |
| Hosting | blocked: binds 127.0.0.1, no auth | just works |
| Segmenting 40 scans | server CPU, one long job | this tab, yields between scans |

Everything else is the same code: the three-plane viewer, the crosshair, the
editing tools, window/level, zoom, review priorities, correction tracking, the
keyboard shortcuts. That is the point of the port — the front end never
depended on there being a server, only on being handed a volume and a mask.

Two things genuinely cannot be carried over:

* **Launching ITK-SNAP.** A web page cannot start a program — that is the
  sandbox, and no flag changes it. See the next section for how close it gets.
* **Reading a folder by path.** `src/batch.py` is still the faster route for
  data already on this machine, and it always was.

## The ITK-SNAP round trip

`src/app.py` could call `subprocess.Popen(["itksnap", "-w", ws])` because it was
a Python process running as you. A page in a browser tab has no equivalent, so
*Open in ITK-SNAP* became *Download for ITK-SNAP*.

**On Chrome and Edge that is almost the same thing again.** Press
*ITK-SNAP folder…*, pick a directory once, and the page can read and write it:

1. *Download for ITK-SNAP* writes `<folder>/<case>/` — scan, both masks, QC
   image, workspace — with no zip and no unzipping.
2. Open the `.itksnap` workspace from that folder, correct the mask, save.
3. *Check folder for edits* reads the folder back and records the correction.

That is the Flask build's shared-results-folder behaviour, restored. Firefox and
Safari have not shipped `showDirectoryPicker`, so there the button hides itself
and the zip route is used instead — it works everywhere and always did.

An existing working mask in the folder is never overwritten by re-exporting a
case, and a mask that comes back byte-identical is a no-op: `corrected_at` does
not move. That second one matters because the folder is re-read in full on every
check, and a bump would rewrite the correction timestamp on every scan nobody
had touched.

**The workspace file is verified, not assumed.** `itksnap-wt -i <ws>
-layers-list` resolves both layers to real files when the workspace is opened
from the folder it sits in, and still resolves them after the whole folder is
moved elsewhere. Two notes from that testing:

* macOS does **not** register the `.itksnap` extension (its UTI is an
  unregistered `dyn.…`), so double-clicking does nothing until you set *Open
  With → ITK-SNAP* once. *File > Open Workspace* always works.
* `itksnap-wt` shipped in ITK-SNAP 4.x on macOS is linked against a Homebrew
  `libssh` that is not bundled, and its hardened runtime then refuses the
  Homebrew copy for having a different Team ID. To run it: `brew install
  libssh`, copy the binary somewhere writable, and `codesign --force --sign -`
  it. Only needed to re-verify workspaces; nothing in the tool depends on it.

## The model

Still `StubPredictor`, and the orange banner says so. **The stub's masks are
synthetic** — derived from a hash of the voxels, unrelated to where the tumour
is. They exist so the tool can be built and tested before a model exists.

Note that the web stub and the Python stub draw *different* fake tumours for
the same scan. The hash inputs are identical and the voxel decode is verified
bit-identical, but the two use different random number generators, and
reproducing numpy's PCG64 in JavaScript would make two throwaway fake models
agree while proving nothing. What has to agree between the two tools is the
geometry, the voxels and the mm³, and that is tested directly (see below).

When fold 0 is trained, `OnnxPredictor` in `lib/predictor.js` is the place it
goes — export the checkpoint to ONNX and run it with onnxruntime-web. Nothing
outside that file changes.

## Tests

Two suites, both worth running after any change to `lib/`.

**Against SimpleITK, on real scans.** Proves the browser reads a scan the way
the validated Python pipeline does:

```bash
node web/test/parity.mjs --sweep 20
.venv/bin/python web/test/parity_check.py
```

Checks series discovery, geometry, every voxel, the written NIfTI as SimpleITK
reads it back, the signed distance transform against
`SignedMaurerDistanceMap`, and connected components against
`ConnectedComponent`. Last run: **20 sessions, every voxel identical as
float32, every distance field exact to 0.00e+00.**

**In a real browser, on synthetic scans.** Proves the whole thing works end to
end, including the parts node cannot run — IndexedDB, canvas, the real
`index.html`:

```bash
.venv/bin/python web/test/run_selftest.py            # headless Chrome
.venv/bin/python web/test/run_selftest.py --serve    # open it in any browser
```

34 checks, from gzip to zip export. It builds its own DICOM files
(`test/fixture.js`) so it involves no lab data and is safe to run anywhere —
including with `--serve` on the machine of anyone who wants to know whether
their browser is supported.

The fixture deliberately writes `InstanceNumber` running *opposite* to +z,
which is how the real scanner writes it. A fixture where the two agreed would
pass whether or not the loader sorts slices correctly, which is the single most
consequential thing this code does.

## Layout

```
web/
├── index.html          the page: markup and styles
├── app.js              the viewer, editor and review flow
├── _headers            CSP and friends, for Cloudflare Pages
└── lib/
    ├── dicom.js        DICOM parser, this scanner's dialect only
    ├── volume.js       series -> volume, and the geometry rules
    ├── nifti.js        NIfTI-1 read/write, matching SimpleITK's output
    ├── gz.js           gzip via CompressionStream, plus a ZIP writer
    ├── edt.js          exact distance transform, for interpolation
    ├── label.js        6-connected components
    ├── predictor.js    StubPredictor, review priority, OnnxPredictor
    ├── qc.js           the slice montage
    ├── pipeline.js     port of src/batch.py
    ├── store.js        IndexedDB
    ├── fsaccess.js     the shared ITK-SNAP folder (Chrome/Edge only)
    └── backend.js      what app.js calls instead of fetch()
```

## What this does NOT replace

`web/` replaces one thing: `src/app.py` and its front end. The rest of `src/`
is the research pipeline and is not duplicated anywhere.

* `src/loader.py` is imported by **eleven** other scripts — the manifest, the
  crosswalk, splits, the nnU-Net export, QC overlays, the labelled dataset, the
  evaluation protocol, the intra-rater set, the inventory, the checksums and the
  prune. Deleting it deletes the project.
* `src/batch.py` is the CLI, and the invariant is that anything the UI can do is
  also reachable from a script. It is also how inference will be run over all
  193 scans for the paper — a browser is for reviewing 40 scans, not for a
  reproducible batch run.
* `src/evaluate.py` is the metric protocol the paper's numbers come from.
* `src/app.py` and `src/templates/app.html` are the only genuinely duplicated
  files. `app.html` is the source this port was made from, and `src/app.py` is
  still the only way to run over a local folder without copying anything into a
  browser. Worth keeping at least until the lab has actually used this build.
