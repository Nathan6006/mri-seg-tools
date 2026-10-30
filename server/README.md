# The shared-workspace backend

Accounts, shared workspaces and per-reviewer annotation layers for the
browser tool in `../web`. Optional: the page still runs as a pure static
site with no server behind it, and falls back to browser storage when this
is not deployed.

## Running it locally

```bash
cd server
npm install
npm run migrate                                   # create the local database
npm run dev                                       # http://localhost:8787
npm run seed -- --user <name> --name "<Full Name>" --password <password>
```

`npm run dev` serves **both** the page and the API, with D1 and R2 emulated
on disk under `.wrangler/state`. Nothing is uploaded and no Cloudflare
account is touched. `npm run reset` wipes that state and re-migrates.

Seeding talks to `/api/auth/register`, so the server must already be running
and the account it makes is identical to one created through the sign-in
screen.

## Why one origin

The Worker serves the static page *and* `/api/*`. Splitting them would have
been tidier and would have broken two things silently:

- The page's CSP is `connect-src 'self'`. Same origin keeps that line — the
  one making "this page cannot phone anywhere else" enforced rather than
  promised — true and unchanged.
- The page is cross-origin isolated (COOP + COEP), which is the precondition
  for multi-threaded inference. A cross-origin fetch into an isolated page
  needs `Cross-Origin-Resource-Policy` on every response, and getting it
  wrong does not raise an error: a scan just starts taking minutes instead of
  seconds.

`web/_headers` is honoured by Workers static assets, so the headers file
stays the single source for both. **It is now a fourth place those headers
live**, alongside `web/_headers`, `web/serve.py` and `desktop/main.js`. If
inference drops to one thread after a hosting change, check
`crossOriginIsolated` in the console first.

## Each reviewer gets their own mask

A case does not have *a* mask. Every member of a workspace has their own
layer for every case, at `w/<ws>/c/<case>/u/<user>/mask`. Nothing in the API
can write to someone else's — it is a property of the URL space, not a rule
anyone has to remember.

This is not only about avoiding clobbering. A tool whose claim is that
automated outlines reproduce a result has to know which voxels a human
changed and which human changed them, and one shared mutable mask destroys
exactly that record. It also means two people independently outlining the
same scan yields an inter-rater agreement measurement as a by-product of
ordinary use, rather than as a separate exercise someone has to organise.

`auto_mask` is *not* per-user: it is what the model produced, it is the same
for everyone, and an edit never writes to it.

## Roles

| Role | Can |
|---|---|
| `owner` | everything, plus add and remove people |
| `editor` | outline, review, upload scans |
| `viewer` | look only |

A non-member gets **404**, not 403, for a workspace they are not in — being
told "forbidden" would confirm the id exists.

## Deploying

Not deployed yet. When it is:

```bash
wrangler d1 create mri-review            # paste database_id into wrangler.toml
wrangler r2 bucket create mri-review-blobs
npm run migrate:remote
npm run deploy
```

Check `web/model/` is populated first. The deploy ships the weights only if
that folder is present, and without them the tool silently falls back to the
stub predictor behind a banner — a working site that produces fake masks.

### What a deploy does to someone already using the tool

Nothing, and this was checked rather than assumed.

Results live in IndexedDB under database `mri-review`, keyed to the origin.
Publishing new static files replaces the page, never client storage, so the
bytes survive. The risks were about *reach*, not loss:

- **A sign-in wall would have orphaned existing work.** It would still be on
  disk and unreachable from the UI, which is the same thing to the person
  looking at it. So the page boots into local storage exactly as before, and
  signing in is a header button.
- **An IndexedDB version bump could destroy records.** `DB_VERSION` stays at
  1 and no store was restructured. Cloud state lives in D1 and R2, not in a
  second schema layered over the old one.
- **A tab open mid-edit loses unsaved strokes on reload.** True of any
  deploy; worth saying before one lands in the middle of someone's afternoon.

Verified in a browser: a case written to local storage, with its mask bytes
and volume, is byte-identical after switching to a cloud workspace and back.
The two stores never see each other.

## Costs

Free, with the measured headroom being storage: a 329-session study is about
800 MB against R2's 10 GB free allowance. Reads and writes land near 0.02%
of the free operation limits, and R2 charges nothing for egress, which is
the property that matters when the payload is imaging.
