/**
 * M27 S1 — app-scoped notes reach (`notes.list` / `notes.search` / `notes.read`),
 * PLAN-M27.md.
 *
 * WHY THIS SLICE EXISTS: every broker tool before S1 resolved a **project root**
 * before it checked a grant (`roots.getById(projectId)` -> `unknown_project`),
 * and the user's notes are not a filesystem root. So a "notes" skill was not
 * expressible at all. What these tests pin:
 *
 *   - the reach WORKS with ZERO roots registered — the notes manager is the
 *     scope, and `roots.list()` stays empty;
 *   - it is GRANTED, not ambient: no grant -> `needs_approval` with the pending
 *     row keyed on `app`, and approve+remember persists a grant for
 *     (`notes.read`, `app`) so a re-exec is direct;
 *   - `app` is NOT a root alias: a FILE tool asked for `projectId: 'app'` is
 *     refused, so the app door can never widen into the filesystem;
 *   - the class envelope is the EXISTING `file.read` — a mobile session resolves
 *     an app tool positively (the data plane is ungated by design; a new
 *     capability name would have narrowed the product by construction);
 *   - no content channel grows: audit rows carry ids/counts/lengths only, never
 *     a note body and never a search query.
 *
 * The executors' own bounds (caps, typed params, `too_large`) are pinned in the
 * second describe block, against a real note store rather than a stub.
 */
import { describe, expect, it } from 'vitest';
import type { ToolExecResponse } from '@partner/shared/tools.js';
import { APP_SCOPE_ID } from '@partner/shared';
import { openDatabase } from '../../src/stores/db.js';
import {
  createAuditStore,
  createFileProposalStore,
  createGrantStore,
  createNoteGraphStore,
  createNoteLinkStore,
  createNoteStore,
  createNoteVersionStore,
  createNotesFtsStore,
  createPendingToolStore,
  createProjectRootStore,
} from '../../src/stores/db.js';
import { auditLog } from '../../src/services/redaction.js';
import { createToolBroker } from '../../src/broker/broker.js';
import { capabilityForTool } from '../../src/broker/broker.js';
import { createGrantManager } from '../../src/broker/grants.js';
import { createPendingManager } from '../../src/broker/pending.js';
import { createProjectRootManager } from '../../src/broker/roots.js';
import { createFileTools } from '../../src/files/tools.js';
import { createProposalManager } from '../../src/files/proposals.js';
import { createNoteManager } from '../../src/notes/index.js';
import { defaultToolRegistry } from '../../src/skills/catalog.js';
import {
  APP_TOOL_MANIFESTS,
  FILE_TOOL_MANIFESTS,
  TOOL_MANIFESTS,
} from '../../src/broker/toolManifests.js';
import {
  NOTES_LIST_CAP,
  NOTES_TOOL_READ_CHARS,
  createNotesTools,
} from '../../src/tools/notes.js';
import { NOTES_SEARCH_CAP } from '../../src/notes/manager.js';

/** Distinctive strings: the leak assertions search every audit row for these. */
const TITLE_MARKER = 'TITLE-MARKER quarterly plan';
const BODY_MARKER = 'BODY-MARKER the cat sat on the mat';
/** A phrase that IS in BODY_MARKER, so search really matches (and is still
 *  distinctive enough that finding it in an audit row would be a leak). */
const QUERY_MARKER = 'the cat sat';

