/**
 * M27 S2 — MCP reach from the skill sandbox (PLAN-M27.md S2, decisions D5–D8).
 *
 * A skill could not reach MCP at all before this slice: MCP existed only as a
 * chat-side external tool, where the paired session IS the user and a
 * medium-risk call rides the approval queue. A skill is not the user and cannot
 * be asked anything, so its rules are different in kind:
 *
 *   - the reach is DECLARED (D5) as `permissions.mcpServers` — server ids, never
 *     tool names, because a server is configured later and a manifest must not
 *     be able to name a tool that does not exist yet;
 *   - it needs a `medium`-or-higher ceiling (D6), because an MCP tool's own risk
 *     is unknowable in advance — refused at VALIDATE time, so the owner never
 *     sees an install card for a skill that could never run;
 *   - it is CLASS-gated before everything else (D7), exactly as the broker's
 *     envelope sits above the grant, so a session that may not call MCP learns
 *     nothing about what is declared or configured behind it;
 *   - it is NEVER interactive (D8): a disabled, undeclared or failing server is a
 *     CODED refusal the skill can catch, and no pending row is created — the
 *     assertions count the WHOLE `pending_tools` table, not just its open rows,
 *     because "no row is ever created" is the guarantee, not the narrower
 *     "none is left open";
 *   - it is AUDITED (M27 S2 fix-up): every refusal writes exactly one
 *     `mcp.call.denied` row — actor `skill`, the server id as the target, and
 *     the code + tool id as details. The invocation itself cannot carry that
 *     fact: the template CATCHES the coded denial, so `skill.invoke` records
 *     ok:true with toolCalls:1, and a denial above the server lookup never
 *     reaches the manager's own `mcp.call` row.
 *
 * TRANSPORT: a REAL stdio MCP server, implemented as a tiny inline Node script
 * spawned with `process.execPath` — the same fixture discipline
 * `core/test/mcp/mcpManager.test.ts` established. That exercises the real
 * manager, the real client and the real seam with NO network access, which is
 * why these tests are deterministic and offline.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SkillDetail, SkillManifest, ToolRisk } from '@partner/shared';
import type { AuditRow } from '../../src/stores/types.js';
import { demoHarness, makeTempRoot, removeTempRoot } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { validateManifestShape } from '../../src/skills/manifest.js';
import { permissionSummary } from '../../src/skills/runtime.js';
import { authoringInstructions } from '../../src/chat/instructions.js';
import { createMcpSkillReach } from '../../src/mcp/skillReach.js';

const NODE = process.execPath;

/** A minimal MCP server: initialize, tools/list, tools/call (echo/explode/huge/hang). */
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
      { name: 'echo', description: 'echo arguments', inputSchema: { type: 'object' } },
      { name: 'explode', description: 'always errors', inputSchema: { type: 'object' } },
      { name: 'huge', description: 'returns far more text than the result cap', inputSchema: { type: 'object' } }
    ] } }) + '\\n');
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    if (name === 'hang') return; // never responds
    if (name === 'huge') {
      // The client caps ONE text item at 200k chars, so an oversized RESULT has
      // to be several items — which is what a real server returning a lot of
      // output looks like once it has crossed the MCP seam.
      const item = { type: 'text', text: 'y'.repeat(200000) };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [item, item, item, item, item, item, item, item] } }) + String.fromCharCode(10));
      return;
    }
    if (name !== 'echo' && name !== 'explode') {
      // A real server refuses a name it does not serve with a JSON-RPC error.
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32602, message: 'unknown tool: ' + name } }) + String.fromCharCode(10));
      return;
    }
    if (name === 'explode') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'boom' }], isError: true } }) + '\\n');
      return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echoed:' + JSON.stringify(msg.params.arguments || {}) }] } }) + '\\n');
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }) + '\\n');
});
`;

/** A skill that reaches one MCP tool and reports what it got back. */
const ENTRY = `export async function run(args = {}) {
  try {
    const out = await globalThis.partner.tools.exec(args.toolId, args.params || {});
    globalThis.partner.log('mcp ok');
    return { ok: true, out };
  } catch (err) {
    globalThis.partner.log('mcp refused: ' + err.code);
    return { refused: err.code };
  }
}`;

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

function serverScript(): string {
  const dir = mkdtempSync(join(tmpdir(), 'partner-mcpreach-'));
  const file = join(dir, 'fake-server.cjs');
  writeFileSync(file, FAKE_SERVER);
  dirs.push(dir);
  return file;
}

interface Env {
  h: Harness;
  serverId: string;
  /** Install a skill declaring this reach, and hand back its detail. */
  install(options?: {
    id?: string;
    risk?: ToolRisk;
    mcpServers?: string[] | undefined;
    code?: string;
  }): SkillDetail;
  invoke(detail: SkillDetail, args: unknown, ctx?: { clientClass?: string }): Promise<
    { ok: true; result: unknown } | { ok: false; error: string }
  >;
}

function buildEnv(): Env {
  const storeDir = makeTempRoot();
  dirs.push(storeDir);
  const h = demoHarness({ skills: { storeDir } });
  harnesses.push(h);
  const mcp = h.mcp;
  if (mcp === undefined) throw new Error('the MCP manager is unwired in this harness');
  const runner = h.skillRunner;
  if (runner === undefined) throw new Error('the skill runner is unwired in this harness');

  const created = mcp.create({ name: 'fake', command: NODE, args: [serverScript()] });
  mcp.update(created.id, { enabled: true });

  return {
    h,
    serverId: created.id,
    install(options = {}) {
      const id = options.id ?? 'mcp-skill';
      const manifest: SkillManifest = {
        id,
        name: 'MCP skill',
        description: 'calls one MCP tool',
        author: 'tests',
        version: '0.1.0',
        entrypoint: 'entry.mjs',
        permissions: {
          tools: [],
          network: false,
          // D6: an MCP-calling manifest must present at least medium.
          risk: options.risk ?? 'medium',
          ...(options.mcpServers === undefined
            ? { mcpServers: [created.id] }
            : { mcpServers: options.mcpServers }),
        },
        budget: { timeMs: 20_000 },
      };
      const skills = h.skills;
      if (skills === undefined) throw new Error('the skills manager is unwired in this harness');
      skills.installFromBundle(
        { manifest, code: options.code ?? ENTRY },
        { update: false, source: 'authored' },
      );
      const detail = skills.get(id);
      if (detail === null) throw new Error(`skill ${id} did not install`);
      return detail;
    },
    async invoke(detail, args, ctx) {
      const result = await runner.invoke(detail, args, ctx ?? {});
      return result.ok
        ? { ok: true, result: result.result }
        : { ok: false, error: String(result.error) };
    },
  };
}

/**
 * D8's guarantee is "no pending row is EVER created", which is stronger than
 * "none is left open": `pendingManager.list()` returns OPEN rows only, so a
 * build that took the broker's enqueue-then-decide(deny) route would leave a
 * CLOSED row that check could not see. Assert the table's TOTAL count beside it.
 */
function expectNoPendingRows(h: Harness): void {
  expect(h.pendingManager?.list() ?? []).toEqual([]);
  const counted = h.db.prepare('SELECT COUNT(*) AS n FROM pending_tools').get() as
    | { n: number }
    | undefined;
  expect(counted?.n).toBe(0);
}

/** Every `mcp.call.denied` row this harness holds (newest first). */
function denialRows(h: Harness): AuditRow[] {
  return h.audit.query({ limit: 50, action: 'mcp.call.denied' });
}

/**
 * The ONE audit row a refused MCP call must leave, whatever refused it: actor
 * `skill`, the server id as target, the code + tool id as details, and nothing
 * from the arguments. The invocation itself cannot carry this fact — the skill
 * catches the coded denial, so `skill.invoke` records ok:true, toolCalls:1 —
 * which is why a refusal with no row means the attempt is invisible.
 */
function onlyDenial(h: Harness): { target: string; details: Record<string, unknown> } {
  const rows = denialRows(h);
  expect(rows).toHaveLength(1);
  const row = rows[0];
  expect(row?.actor).toBe('skill');
  return {
    target: String(row?.target),
    details: JSON.parse(String(row?.details)) as Record<string, unknown>,
  };
}

describe('M27 S2 — a declared server’s tool RUNS through the sandbox', () => {
  it('calls an enabled MCP tool and returns its content to the skill', async () => {
    const env = buildEnv();
    const detail = env.install();
    const out = await env.invoke(detail, {
      toolId: `mcp:${env.serverId}/echo`,
      params: { hello: 'world' },
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The result carries the server/tool identity and the flattened text — the
    // same shape the chat-side MCP external produces, so one server reads the
    // same whichever surface called it.
    expect(out.result).toMatchObject({ ok: true });
    const inner = (out.result as { out: Record<string, unknown> }).out;
    expect(inner.server).toBe(env.serverId);
    expect(inner.tool).toBe('echo');
    expect(inner.output_1).toContain('echoed:');
    expect(inner.output_1).toContain('world');
    expect(inner.contentItems).toBe(1);
    // A call that SUCCEEDED is not a denial: the denial row is the refusal
    // record only.
    expect(denialRows(env.h)).toEqual([]);
  });

  it('counts the call as a tool call on the invocation, and creates no pending row', async () => {
    const env = buildEnv();
    const detail = env.install();
    await env.invoke(detail, { toolId: `mcp:${env.serverId}/echo`, params: {} });
    // An MCP call IS a tool call the skill made; the meta row keeps that meaning.
    const rows = env.h.skillInvocationStore.listBySkill(detail.id, 10);
    expect(rows[0]?.toolCalls).toBe(1);
    expectNoPendingRows(env.h);
  });
});

describe('M27 S2 — the execution row says WHO asked', () => {
  it('attributes a skill-reached call to `skill`, not to a web request that never happened', async () => {
    const env = buildEnv();
    const detail = env.install();
    const out = await env.invoke(detail, { toolId: `mcp:${env.serverId}/echo`, params: {} });
    expect(out.ok).toBe(true);
    const rows = env.h.audit.query({ limit: 10, action: 'mcp.call' });
    expect(rows.length).toBe(1);
    // The manager hardcoded `web` here, so a skill's reach read as a web request
    // the user never made — `skill` is the vocabulary the runner already uses
    // for the same actor (services/redaction.ts: session/web/persona/skill).
    expect(rows[0]?.actor).toBe('skill');
    expect(env.h.audit.query({ limit: 10, action: 'mcp.call', actor: 'web' })).toEqual([]);
  });

  it('keeps the row id/count only — no server command line, no tool arguments', async () => {
    const env = buildEnv();
    const detail = env.install();
    await env.invoke(detail, {
      toolId: `mcp:${env.serverId}/echo`,
      params: { secret: 'sk-super-secret-value' },
    });
    const rows = env.h.audit.query({ limit: 10, action: 'mcp.call' });
    expect(rows[0]?.details).not.toContain('sk-super-secret-value');
    expect(rows[0]?.details).not.toContain('fake-server.cjs');
    expect(rows[0]?.details).toContain('echo');
  });
});

describe('M27 S2 — every refusal is CODED, and none of them queues anything', () => {
  it('an UNDECLARED server is mcp_not_declared', async () => {
    const env = buildEnv();
    // The manifest declares some other server, so this id is not reachable.
    const detail = env.install({ mcpServers: ['some-other-server'] });
    const out = await env.invoke(detail, { toolId: `mcp:${env.serverId}/echo`, params: {} });
    expect(out).toEqual({ ok: true, result: { refused: 'mcp_not_declared' } });
    expectNoPendingRows(env.h);
    expect(onlyDenial(env.h)).toMatchObject({
      target: env.serverId,
      details: { code: 'mcp_not_declared', tool: 'echo' },
    });
  });

  it('a DENIAL row carries ids and the code only — never the tool arguments', async () => {
    const env = buildEnv();
    const detail = env.install({ mcpServers: ['some-other-server'] });
    // The refusal happens above the manager's own `mcp.call` row, so the denial
    // row is the ONLY record of this call: it must not smuggle in what the skill
    // passed (the repo's audit rule), nor the server's command line.
    const out = await env.invoke(detail, {
      toolId: `mcp:${env.serverId}/echo`,
      params: { secret: 'sk-super-secret-value', path: 'C:/Users/someone/private' },
    });
    expect(out).toEqual({ ok: true, result: { refused: 'mcp_not_declared' } });
    const row = denialRows(env.h)[0];
    expect(row?.details).not.toContain('sk-super-secret-value');
    expect(row?.details).not.toContain('private');
    expect(row?.details).not.toContain('fake-server.cjs');
    expect(row?.target).toBe(env.serverId);
    expect(JSON.parse(String(row?.details))).toEqual({
      code: 'mcp_not_declared',
      tool: 'echo',
    });
    // And the whole audit list holds no argument content either.
    const everything = JSON.stringify(env.h.audit.list(200).map((r) => r.details));
    expect(everything).not.toContain('sk-super-secret-value');
  });

  it('a DISABLED server is mcp_disabled', async () => {
    const env = buildEnv();
    const detail = env.install();
    env.h.mcp?.update(env.serverId, { enabled: false });
    const out = await env.invoke(detail, { toolId: `mcp:${env.serverId}/echo`, params: {} });
    expect(out).toEqual({ ok: true, result: { refused: 'mcp_disabled' } });
    expectNoPendingRows(env.h);
    expect(onlyDenial(env.h)).toMatchObject({
      target: env.serverId,
      details: { code: 'mcp_disabled', tool: 'echo' },
    });
  });

  it('a server that is not CONFIGURED at all is mcp_disabled, not a crash', async () => {
    const env = buildEnv();
    const detail = env.install({ mcpServers: ['never-configured'] });
    const out = await env.invoke(detail, { toolId: 'mcp:never-configured/echo', params: {} });
    expect(out).toEqual({ ok: true, result: { refused: 'mcp_disabled' } });
    expectNoPendingRows(env.h);
    // Never configured is the same user act as switched off ("configure it, then
    // enable it"), so it shares the code — and now the audit trail as well.
    expect(onlyDenial(env.h)).toMatchObject({
      target: 'never-configured',
      details: { code: 'mcp_disabled', tool: 'echo' },
    });
  });

  it('a tool the SERVER reports as failed is upstream', async () => {
    const env = buildEnv();
    const detail = env.install();
    const out = await env.invoke(detail, { toolId: `mcp:${env.serverId}/explode`, params: {} });
    expect(out).toEqual({ ok: true, result: { refused: 'upstream' } });
    expectNoPendingRows(env.h);
    // The manager's own mcp.call row records the execution; this seam's row
    // records that the SKILL was refused, which its own run cannot carry.
    expect(onlyDenial(env.h)).toMatchObject({
      target: env.serverId,
      details: { code: 'upstream', tool: 'explode' },
    });
  });

  it('an UNKNOWN tool name on a real server is upstream (the server owns its catalog)', async () => {
    const env = buildEnv();
    const detail = env.install();
    const out = await env.invoke(detail, { toolId: `mcp:${env.serverId}/no-such-tool`, params: {} });
    expect(out).toEqual({ ok: true, result: { refused: 'upstream' } });
    expectNoPendingRows(env.h);
    expect(onlyDenial(env.h)).toMatchObject({
      target: env.serverId,
      details: { code: 'upstream', tool: 'no-such-tool' },
    });
  });

  it('a malformed mcp id is tool_denied and never reaches the broker', async () => {
    const env = buildEnv();
    const detail = env.install();
    // No `/tool` segment: not an MCP id, and not a broker tool either.
    const out = await env.invoke(detail, { toolId: 'mcp:server-only', params: {} });
    expect(out).toEqual({ ok: true, result: { refused: 'tool_denied' } });
    expectNoPendingRows(env.h);
    // The seam was never entered (the runner routes on the SAME id shape), so
    // there is no MCP denial to record — this refusal is the broker's ordinary
    // one, audited like every other broker refusal.
    expect(denialRows(env.h)).toEqual([]);
  });

  it('a broken server (command that cannot spawn) is upstream, not a crashed invocation', async () => {
    const env = buildEnv();
    const mcp = env.h.mcp;
    if (mcp === undefined) throw new Error('unwired');
    const broken = mcp.create({ name: 'broken', command: 'definitely-not-a-real-command-xyz', args: [] });
    mcp.update(broken.id, { enabled: true });
    const detail = env.install({ id: 'broken-skill', mcpServers: [broken.id] });
    const out = await env.invoke(detail, { toolId: `mcp:${broken.id}/echo`, params: {} });
    // The INVOCATION succeeds and the skill sees a refusal it can handle — a
    // thrown error here would have failed the whole run instead.
    expect(out).toEqual({ ok: true, result: { refused: 'upstream' } });
  });
});

describe('M27 S2 — the ceiling (D6) is enforced at VALIDATE time', () => {
  const BASE = {
    id: 'x-skill',
    name: 'X',
    description: 'does x',
    author: 'me',
    version: '1.0.0',
    entrypoint: 'entry.mjs',
  };

  it('refuses MCP on a low-risk manifest, naming the reason', () => {
    const result = validateManifestShape(
      { ...BASE, permissions: { mcpServers: ['local'], risk: 'low' } },
      { capabilities: { mcp: true, llm: true, notes: true } },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(' ')).toContain('medium');
  });

  it('accepts the same declaration at medium and at high', () => {
    for (const risk of ['medium', 'high'] as const) {
      const result = validateManifestShape(
        { ...BASE, permissions: { mcpServers: ['local'], risk } },
        { capabilities: { mcp: true, llm: true, notes: true } },
      );
      expect(result.ok, `risk=${risk}`).toBe(true);
      if (result.ok) expect(result.manifest.permissions.mcpServers).toEqual(['local']);
    }
  });

  it('refuses MCP while the capability is unwired, whatever the risk', () => {
    // The library default: a build that has not wired the reach must not accept
    // the declaration, or it would install a skill that can never run.
    const result = validateManifestShape({
      ...BASE,
      permissions: { mcpServers: ['local'], risk: 'medium' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(' ')).toContain('not supported yet');
  });

  it('de-duplicates server ids and caps the list', () => {
    const dup = validateManifestShape(
      { ...BASE, permissions: { mcpServers: ['a', 'b', 'a'], risk: 'medium' } },
      { capabilities: { mcp: true, llm: true, notes: true } },
    );
    expect(dup.ok).toBe(true);
    if (dup.ok) expect(dup.manifest.permissions.mcpServers).toEqual(['a', 'b']);

    const many = Array.from({ length: 9 }, (_, i) => `s${i}`);
    const over = validateManifestShape(
      { ...BASE, permissions: { mcpServers: many, risk: 'medium' } },
      { capabilities: { mcp: true, llm: true, notes: true } },
    );
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.errors.join(' ')).toContain('at most 8 servers');
  });

  it('re-runs the D6 ceiling at RUN time too (an installed low manifest is no loophole)', async () => {
    const env = buildEnv();
    // Forge the detail directly rather than going through validation: this is
    // exactly the shape a manifest installed BEFORE the rule would have.
    const detail = env.install();
    const forged: SkillDetail = {
      ...detail,
      manifest: { ...detail.manifest, permissions: { ...detail.manifest.permissions, risk: 'low' } },
    };
    const out = await env.invoke(forged, { toolId: `mcp:${env.serverId}/echo`, params: {} });
    expect(out).toEqual({ ok: true, result: { refused: 'tool_denied' } });
    expect(onlyDenial(env.h).details.code).toBe('tool_denied');
  });
});

describe('M27 S2 — the class envelope sits ABOVE everything (D7)', () => {
  it('refuses a MOBILE session before it learns whether the server is declared', async () => {
    const env = buildEnv();
    // Declared AND enabled AND medium-risk: the ONLY thing refusing this call is
    // the session's class.
    const detail = env.install();
    const out = await env.invoke(
      detail,
      { toolId: `mcp:${env.serverId}/echo`, params: {} },
      { clientClass: 'mobile' },
    );
    expect(out).toEqual({ ok: true, result: { refused: 'capability_denied' } });
    expectNoPendingRows(env.h);
    // D7's point is that a refused class learns NOTHING about what is behind the
    // gate — the row therefore names the SERVER the call asked for and no fact
    // about its declaration or state.
    expect(onlyDenial(env.h)).toMatchObject({
      target: env.serverId,
      details: { code: 'capability_denied', tool: 'echo' },
    });
  });

  it('refuses an EXTENSION session the same way', async () => {
    const env = buildEnv();
    const detail = env.install();
    const out = await env.invoke(
      detail,
      { toolId: `mcp:${env.serverId}/echo`, params: {} },
      { clientClass: 'extension' },
    );
    expect(out).toEqual({ ok: true, result: { refused: 'capability_denied' } });
    expect(onlyDenial(env.h).details.code).toBe('capability_denied');
  });

  it('keeps DESKTOP reach (the positive control, so the gate is not a blanket deny)', async () => {
    const env = buildEnv();
    const detail = env.install();
    const out = await env.invoke(
      detail,
      { toolId: `mcp:${env.serverId}/echo`, params: {} },
      { clientClass: 'desktop' },
    );
    expect(out.ok).toBe(true);
    if (out.ok) expect((out.result as { ok: boolean }).ok).toBe(true);
  });

  it('an absent class keeps the desktop envelope (an internal persona/scheduled run)', async () => {
    const env = buildEnv();
    const detail = env.install();
    const out = await env.invoke(detail, { toolId: `mcp:${env.serverId}/echo`, params: {} });
    expect(out.ok).toBe(true);
    if (out.ok) expect((out.result as { ok: boolean }).ok).toBe(true);
  });

  it('the class comes from the CONTEXT, never from the skill’s args', async () => {
    const env = buildEnv();
    const detail = env.install();
    // A skill that tries to name its own class gains nothing: `clientClass` is
    // not read from params anywhere on this path.
    const out = await env.invoke(
      detail,
      { toolId: `mcp:${env.serverId}/echo`, params: { clientClass: 'desktop' } },
      { clientClass: 'mobile' },
    );
    expect(out).toEqual({ ok: true, result: { refused: 'capability_denied' } });
    expect(onlyDenial(env.h).details.code).toBe('capability_denied');
  });
});

describe('M27 S2 — the reach is bounded like every other', () => {
  it('the 1 MiB result cap still applies to a REAL oversized MCP result', async () => {
    const env = buildEnv();
    // A real call whose RESULT is far past the cap: the fixture server answers
    // `huge` with 8 × 200k chars (the MCP client caps one text item at 200k, so
    // an oversized result has to arrive as several), the seam flattens them into
    // the result it hands the skill, and the entry returns that result. The cap
    // is the runner's and the worker's, and it must hold for a payload that
    // really crossed the MCP seam — this test fails if the seam is deleted.
    const detail = env.install({ id: 'huge-skill' });
    const out = await env.invoke(detail, { toolId: `mcp:${env.serverId}/huge`, params: {} });
    expect(out).toEqual({ ok: false, error: 'caps_exceeded' });
    // It was an oversized RESULT, not a refusal: the server answered the call.
    expect(denialRows(env.h)).toEqual([]);
    const calls = env.h.audit.query({ limit: 10, action: 'mcp.call' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.target).toBe(env.serverId);
  }, 20_000);

  it('the budget still kills a run that an MCP call makes slow', async () => {
    const env = buildEnv();
    // `hang` never answers: the manifest's own timeMs expiry must fire rather
    // than the invocation hanging forever.
    const detail = env.install();
    const short: SkillDetail = {
      ...detail,
      manifest: { ...detail.manifest, budget: { timeMs: 1500 } },
    };
    const out = await env.invoke(short, { toolId: `mcp:${env.serverId}/hang`, params: {} });
    expect(out).toEqual({ ok: false, error: 'budget_exceeded' });
  }, 20_000);
});

describe('M27 S2 — every surface describes the same reach (D9)', () => {
  const manifest: SkillManifest = {
    id: 'x',
    name: 'X',
    description: 'x',
    author: 'tests',
    version: '0.1.0',
    entrypoint: 'entry.mjs',
    permissions: { tools: [], network: false, risk: 'medium', mcpServers: ['local-notes'] },
    budget: { timeMs: 5000 },
  };

  it('the INSTALL SUMMARY says what the MCP reach is, in the owner\u2019s words', () => {
    const summary = permissionSummary(manifest).join('\n');
    expect(summary).toContain('MCP server "local-notes"');
    // ...and the ceiling the owner is being asked to accept.
    expect(summary).toContain('is treated as medium risk');
  });

  it('the CHAT INSTRUCTIONS name the reach only when the build honours it', () => {
    const wired = authoringInstructions(['files.read'], { mcp: true });
    expect(wired).toContain('mcpServers');
    expect(wired).toContain('mcp:<server>/<tool>');
    expect(wired).toContain('medium');

    const unwired = authoringInstructions(['files.read'], { mcp: false });
    expect(unwired).not.toContain('mcpServers');
    expect(unwired).not.toContain('mcp:<server>/<tool>');
  });

  it('the chat instructions are unchanged when no capabilities are passed', () => {
    // Backward compatibility: the existing caller shape still produces the text
    // it always did, so an embedder that did not adopt the new argument is not
    // silently told about reaches it may not have.
    expect(authoringInstructions(['files.read'])).toBe(
      authoringInstructions(['files.read'], { mcp: false, llm: false }),
    );
  });
});

describe('M27 S2 — the seam recognises the same id shape the runner routes on', () => {
  it('matches every mcp: id and nothing else', () => {
    // The runner duplicates this regex to avoid importing `mcp/`; this pins the
    // two together so they cannot drift.
    const reach = createMcpSkillReach(undefined);
    for (const id of ['mcp:a/b', 'mcp:server-id/tool.name', 'mcp:x/y/z']) {
      expect(reach.matches(id), id).toBe(true);
    }
    for (const id of ['files.read', 'mcp:', 'mcp:only', 'notes.read', 'search']) {
      expect(reach.matches(id), id).toBe(false);
    }
  });

  it('a MULTI-SEGMENT tool name reaches the seam, not the broker', async () => {
    const env = buildEnv();
    // The manifest declares some OTHER server, so the answer is decided by the
    // seam's declaration gate. If the runner's duplicated id regex stopped
    // routing `mcp:<server>/a/b`, the id would fall through to the declared-
    // tools check and answer `tool_denied` — `mcp_not_declared` is reachable
    // ONLY through the seam, which is what makes this distinguish the two.
    const detail = env.install({ mcpServers: ['some-other-server'] });
    const out = await env.invoke(detail, { toolId: `mcp:${env.serverId}/a/b`, params: {} });
    expect(out).toEqual({ ok: true, result: { refused: 'mcp_not_declared' } });
    // The tool id keeps its slashes: only the FIRST segment is the server.
    expect(onlyDenial(env.h).details.tool).toBe('a/b');
  });

  it('a build with no MCP manager wired denies with tool_denied, never throws', async () => {
    const reach = createMcpSkillReach(undefined);
    const out = await reach.exec({
      toolId: 'mcp:someone/echo',
      args: {},
      declaredServers: ['someone'],
      manifestRisk: 'medium',
    });
    expect(out).toEqual({ ok: false, code: 'tool_denied' });
  });
});
