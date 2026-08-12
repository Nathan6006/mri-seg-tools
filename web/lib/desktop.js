/**
 * Entries for the pipeline, from folders picked in the desktop shell.
 *
 * The whole ingest pipeline consumes `{path, file}` where `file` is read
 * through three members only: `.size`, `.arrayBuffer()`, and
 * `.slice(start, end).arrayBuffer()` (series discovery classifies a series
 * from a 16 KB header prefix rather than reading whole files). So a desktop
 * "file" is those three members backed by the shell's ranged reads, and
 * nothing downstream can tell it from a real File. If the pipeline ever
 * starts using another Blob member, this is the one place to add it.
 */

export function entriesFromPicks(picks, bridge) {
  const items = [];
  for (const p of picks) {
    for (const f of p.files) {
      items.push({
        path: `${p.name}/${f.rel}`,
        file: fileLike(bridge, p.token, f.rel, 0, f.size),
      });
    }
  }
  return items;
}

/**
 * A File-shaped window onto `[from, to)` of one file in a picked folder.
 * Slice semantics are the subset the pipeline uses: non-negative offsets,
 * clamped to the window, relative to it -- same as Blob.slice for those
 * arguments.
 */
function fileLike(bridge, token, rel, from, to) {
  const clamp = (v) => Math.max(0, Math.min(v, to - from));
  return {
    size: to - from,
    arrayBuffer: () => bridge.readScanFile(token, rel, from, to),
    slice: (start = 0, end = to - from) =>
      fileLike(bridge, token, rel, from + clamp(start), from + clamp(end)),
  };
}