function build(options: { clientClass?: string } = {}) {
  const db = openDatabase(':memory:');
  const audit = auditLog({ store: createAuditStore(db) });
  const notes = createNoteManager({
    stores: {
      notes: createNoteStore(db),
      links: createNoteLinkStore(db),
      fts: createNotesFtsStore(db),
      versions: createNoteVersionStore(db),
      graph: createNoteGraphStore(db),
    },
    audit,
    demo: true,
  });

  const proposalStore = createFileProposalStore(db);
  const roots = createProjectRootManager({ store: createProjectRootStore(db) });
  const grants = createGrantManager({ store: createGrantStore(db) });
  const pending = createPendingManager({
    store: createPendingToolStore(db),
    onCreateGrant: (row, note) =>
      grants.add(row.toolId, row.projectId ?? '', note === undefined ? {} : { note }).id,
  });

  const broker = createToolBroker({
    roots,
    grants,
    pending,
    proposals: createProposalManager({ store: proposalStore }),
    // Exactly the production dispatch map: file executors + notes executors.
    tools: { ...createFileTools({ proposals: proposalStore }), ...createNotesTools({ notes }) },
    audit,
  });

  const note = notes.create({ title: TITLE_MARKER, content: BODY_MARKER, tags: ['plan'] });

  return {
    broker,
    notes,
    roots,
    grants,
    pending,
    note,
    exec: (tool: string, params: unknown): ToolExecResponse =>
      broker.exec(tool, params, {
        requestedBy: 'web',
        ...(options.clientClass === undefined ? {} : { clientClass: options.clientClass }),
      }),
    /** Every audit row as `action target details` text, for leak assertions. */
    auditText: (): string =>
      (audit.list(1000) as unknown as Array<{ action: string; target: string; details: string }>)
        .map((row) => `${row.action} ${row.target} ${row.details}`)
        .join('\n'),
    auditRows: (): Array<{ action: string; target: string; details: string }> =>
      audit.list(1000) as unknown as Array<{ action: string; target: string; details: string }>,
  };
}

describe('M27 S1 — an app-scoped tool needs no project root', () => {
  it('grants and runs notes.read with ZERO roots registered', () => {
    const h = build();
    // The premise of the slice: nothing is registered, and there is nothing to
    // register — notes are not a filesystem root.
    expect(h.roots.list()).toEqual([]);

    h.grants.add('notes.read', APP_SCOPE_ID);

    // No projectId in the params at all: the scope supplies it.
    const res = h.exec('notes.read', { id: h.note.id });
    expect(res.outcome).toBe('executed');
    if (res.outcome !== 'executed') return;
    expect(res.result.content).toBe(BODY_MARKER);
    expect(res.result.title).toBe(TITLE_MARKER);
    // Still no roots — an app tool never adds or needs one.
    expect(h.roots.list()).toEqual([]);
  });

  it('answers needs_approval without a grant, keying the row on `app`', () => {
    const h = build();
    const res = h.exec('notes.list', {});
    expect(res.outcome).toBe('needs_approval');
    if (res.outcome !== 'needs_approval') return;

    const row = h.pending.get(res.pendingId);
    expect(row?.projectId).toBe(APP_SCOPE_ID);
    expect(row?.toolId).toBe('notes.list');
    // Nothing was executed on the way to the queue.
    expect(h.auditText()).toContain('notes.list.needs_approval');
  });

  it('an approve+remember persists the grant on `app`, and a re-exec is direct', () => {
    const h = build();
    const queued = h.exec('notes.read', { id: h.note.id });
    if (queued.outcome !== 'needs_approval') throw new Error('expected a pending row');

    const decided = h.broker.decide(queued.pendingId, { decision: 'approve', remember: true }, 'user');
    expect(decided.executed).toBe(true);
    expect(decided.grantId).not.toBeNull();
    if (decided.result !== undefined) expect(decided.result.content).toBe(BODY_MARKER);

    const grant = h.grants.activeGrant('notes.read', APP_SCOPE_ID);
    expect(grant?.projectId).toBe(APP_SCOPE_ID);

    const again = h.exec('notes.read', { id: h.note.id });
    expect(again.outcome).toBe('executed');
  });

  it('ignores a projectId a caller invents — the scope is the manifest, not the params', () => {
    const h = build();
    h.grants.add('notes.list', APP_SCOPE_ID);
    // A caller naming a root (or anything else) cannot widen or narrow app
    // reach: the grant is looked up under APP_SCOPE_ID regardless.
    const res = h.exec('notes.list', { projectId: 'root-1' });
    expect(res.outcome).toBe('executed');
  });

  it('refuses a FILE tool asked for projectId: app — `app` is not a root alias', () => {
    const h = build();
    h.grants.add('files.read', APP_SCOPE_ID);
    const res = h.exec('files.read', { projectId: APP_SCOPE_ID, path: '.' });
    expect(res.outcome).toBe('denied');
    if (res.outcome === 'denied') expect(res.reason).toBe('unknown_project');
  });

  it('resolves for a MOBILE session through the existing file.read capability', () => {
    // The deliberate coupling: a new `notes.read` capability name would be
    // absent from mobile's allowlist and deny a phone its own notes by
    // construction. `file.read` is in the envelope, so this is positive.
    expect(capabilityForTool('notes.list')).toBe('file.read');
    expect(capabilityForTool('notes.search')).toBe('file.read');
    expect(capabilityForTool('notes.read')).toBe('file.read');

    const h = build({ clientClass: 'mobile' });
    h.grants.add('notes.read', APP_SCOPE_ID);
    const res = h.exec('notes.read', { id: h.note.id });
    expect(res.outcome).toBe('executed');
  });
});

