/**
 * M27 S4 — the two Studio templates that need M27's new reaches (PLAN-M27.md S4).
 *
 * The slice exists because two of the four templates the owner asked for were
 * not implementable before M27: a *notes-shaped* skill (the broker had no
 * app-scoped tools) and a skill *using an MCP tool* (MCP existed only as a
 * chat-side external). S1 and S2 wired both reaches; this file holds the two
 * templates to them, in order of how much it matters:
 *
 *   1. The picker can never offer a template whose reach the sandbox refuses
 *      (D9): `availableTemplates` drops each one when its capability key is
 *      false, and the drafts door — the thing the picker actually calls —
 *      agrees.
 *   2. Each new manifest VALIDATES against the capability object the runtime is
 *      built with, including D6's `medium` floor on the MCP one.
 *   3. Each bundle RUNS. The notes template goes through a real Studio DRY-RUN
 *      (draft from template -> the real sandbox -> the real broker) with app
 *      data granted, and reports a coded refusal without it; the MCP template
 *      runs against a REAL local stdio server. No network either way.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillManifest } from '@partner/shared';
import { APP_SCOPE_ID } from '@partner/shared';
import { demoHarness, makeTempRoot, removeTempRoot } from '../helpers.js';
import type { Harness } from '../helpers.js';
import {
  DEFAULT_RUNTIME_CAPABILITIES,
  lintEntry,
  validateManifestShape,
} from '../../src/skills/manifest.js';
import type { RuntimeCapabilities } from '../../src/skills/manifest.js';
import {
  availableTemplates,
  findTemplate,
  MCP_TEMPLATE_SERVER_ID,
} from '../../src/skills/templates.js';

const ALL_ON: RuntimeCapabilities = { mcp: true, llm: true, notes: true };
/** The two templates this slice adds, and the capability each one needs. */
const NEW_TEMPLATES: ReadonlyArray<[string, keyof RuntimeCapabilities]> = [
  ['notes-checklist', 'notes'],
  ['mcp-call', 'mcp'],
];

/** The checklist a note must contain for the notes template to find anything. */
const CHECKLIST = [
  '# Launch plan',
  '- [x] book the room',
  '- [ ] send the invites',
  'Some prose between the items.',
  '',
].join('\n');

