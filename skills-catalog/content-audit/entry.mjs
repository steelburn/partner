/**
 * content-audit — "where does this phrase live in the project?"
 *
 * WHAT IT DEMONSTRATES (reference material for skill authors):
 *
 *   1. ONE declared tool, used for what it is for. `files.search` is the
 *      broker's own capped, binary-skipping content search; the skill declares
 *      nothing else, so it can read no file it did not already match, and it
 *      cannot write anything.
 *   2. A refusal is reported as a CODE. Without a grant the broker answers
 *      `tool_denied` (and an unknown root `unknown_project`); this entry passes
 *      that code through instead of pretending the search found nothing.
 *   3. The result is reduced to a SHAPE the model can read: per-file counts
 *      plus a few sample lines, capped, with the total before the cap. Dumping
 *      500 raw hits into a chat is not a report.
 *
 * Args:
 *   projectId {string} required — a project root the user granted
 *   query     {string} required — the text to look for (case-insensitive)
 *   path      {string} optional — a directory inside that root (default '.')
 */
const MAX_FILES = 40;
const MAX_SAMPLES = 2;

export async function run(args = {}) {
  const projectId = typeof args.projectId === 'string' ? args.projectId.trim() : '';
  if (projectId === '') {
    return { ok: false, reason: 'projectId is required — a project root you have granted' };
  }
  const query = typeof args.query === 'string' ? args.query.trim() : '';
  if (query === '') {
    return { ok: false, reason: 'query is required — the text to look for' };
  }
  const path = typeof args.path === 'string' && args.path !== '' ? args.path : '.';

  let listing;
  try {
    listing = await partner.tools.exec('files.search', { projectId, path, query });
  } catch (err) {
    // tool_denied (no grant), unknown_project, not_found, bad_params —
    // reported verbatim; a denial is not an empty result.
    return { ok: false, reason: err && err.code ? err.code : 'failed' };
  }

  const hits = Array.isArray(listing && listing.hits) ? listing.hits : [];
  const byFile = new Map();
  for (const hit of hits) {
    const file = typeof hit.path === 'string' ? hit.path : '(unknown)';
    const group = byFile.get(file) ?? { path: file, count: 0, samples: [] };
    group.count += 1;
    if (group.samples.length < MAX_SAMPLES) {
      group.samples.push({
        line: typeof hit.line === 'number' ? hit.line : 0,
        // The broker already caps a hit line at 500 chars; this is a report,
        // not a transcript, so it stays short even then.
        text: typeof hit.text === 'string' ? hit.text.trim().slice(0, 160) : '',
      });
    }
    byFile.set(file, group);
  }

  const files = [...byFile.values()].sort((a, b) => b.count - a.count);
  return {
    ok: true,
    query,
    root: path,
    // `hits` is the broker's capped total; `files` may be capped again here.
    hits: hits.length,
    files: files.length,
    truncated: files.length > MAX_FILES || hits.length >= 500,
    matches: files.slice(0, MAX_FILES),
  };
}
