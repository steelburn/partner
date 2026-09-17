/**
 * file-inventory — a bounded recursive listing of ONE granted project root.
 *
 * WHAT IT DEMONSTRATES (this is reference material for skill authors):
 *
 *   1. The narrowest reach that does the job. The manifest declares
 *      `files.list` ONLY: the skill reports names, sizes and extensions, and
 *      never asks for `files.read`, so installing it cannot expose a byte of
 *      any file's content. A file NAME is visible; a file BODY is not.
 *   2. Every call goes through the broker (`partner.tools.exec`). Without a
 *      grant for `files.list` on that root the call is REFUSED with
 *      `tool_denied` — skills are non-interactive, so a missing grant is a hard
 *      deny, and this entry reports the CODE instead of returning an empty
 *      inventory that would read as "the folder is empty".
 *   3. Bounds are explicit: the walk is breadth-first, capped in depth and in
 *      entries, and the result SAYS when it stopped early (`truncated`). A
 *      skill that silently truncates is worse than one that admits it.
 *
 * Args:
 *   projectId {string}  required — a project root the user granted
 *   path      {string}  optional — a directory INSIDE that root (default '.')
 *   depth     {number}  optional — levels below `path` to list (0-3, default 2)
 */
const MAX_DEPTH = 3;
const MAX_ENTRIES = 400;

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  // A leading dot is a hidden file, not an extension (`.env` -> `(none)`).
  if (dot <= 0 || dot === name.length - 1) return '(none)';
  return name.slice(dot + 1).toLowerCase();
}

export async function run(args = {}) {
  const projectId = typeof args.projectId === 'string' ? args.projectId.trim() : '';
  if (projectId === '') {
    return { ok: false, reason: 'projectId is required — a project root you have granted' };
  }
  const start = typeof args.path === 'string' && args.path !== '' ? args.path : '.';
  const requested = Number.isInteger(args.depth) ? args.depth : 2;
  const depth = Math.max(0, Math.min(MAX_DEPTH, requested));

  const byExtension = {};
  const directories = [];
  let files = 0;
  let bytes = 0;
  let truncated = false;

  // Breadth-first so a wide root is summarised before a deep one is walked.
  const queue = [{ path: start, level: 0 }];
  while (queue.length > 0) {
    if (files + directories.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const current = queue.shift();
    let listing;
    try {
      listing = await partner.tools.exec('files.list', { projectId, path: current.path });
    } catch (err) {
      // A refusal is a CODE (tool_denied until the grant exists, not_found,
      // bad_params) — never an empty inventory that would look like success.
      return { ok: false, path: current.path, reason: err && err.code ? err.code : 'failed' };
    }
    const entries = Array.isArray(listing && listing.entries) ? listing.entries : [];
    for (const entry of entries) {
      if (entry && entry.kind === 'dir') {
        directories.push(entry.path);
        // `entry.path` is relative to the SAME root, so it is a valid `path`
        // for the next call without any path arithmetic here.
        if (current.level < depth) queue.push({ path: entry.path, level: current.level + 1 });
        continue;
      }
      files += 1;
      bytes += typeof entry.size === 'number' ? entry.size : 0;
      const ext = extensionOf(String(entry.name));
      byExtension[ext] = (byExtension[ext] ?? 0) + 1;
    }
  }
  if (queue.length > 0) truncated = true;

  // Largest group first, so the shape of the folder is the first thing read.
  const extensions = Object.entries(byExtension)
    .map(([extension, count]) => ({ extension, count }))
    .sort((a, b) => (b.count === a.count ? a.extension.localeCompare(b.extension) : b.count - a.count));

  return {
    ok: true,
    root: start,
    depth,
    files,
    directories: directories.length,
    bytes,
    extensions,
    // Honesty over tidiness: an inventory that stopped early says so.
    truncated,
  };
}