/** A minimal MCP server: initialize, tools/list, tools/call (echo only). */
const FAKE_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (line.trim() === '') return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }) + '\\n');
    return;
  }
  if (msg.method && msg.method.startsWith('notifications/')) return;
  if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'echo', description: 'echo arguments', inputSchema: { type: 'object' } }
    ] } }) + '\\n');
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    if (name !== 'echo') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown tool: ' + name } }) + '\\n');
      return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echoed:' + JSON.stringify(msg.params.arguments || {}) }] } }) + '\\n');
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }) + '\\n');
});
`;

const dirs: string[] = [];
const harnesses: Harness[] = [];

afterEach(() => {
  for (const h of harnesses.splice(0)) {
    try {
      h.close();
    } catch {
      // ignore
    }
  }
  for (const dir of dirs.splice(0)) removeTempRoot(dir);
});

/** A harness whose skill store is a temp dir (the install/copy path needs one). */
function env(): Harness {
  const storeDir = makeTempRoot();
  dirs.push(storeDir);
  const h = demoHarness({ skills: { storeDir } });
  harnesses.push(h);
  return h;
}

/**
 * D8's guarantee is that no pending row is EVER created — stronger than "none is
 * left open", which is all `pendingManager.list()` can see (it returns open rows
 * only). The total count catches the enqueue-then-decide(deny) route a regression
 * could take: it would leave a CLOSED row behind.
 */
function expectNoPendingRows(h: Harness): void {
  expect(h.pendingManager?.list() ?? []).toEqual([]);
  const counted = h.db.prepare('SELECT COUNT(*) AS n FROM pending_tools').get() as
    | { n: number }
    | undefined;
  expect(counted?.n).toBe(0);
}

function template(id: string) {
  const found = findTemplate(id);
  if (found === undefined) throw new Error(`template ${id} is missing`);
  return found;
}

function ids(capabilities: RuntimeCapabilities): string[] {
  return availableTemplates(capabilities).map((entry) => entry.id);
}

describe('M27 S4 — the picker offers a template only when its reach is wired (D9)', () => {
  it('offers every template when every reach is wired', () => {
    expect(ids(ALL_ON)).toEqual([
      'pure',
      'reads-files',
      'notes-checklist',
      'mcp-call',
      'content-audit',
    ]);
  });

  it('drops the notes template when `notes` is false, and keeps the MCP one', () => {
    expect(ids({ mcp: true, llm: true, notes: false })).toEqual([
      'pure',
      'reads-files',
      'mcp-call',
      'content-audit',
    ]);
  });

  it('drops the MCP template when `mcp` is false, and keeps the notes one', () => {
    expect(ids({ mcp: false, llm: true, notes: true })).toEqual([
      'pure',
      'reads-files',
      'notes-checklist',
      'content-audit',
    ]);
  });

  it('offers neither under the library default, so an unwired build cannot show them', () => {
    expect(ids(DEFAULT_RUNTIME_CAPABILITIES)).toEqual([
      'pure',
      'reads-files',
      'content-audit',
    ]);
  });

  it('names the capability each new template needs', () => {
    for (const [id, capability] of NEW_TEMPLATES) {
      expect(template(id).requires, id).toBe(capability);
      // Offered exactly when THIS template's own capability is on: every other
      // reach can be off without affecting it.
      for (const name of Object.keys(ALL_ON) as Array<keyof RuntimeCapabilities>) {
        const offered = ids({ ...ALL_ON, [name]: false }).includes(id);
        expect(offered, `${id} with ${name}=false`).toBe(name !== capability);
      }
    }
  });
});

describe('M27 S4 — each new manifest validates against the build that offers it', () => {
  it('validates the notes template, declaring only app-scoped read tools', () => {
    const bundle = template('notes-checklist').build('Notes checklist', 'notes-checklist-skill');
    const shape = validateManifestShape(bundle.manifest, { capabilities: ALL_ON });
    expect(shape.ok).toBe(true);
    expect(bundle.manifest.permissions.tools).toEqual([
      'notes.list',
      'notes.search',
      'notes.read',
    ]);
    expect(bundle.manifest.permissions.network).toBe(false);
    expect(bundle.manifest.permissions.mcpServers).toBeUndefined();
    expect(lintEntry(bundle.code).ok).toBe(true);
  });

  it('validates the MCP template at the D6 floor, on a declared server', () => {
    const bundle = template('mcp-call').build('MCP call', 'mcp-call-skill');
    const shape = validateManifestShape(bundle.manifest, { capabilities: ALL_ON });
    expect(shape.ok).toBe(true);
    // D6: an MCP tool's own risk is unknowable in advance, so the manifest must
    // present at least `medium` — and the template's reach is the SERVER, so it
    // declares no broker tool id at all.
    expect(bundle.manifest.permissions.risk).toBe('medium');
    expect(bundle.manifest.permissions.tools).toEqual([]);
    // A generated server id cannot be known here: the placeholder is the field
    // the author replaces, and it is present so the reach is a truthful example.
    expect(bundle.manifest.permissions.mcpServers).toEqual([MCP_TEMPLATE_SERVER_ID]);
    expect(lintEntry(bundle.code).ok).toBe(true);
  });

  it('refuses the MCP manifest when the reach is NOT wired, so the two agree', () => {
    const bundle = template('mcp-call').build('MCP call', 'mcp-call-skill');
    const shape = validateManifestShape(bundle.manifest, {
      capabilities: { mcp: false, llm: true, notes: true },
    });
    expect(shape.ok).toBe(false);
    if (!shape.ok) expect(shape.errors.join(' ')).toContain('not supported yet');
  });

  it('drafts an install-grade bundle from each new template through the real door', async () => {
    const h = env();
    const drafts = h.skillDrafts;
    if (drafts === undefined) throw new Error('the drafts manager is unwired in this harness');
    for (const [id] of NEW_TEMPLATES) {
      const draft = await drafts.create({
        mode: 'template',
        template: id,
        name: id === 'mcp-call' ? 'Call my server' : 'My checklists',
        description: '',
      });
      expect(draft.origin, id).toBe('template');
      // The install bar, not a lower one: whatever the template emits validates
      // against the broker registry this build actually has.
      expect(draft.validation.ok, `${id}: ${draft.validation.errors.join(' ')}`).toBe(true);
      expect(draft.manifest, id).not.toBeNull();
    }
  }, 20_000);
});

describe('M27 S4 — the notes template dry-runs through the real sandbox and broker', () => {
  it('reads the checklists out of the granted notes, and refuses without app data', async () => {
    const h = env();
    const drafts = h.skillDrafts;
    const notes = h.notes;
    const broker = h.broker;
    if (drafts === undefined || notes === undefined || broker === undefined) {
      throw new Error('the drafts manager, notes or broker is unwired in this harness');
    }

    // The picker's own path: template -> inert draft -> the real dry-run.
    const draft = await drafts.create({
      mode: 'template',
      template: 'notes-checklist',
      name: 'Notes checklist',
      description: '',
    });
    expect(draft.validation.ok, draft.validation.errors.join(' ')).toBe(true);
    expect(draft.manifest?.permissions.tools).toEqual([
      'notes.list',
      'notes.search',
      'notes.read',
    ]);
    expect(draft.validation.warnings.join('\n')).toContain('list your notes');

    notes.create({ title: 'Launch plan', content: CHECKLIST });
    notes.create({ title: 'Shopping list', content: 'milk\nbread\n' });

    // No grant yet: a coded refusal the template reports, and no OPEN approval
    // left for the user — a skill is never interactive (M8).
    //
    // This is the BROKER route, not MCP's: the broker enqueues and the runner
    // closes the row as a deny in the same breath, so a CLOSED row is that
    // documented path working. An open row is the leak, which is what is asserted
    // here (the MCP reach below is the one that must create NO row at all).
    const refused = await drafts.runDraft(draft.id, { args: {} });
    expect(refused.ok).toBe(true);
    if (refused.ok) expect(refused.result).toMatchObject({ ok: false, reason: 'tool_denied' });
    expect(h.pendingManager?.list() ?? []).toEqual([]);

    // The owner grants APP data (no root involved) and the same dry-run works.
    for (const tool of ['notes.list', 'notes.search', 'notes.read']) {
      broker.grants.add(tool, APP_SCOPE_ID);
    }
    const items = [
      { note: 'Launch plan', done: true, text: 'book the room' },
      { note: 'Launch plan', done: false, text: 'send the invites' },
    ];
    const listed = await drafts.runDraft(draft.id, { args: {} });
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      // Both notes were listed; only the checklist lines became items — a note
      // with no task items contributes nothing rather than an invented entry.
      expect(listed.result).toEqual({ ok: true, notes: 2, open: 1, done: 1, items });
    }
    const searched = await drafts.runDraft(draft.id, { args: { query: 'invites' } });
    expect(searched.ok).toBe(true);
    if (searched.ok) {
      expect(searched.result).toEqual({ ok: true, notes: 1, open: 1, done: 1, items });
    }
    // App reach never registers a project root — that was the whole point of S1.
    expect(broker.roots.list()).toEqual([]);
  }, 20_000);
});

describe('M27 S4 — the MCP template runs against a real local stdio server', () => {
  it('calls the declared server’s tool and returns its text to the skill', async () => {
    const h = env();
    const mcp = h.mcp;
    const skills = h.skills;
    const runner = h.skillRunner;
    if (mcp === undefined || skills === undefined || runner === undefined) {
      throw new Error('the MCP manager, skills or runner is unwired in this harness');
    }
    const serverDir = mkdtempSync(join(tmpdir(), 'partner-tpl-mcp-'));
    dirs.push(serverDir);
    const script = join(serverDir, 'fake-server.cjs');
    writeFileSync(script, FAKE_SERVER);
    const created = mcp.create({ name: 'fake', command: process.execPath, args: [script] });
    mcp.update(created.id, { enabled: true });

    const bundle = template('mcp-call').build('MCP call', 'mcp-call-skill');
    // The one edit the author makes: ids are generated when a server is added,
    // so the shipped placeholder is replaced with the id the owner configured.
    const ownerEdited: SkillManifest = {
      ...bundle.manifest,
      permissions: { ...bundle.manifest.permissions, mcpServers: [created.id] },
    };
    skills.installFromBundle(
      { manifest: ownerEdited, code: bundle.code },
      { update: false, source: 'authored' },
    );
    const detail = skills.get('mcp-call-skill');
    if (detail === null) throw new Error('the MCP template skill did not install');

    const out = await runner.invoke(detail, {
      server: created.id,
      tool: 'echo',
      params: { hello: 'world' },
    });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.result).toMatchObject({
        ok: true,
        server: created.id,
        tool: 'echo',
        contentItems: 1,
      });
      const text = (out.result as { text: string }).text;
      expect(text).toContain('echoed:');
      expect(text).toContain('world');
    }
  }, 20_000);

  it('reports an UNDECLARED server as a coded refusal, and queues nothing', async () => {
    const h = env();
    const mcp = h.mcp;
    const skills = h.skills;
    const runner = h.skillRunner;
    if (mcp === undefined || skills === undefined || runner === undefined) {
      throw new Error('the MCP manager, skills or runner is unwired in this harness');
    }
    const bundle = template('mcp-call').build('MCP call', 'mcp-call-skill');
    skills.installFromBundle(
      { manifest: bundle.manifest, code: bundle.code },
      { update: false, source: 'authored' },
    );
    const detail = skills.get('mcp-call-skill');
    if (detail === null) throw new Error('the MCP template skill did not install');

    // The unedited template declares the placeholder, so this id is not in the
    // manifest: the entry reports the code instead of failing the run, which is
    // exactly what its own docblock promises.
    const out = await runner.invoke(detail, { server: 'some-other-server', tool: 'echo' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result).toMatchObject({ ok: false, reason: 'mcp_not_declared' });
    expectNoPendingRows(h);
  }, 20_000);

  it('reports a DISABLED declared server as a coded refusal', async () => {
    const h = env();
    const mcp = h.mcp;
    const skills = h.skills;
    const runner = h.skillRunner;
    if (mcp === undefined || skills === undefined || runner === undefined) {
      throw new Error('the MCP manager, skills or runner is unwired in this harness');
    }
    // Created (ids are assigned here) but never enabled: default-deny means the
    // skill cannot reach it until the owner says so.
    const created = mcp.create({ name: 'off', command: process.execPath, args: ['-e', ''] });
    const bundle = template('mcp-call').build('MCP call', 'mcp-call-skill');
    skills.installFromBundle(
      {
        manifest: {
          ...bundle.manifest,
          permissions: { ...bundle.manifest.permissions, mcpServers: [created.id] },
        },
        code: bundle.code,
      },
      { update: false, source: 'authored' },
    );
    const detail = skills.get('mcp-call-skill');
    if (detail === null) throw new Error('the MCP template skill did not install');

    const out = await runner.invoke(detail, { server: created.id, tool: 'echo' });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.result).toMatchObject({ ok: false, reason: 'mcp_disabled' });
    expectNoPendingRows(h);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// The content-audit template — the authorable twin of the catalog's
// `content-audit` sample. `skills-catalog/README.md` says the two exist as one
// worked example behind two doors, so both halves are asserted here: the
// template validates against the build that offers it (no capability flag), and
// its bundle RUNS — the rule templates.ts states in its own header is that every
// template is held to a real dry-run, never to a lint.
// ---------------------------------------------------------------------------

describe('the content-audit template (catalog sample, authorable form)', () => {
  it('needs no capability flag, validates against the registry, and lints', () => {
    const bundle = template('content-audit').build('My audit', 'my-audit');
    // The files tools are always wired, so the picker offers this in every
    // build — that is WHY it carries no `requires`.
    expect(template('content-audit').requires).toBeUndefined();
    expect(ids(DEFAULT_RUNTIME_CAPABILITIES)).toContain('content-audit');
    const shape = validateManifestShape(bundle.manifest, {
      capabilities: DEFAULT_RUNTIME_CAPABILITIES,
    });
    expect(shape.ok, shape.ok ? '' : shape.errors.join(' ')).toBe(true);
    expect(bundle.manifest.permissions.tools).toEqual(['files.search']);
    expect(bundle.manifest.permissions.network).toBe(false);
    // files.search is a LOW-risk broker tool, so `medium` is a deliberate
    // choice here (the same tier `reads-files` declares), not a floor.
    expect(bundle.manifest.permissions.risk).toBe('medium');
    const lint = lintEntry(bundle.code);
    expect(lint.ok, lint.errors.join(' ')).toBe(true);
  });

  it('drafts it at an install-grade bar through the real door', async () => {
    const h = env();
    const drafts = h.skillDrafts;
    if (drafts === undefined) throw new Error('the drafts manager is unwired in this harness');
    const draft = await drafts.create({
      mode: 'template',
      template: 'content-audit',
      name: 'My audit',
      description: '',
    });
    expect(draft.origin).toBe('template');
    expect(draft.validation.ok, draft.validation.errors.join(' ')).toBe(true);
    expect(draft.manifest?.permissions.tools).toEqual(['files.search']);
  }, 20_000);

  it('searches a granted root through the real sandbox and broker', async () => {
    const h = env();
    const drafts = h.skillDrafts;
    const broker = h.broker;
    if (drafts === undefined || broker === undefined) {
      throw new Error('the drafts manager or broker is unwired in this harness');
    }
    const draft = await drafts.create({
      mode: 'template',
      template: 'content-audit',
      name: 'My audit',
      description: '',
    });
    expect(draft.validation.ok, draft.validation.errors.join(' ')).toBe(true);

    const rootPath = makeTempRoot();
    dirs.push(rootPath);
    writeFileSync(join(rootPath, 'notes.md'), 'send the invites on Friday\n');
    writeFileSync(join(rootPath, 'other.md'), 'nothing to see\n');
    const root = broker.roots.add({ label: 'audit', path: rootPath, readOnly: true });

    // No grant yet: the refusal is REPORTED as a code, not swallowed as "no hits".
    const refused = await drafts.runDraft(draft.id, {
      args: { projectId: root.id, query: 'invites' },
    });
    expect(refused.ok).toBe(true);
    if (refused.ok) expect(refused.result).toMatchObject({ ok: false, reason: 'tool_denied' });

    broker.grants.add('files.search', root.id);
    const found = await drafts.runDraft(draft.id, {
      args: { projectId: root.id, query: 'invites' },
    });
    expect(found.ok).toBe(true);
    if (found.ok) {
      expect(found.result).toMatchObject({
        ok: true,
        query: 'invites',
        hits: 1,
        files: 1,
        truncated: false,
      });
      const matches = (
        found.result as { matches: Array<{ path: string; samples: Array<{ text: string }> }> }
      ).matches;
      expect(matches[0]?.path).toBe('notes.md');
      expect(matches[0]?.samples[0]?.text).toContain('send the invites');
    }
  }, 20_000);
});
