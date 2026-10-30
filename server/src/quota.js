/**
 * The storage ceiling Cloudflare will not give you.
 *
 * R2 has no spend cap. Exceeding the free tier bills the card on file, with
 * no confirmation and no limit, and Cloudflare's own answer to this has been
 * "set an alert" for years -- an alert tells you after the money is gone.
 *
 * So the cap lives here. It works because the Worker is the only holder of
 * bucket credentials: nothing else can write a byte, so a check in front of
 * every write is a real ceiling rather than a best effort. The refusal
 * happens BEFORE the R2 put, not after, because a put that succeeds and is
 * then rolled back has already been charged for.
 *
 * WHY USAGE IS A SUM AND NOT A COUNTER
 * ------------------------------------
 * Total bytes are computed as an aggregate over the two tables that own
 * blobs, rather than kept in a running total. A counter is faster and is
 * wrong the first time a delete half-fails or a write races -- and it drifts
 * silently, in the direction of under-counting, which is the direction that
 * costs money. The aggregate cannot disagree with its own rows. At a few
 * thousand rows it is a single indexed scan and costs nothing.
 *
 * It CAN still drift from what R2 actually holds, if a delete removed the
 * row but not the object. `reconcile()` is the repair: it lists the bucket
 * and compares. That is the one source of truth, and it is too slow to
 * consult on every upload.
 */

const DEFAULTS = {
  quota_bytes: 9663676416,     // 9 GiB, under R2's 10 GB free tier
  warn_fraction: 0.75,
  critical_fraction: 0.90,
};

export async function settings(env) {
  const { results } = await env.DB.prepare('SELECT key, value FROM settings').all();
  const out = { ...DEFAULTS };
  for (const row of results || []) {
    const n = Number(row.value);
    if (Number.isFinite(n)) out[row.key] = n;
  }
  return out;
}

/** Account-wide bytes held in R2, from the rows that own them. */
export async function bytesUsed(env) {
  const row = await env.DB.prepare(
    `SELECT (SELECT COALESCE(SUM(bytes), 0) FROM case_files)
          + (SELECT COALESCE(SUM(bytes), 0) FROM annotations) AS total`,
  ).first();
  return Number(row?.total || 0);
}

export async function usage(env) {
  const [used, cfg] = await Promise.all([bytesUsed(env), settings(env)]);
  const quota = cfg.quota_bytes;
  const fraction = quota > 0 ? used / quota : 0;

  let level = 'ok';
  if (fraction >= 1) level = 'full';
  else if (fraction >= cfg.critical_fraction) level = 'critical';
  else if (fraction >= cfg.warn_fraction) level = 'warn';

  return {
    used,
    quota,
    remaining: Math.max(0, quota - used),
    fraction,
    level,
    warnAt: Math.round(quota * cfg.warn_fraction),
    criticalAt: Math.round(quota * cfg.critical_fraction),
    // Stated so the UI never has to hardcode the reason the cap is where it
    // is -- the person being refused deserves to know it is not arbitrary.
    freeTierBytes: 10_000_000_000,
  };
}

// Picks the unit from the number. A fixed "GB" is fine for the 9 GB ceiling
// and turns a 2 MB upload into "0.00 GB", which tells the person refused
// nothing at all -- and the quota is adjustable, so small values are not
// hypothetical.
function human(n) {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} GB`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)} kB`;
  return `${n} bytes`;
}

/**
 * May `incoming` bytes be written, given that `replacing` bytes at the same
 * key are about to be freed? Returns null to allow, or a message to refuse.
 *
 * The `replacing` term matters more than it looks: re-saving a mask over
 * itself is the single most common write this tool makes, and without it a
 * workspace sitting at the ceiling could never be corrected, only deleted.
 */
export async function checkWrite(env, incoming, replacing = 0) {
  const u = await usage(env);
  const after = u.used - replacing + incoming;
  if (after <= u.quota) return null;

  return `This upload would put the shared storage over its ${human(u.quota)} `
       + `limit — ${human(u.used)} is in use and this is ${human(incoming)}. `
       + `The limit sits below the ${human(u.freeTierBytes)} free tier so that `
       + `nothing is ever billed. Delete some scans to make room; the Files `
       + `panel sorts by size.`;
}

/**
 * Recount against the bucket itself and report any disagreement.
 *
 * Read-only: it reports drift rather than "fixing" it, because the two ways
 * drift happens need opposite repairs. An object R2 holds with no row is
 * garbage to delete; a row with no object is a case whose upload failed and
 * which should be re-uploaded, not silently erased. Deciding that
 * automatically is how a reconciler deletes someone's data.
 */
export async function reconcile(env) {
  let objectBytes = 0;
  let objectCount = 0;
  let cursor;
  do {
    const listing = await env.BLOBS.list({ cursor, limit: 1000 });
    for (const o of listing.objects) { objectBytes += o.size; objectCount += 1; }
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);

  const ledgerBytes = await bytesUsed(env);
  const rows = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM case_files) + (SELECT COUNT(*) FROM annotations) AS n`,
  ).first();

  return {
    bucket: { bytes: objectBytes, objects: objectCount },
    database: { bytes: ledgerBytes, rows: Number(rows?.n || 0) },
    driftBytes: objectBytes - ledgerBytes,
    agrees: objectBytes === ledgerBytes,
  };
}
