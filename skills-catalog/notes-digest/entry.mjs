/**
 * notes-digest — "what am I carrying, and what is still open?"
 *
 * WHAT IT DEMONSTRATES (reference material for skill authors):
 *
 *   1. APP-SCOPED reach. `notes.list` / `notes.search` / `notes.read` take NO
 *      `projectId`: the core's own note store IS the scope, granted once as app
 *      data ("your notes, read-only"). A skill can therefore work with no
 *      project root registered at all — and cannot point this reach at a root.
 *   2. COUNTS, not contents. It reads notes to measure them (words, checklist
 *      items open/done) and returns only those measurements plus titles and
 *      tags. A digest that pasted note bodies would push the user's own writing
 *      through a model on every call — this one does not.
 *   3. Codes over silence: a missing app-data grant is `tool_denied`, reported
 *      as such rather than as "no notes".
 *
 * Args:
 *   query {string} optional — search notes by text instead of listing them
 *   limit {number} optional — how many notes to inspect (1-25, default 10)
 */
const MAX_NOTES = 25;
const DEFAULT_NOTES = 10;

function clampLimit(raw) {
  const value = Number.isInteger(raw) ? raw : DEFAULT_NOTES;
  return Math.max(1, Math.min(MAX_NOTES, value));
}

/** Checklist tallies + word count for one note body. Markdown task items only. */
function measure(content) {
  const open = [];
  let done = 0;
  for (const line of content.split('\n')) {
    const match = /^\s*[-*]\s*\[([ xX])\]\s*(.*)$/.exec(line);
    if (match === null) continue;
    if (match[1].toLowerCase() === 'x') done += 1;
    else open.push(match[2].trim());
  }
  const words = content.split(/\s+/).filter((word) => word !== '').length;
  return { words, checklistOpen: open.length, checklistDone: done, nextOpen: open[0] ?? null };
}

export async function run(args = {}) {
  const limit = clampLimit(args.limit);
  const query = typeof args.query === 'string' ? args.query.trim() : '';

  let listed;
  try {
    listed =
      query === ''
        ? await partner.tools.exec('notes.list', { limit })
        : await partner.tools.exec('notes.search', { query, limit });
  } catch (err) {
    // tool_denied until the user grants app data; never "you have no notes".
    return { ok: false, reason: err && err.code ? err.code : 'failed' };
  }

  const rows = query === '' ? listed && listed.notes : listed && listed.matches;
  const summaries = Array.isArray(rows) ? rows : [];

  const digest = [];
  let words = 0;
  let checklistOpen = 0;
  let checklistDone = 0;
  for (const summary of summaries) {
    if (!summary || typeof summary.id !== 'string') continue;
    let full;
    try {
      full = await partner.tools.exec('notes.read', { id: summary.id });
    } catch (err) {
      // One unreadable note must not lose the digest; it is reported instead.
      digest.push({ id: summary.id, title: summary.title ?? '', unreadable: err && err.code ? err.code : 'failed' });
      continue;
    }
    const content = typeof full && typeof full.content === 'string' ? full.content : '';
    const stats = measure(content);
    words += stats.words;
    checklistOpen += stats.checklistOpen;
    checklistDone += stats.checklistDone;
    digest.push({
      id: summary.id,
      title: typeof summary.title === 'string' ? summary.title : '',
      tags: Array.isArray(summary.tags) ? summary.tags : [],
      updatedAt: typeof summary.updatedAt === 'number' ? summary.updatedAt : null,
      ...stats,
    });
  }

  const total = listed && typeof listed.total === 'number' ? listed.total : digest.length;
  return {
    ok: true,
    mode: query === '' ? 'recent' : 'search',
    query: query === '' ? null : query,
    notes: digest.length,
    total,
    truncated: total > digest.length,
    words,
    checklistOpen,
    checklistDone,
    digest,
  };
}
