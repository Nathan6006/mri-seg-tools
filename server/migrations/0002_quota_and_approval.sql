-- Two gates and one meter.
--
-- APPROVAL. Anyone may register -- the tool is public and the local-only
-- mode is genuinely useful to a stranger. But only an approved account can
-- open a shared workspace, because shared storage is billed to one person's
-- card and an open door would let anyone spend it. An unapproved account is
-- not an error state: it signs in fine and runs exactly like the static
-- build, which is what every visitor got before this existed.
--
-- QUOTA. R2 has no spend cap and Cloudflare will not add one, so the cap
-- lives here instead. Every write goes through the Worker, which is the only
-- holder of bucket credentials, so a ceiling checked before the write is a
-- real ceiling and not an alert after the money is gone.

ALTER TABLE users ADD COLUMN approved  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN is_admin  INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN approved_at INTEGER;
ALTER TABLE users ADD COLUMN approved_by TEXT;

-- Annotations now carry their size, so that total usage is a SUM over the
-- two tables that own blobs rather than a running counter kept in step by
-- hand. A counter drifts the first time a delete fails halfway; an aggregate
-- cannot disagree with its own rows.
ALTER TABLE annotations ADD COLUMN bytes INTEGER NOT NULL DEFAULT 0;

-- Tunable without a redeploy, which matters for a number whose whole job is
-- to be adjusted when the bill or the free tier moves.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);

-- 9 GB against R2's 10 GB free tier. The GB of headroom is deliberate:
-- R2 bills on an average over the month and rounds up, deletes take a moment
-- to stop counting, and a cap that sits exactly on the free tier would bill
-- for the rounding. Refusing at 9 means the card is never reached.
INSERT INTO settings (key, value, updated_at) VALUES
  ('quota_bytes',     '9663676416', 0),   -- 9 GiB
  ('warn_fraction',   '0.75',       0),
  ('critical_fraction','0.90',      0);