describe('M27 S1 — the audit row never carries note content', () => {
  it('records counts and lengths for list/search/read, never the body', () => {
    const h = build();
    h.grants.add('notes.list', APP_SCOPE_ID);
    h.grants.add('notes.search', APP_SCOPE_ID);
    h.grants.add('notes.read', APP_SCOPE_ID);

    expect(h.exec('notes.list', {}).outcome).toBe('executed');
    expect(h.exec('notes.search', { query: QUERY_MARKER }).outcome).toBe('executed');
    expect(h.exec('notes.read', { id: h.note.id }).outcome).toBe('executed');

    const text = h.auditText();
    // The content really did flow to the SKILL (asserted above) — and nowhere
    // near an audit row.
    expect(text).not.toContain(BODY_MARKER);
    expect(text).not.toContain(TITLE_MARKER);
    expect(text).not.toContain(QUERY_MARKER);

    const executed = h.auditRows().filter((row) => row.action.endsWith('.executed'));
    expect(executed).toHaveLength(3);
    // `runAuthorized` flattens each summary key to `result.<key>` /
    // `param.<key>`; assert the shapes directly.
    const read = h.auditRows().find((row) => row.action === 'notes.read.executed');
    expect(read?.target).toBe(APP_SCOPE_ID);
    expect(JSON.parse(read?.details ?? '{}')['result.chars']).toBe(BODY_MARKER.length);
    expect(JSON.parse(read?.details ?? '{}')['param.id']).toBe(h.note.id);

    const search = h.auditRows().find((row) => row.action === 'notes.search.executed');
    expect(JSON.parse(search?.details ?? '{}')['param.queryChars']).toBe(QUERY_MARKER.length);
    expect(JSON.parse(search?.details ?? '{}')['result.returned']).toBe(1);

    const list = h.auditRows().find((row) => row.action === 'notes.list.executed');
    expect(JSON.parse(list?.details ?? '{}')['result.returned']).toBe(1);
    expect(JSON.parse(list?.details ?? '{}')['result.total']).toBe(1);
  });
});

