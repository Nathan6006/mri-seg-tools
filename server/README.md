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


## Who can use the shared storage

Anyone may register. Only **approved** accounts can open a shared workspace;
everyone else gets the full tool with results in their own browser, exactly
as it worked before accounts existed. That boundary exists because shared
storage is billed to one person's card, so access is granted rather than
claimed.

The **first account to register becomes the administrator** and is approved
automatically — somebody has to be able to approve the second person, and a
username hardcoded in config would need a redeploy before anyone could sign
in at all. After that, Workspaces → Accounts approves, revokes and promotes.

Revoking does **not** delete anyone's work. Their masks stay in the
workspace, which is what the study needs; it only stops them opening it.
Removing data is a separate, deliberate act in the Files panel.

## The storage cap

R2 has no spend limit and Cloudflare will not add one, so the cap is
enforced here instead. It works because the Worker is the only holder of
bucket credentials: nothing else can write a byte, so a check in front of
every write is a real ceiling rather than an alert after the money is gone.
The check runs **before** the R2 put — a write that lands and is then rolled
back has already been stored and already counts.

Default ceiling is **9 GiB against R2's 10 GB free tier**. The headroom is
deliberate: R2 bills on a monthly average and rounds up, deletes take a
moment to stop counting, and a cap sitting exactly on the free tier would
bill for the rounding. Adjustable in Accounts without a redeploy.

| Level | At | What happens |
|---|---|---|
| warn | 75% | banner in the Workspaces and Files panels |
| critical | 90% | stronger banner naming the remaining space |
| full | 100% | uploads refused with HTTP 507 and an actionable message |

Usage is a SUM over the rows that own blobs, not a running counter. A
counter is faster and is wrong the first time a delete half-fails — and it
drifts toward under-counting, which is the direction that costs money. It
can still disagree with what R2 actually holds; **Accounts → Check storage**
compares the two. That reports drift rather than "fixing" it, because the
two ways drift happens need opposite repairs: an object with no row is
garbage, a row with no object is a failed upload to redo. Deciding that
automatically is how a reconciler deletes someone's data.

## The Files panel

Workspaces → Files. Sorted largest-first by default, because the reason to
open it under pressure is to find what to delete.

Navigable the way the worklist is — `↑` `↓` move, `space` selects, `del`
deletes, `esc` closes — because the reviewer this was built for singled out
clicking between scans as the thing he liked, and a panel that only takes a
mouse would be a step down from what sits next to it. Each row shows a size
bar relative to the largest item, a breakdown by file kind, whose mask
layers exist, and who added it. The delete button names what will be freed
before it is pressed, and the confirmation says how many other people's
layers go with it.

## Costs, and what happens when something runs out

Free at this scale, but the three services fail in **two different ways**,
and the difference is the thing to know.

| | Free allowance | Current use | Over the line |
|---|---|---|---|
| R2 — scans and masks | 10 GB, egress free | ~800 MB for a 329-session study | **billed**, $0.015/GB-month |
| D1 — accounts, metadata | 500 MB per database (5 GB/account), 5M row reads + 100k row writes a day | a few MB; ~1,000 writes to import a whole study | **blocked**, queries error |
| Workers — the API | 100k requests/day | a few thousand per reviewer per pass | **blocked**, requests error |

**Static assets, including the 149 MB of weights, are served free and
unlimited** and do not count against the Workers request limit. Only
`/api/*` invokes the Worker.

So the only line that can produce a bill rather than an error is R2
storage, because enabling R2 requires a payment method and its overage is
pay-as-you-go. At 800 MB per study that is roughly **twelve studies of the
current size before the first cent**, and the first cent is $0.015 — 50 GB
would cost about $0.60 a month. Egress is free however much is read, which
is the property that matters when the payload is imaging: the same workload
on S3 would bill per gigabyte downloaded, forever, every time a cohort is
re-reviewed.

D1 and Workers do the opposite: on the free plan there is no billing
relationship, so exceeding them returns errors until the daily window
resets at 00:00 UTC rather than charging anything. Worth knowing because
the failure is visible and sudden — an upload stops working — rather than
quiet. Nothing is lost when it happens; the writes simply do not land.

The number to actually watch is **R2 storage**, and only that one. It is
the only limit that grows monotonically with use rather than resetting
daily, and `wrangler r2 bucket info mri-review-blobs` reports it.