describe('M27 S1 — the executors are bounded and typed', () => {
  const withNotes = () => {
    const db = openDatabase(':memory:');
    const audit = auditLog({ store: createAuditStore(db) });
    const notes = createNoteManager({
      stores: {
        notes: createNoteStore(db),
        links: createNoteLinkStore(db),
        fts: createNotesFtsStore(db),
      },
      audit,
      demo: true,
    });
    return { notes, tools: createNotesTools({ notes }) };
  };

  const codeOf = (fn: () => unknown): string => {
    try {
      fn();
    } catch (err) {
      return (err as { code?: string }).code ?? 'no-code';
    }
    return 'no-error';
  };

  it('validates params before anything else (bad_params, never a queue row)', () => {
    const { tools } = withNotes();
    expect(codeOf(() => tools['notes.search'].validate({}))).toBe('bad_params');
    expect(codeOf(() => tools['notes.search'].validate({ query: '   ' }))).toBe('bad_params');
    expect(codeOf(() => tools['notes.read'].validate({}))).toBe('bad_params');
    expect(codeOf(() => tools['notes.read'].validate({ id: '' }))).toBe('bad_params');
    expect(codeOf(() => tools['notes.list'].validate({ limit: 0 }))).toBe('bad_params');
    expect(codeOf(() => tools['notes.list'].validate({ limit: -3 }))).toBe('bad_params');
    expect(codeOf(() => tools['notes.list'].validate({ limit: 1.5 }))).toBe('bad_params');
    // An absent/empty body is a legal list.
    expect(tools['notes.list'].validate(undefined)).toEqual({});
    expect(tools['notes.list'].validate({ limit: 5 })).toEqual({ limit: 5 });
  });

  it('translates an unknown note id to not_found (never an unhandled NoteError)', () => {
    const { tools } = withNotes();
    expect(codeOf(() => tools['notes.read'].run({ id: 'no-such-note' }))).toBe('not_found');
  });

  it('caps list and search, reporting the true total', () => {
    const { notes, tools } = withNotes();
    for (let i = 0; i < NOTES_LIST_CAP + 7; i += 1) {
      notes.create({ title: `note ${i}`, content: `body ${i}` });
    }
    const listed = tools['notes.list'].run({});
    expect(listed.notes).toHaveLength(NOTES_LIST_CAP);
    expect(listed.total).toBe(NOTES_LIST_CAP + 7);
    // A caller may ask for less, never more.
    expect(tools['notes.list'].run({ limit: 2 }).notes).toHaveLength(2);
    expect(tools['notes.list'].run({ limit: NOTES_LIST_CAP + 500 }).notes).toHaveLength(
      NOTES_LIST_CAP,
    );

    // The manager's own FTS hit cap (NOTES_SEARCH_CAP) already bounds what
    // search can see, so `total` reports hits FOUND, never more than that cap —
    // the tool adds a caller-tightenable limit on top and never widens it.
    const matches = tools['notes.search'].run({ query: 'body' });
    expect(matches.matches).toHaveLength(NOTES_SEARCH_CAP);
    expect(matches.total).toBe(NOTES_SEARCH_CAP);
    expect(tools['notes.search'].run({ query: 'body', limit: 3 }).matches).toHaveLength(3);
    expect(tools['notes.search'].run({ query: 'body', limit: 500 }).matches).toHaveLength(
      NOTES_SEARCH_CAP,
    );
  });

  it('refuses a note body past the char cap with too_large rather than truncating', () => {
    const { notes, tools } = withNotes();
    const big = notes.create({ title: 'big', content: 'x'.repeat(NOTES_TOOL_READ_CHARS + 1) });
    expect(codeOf(() => tools['notes.read'].run({ id: big.id }))).toBe('too_large');
  });

  it('list and search return summaries with NO body', () => {
    const { notes, tools } = withNotes();
    notes.create({ title: TITLE_MARKER, content: BODY_MARKER });
    const listed = tools['notes.list'].run({});
    expect(JSON.stringify(listed)).not.toContain(BODY_MARKER);
    expect(Object.keys(listed.notes[0] ?? {})).not.toContain('content');
    const searched = tools['notes.search'].run({ query: 'BODY' });
    expect(JSON.stringify(searched)).not.toContain(BODY_MARKER);
  });
});

describe('M27 S1 — the registry is one list', () => {
  it('has three app manifests, all app-scoped and read-only-tier', () => {
    expect(APP_TOOL_MANIFESTS).toHaveLength(3);
    for (const manifest of APP_TOOL_MANIFESTS) {
      expect(manifest.scope).toEqual({ kind: 'app' });
      expect(manifest.risk).toBe('low');
      expect(manifest.network).toBe(false);
      // No app-scoped WRITE tool can appear without this list saying so.
      expect(manifest.confirm).toBe('once');
    }
    expect(TOOL_MANIFESTS).toEqual([...FILE_TOOL_MANIFESTS, ...APP_TOOL_MANIFESTS]);
  });

  it('defaultToolRegistry() (what an INSTALL checks) covers what the broker DISPATCHES', () => {
    const registry = defaultToolRegistry();
    for (const manifest of TOOL_MANIFESTS) expect(registry.has(manifest.id)).toBe(true);
    // The three notes ids are the specific S1 additions.
    expect(registry.has('notes.list')).toBe(true);
    expect(registry.has('notes.search')).toBe(true);
    expect(registry.has('notes.read')).toBe(true);
  });
});
