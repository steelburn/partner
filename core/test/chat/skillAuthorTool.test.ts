/**
 * M26 cut C — the chat authoring tools + the D8 advertisement rule
 * (PLAN-M26.md).
 *
 * The invariants:
 *
 *   1. THE ADVERTISED SET CANNOT RUN OR INSTALL ANYTHING. The two ids are the
 *      whole set, and calling both leaves the skills store empty — a model may
 *      write code and ask, nothing more.
 *   2. D8 IS A CONJUNCTION. Desktop session AND `skill.author` AND independence
 *      >= suggest AND neither tool banned; an `assist` persona gets neither the
 *      contract nor the tools.
 *   3. A turn that is not allowed is REFUSED BY CLASS, with the device note the
 *      broker tools already get, and audited as `capability.denied`.
 *   4. Iteration works: a bad manifest comes back with its problems, and a
 *      second call with the same id and a fixed bundle validates.
 */
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Persona } from '@partner/shared';
import { runNativeToolCalls } from '../../src/chat/toolPass.js';
import type { ChatToolPassDeps } from '../../src/chat/toolPass.js';
import { authoringInstructions } from '../../src/chat/instructions.js';
import {
  AUTHORING_TOOL_IDS,
  DRAFT_TOOL_ID,
  REQUEST_INSTALL_TOOL_ID,
  authoringToolExternal,
  canAdvertiseAuthoring,
} from '../../src/skills/tool.js';
import { ALLOWED_HOST, demoHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { startHttpServer, sseReply } from '../support/server.js';

function persona(
  level: Persona['independence']['level'],
  banned: string[] = [],
): Persona {
  return {
    id: 'p-1',
    name: 'Builder',
    character: { voice: 'v', language: 'en', systemPrompt: '', temperature: 0.7 },
    model: { taskClasses: {} },
    independence: { level, requireHumanFor: ['high'], autoScopes: [] },
    memory: { userProfile: 'none', episodes: 'none' },
    ...(banned.length > 0 ? { policy: { tools: { banned } } } : {}),
    isDefault: false,
    paused: false,
    createdAt: 1,
    updatedAt: 1,
  };
}

/** The real drafts manager over an in-memory test core (no fakes here: the
 *  point is that the tools cannot reach an install, and only the real store can
 *  prove that). */
function harness(): Harness {
  return demoHarness();
}

function authoringProvider(h: Harness, conversationId = 'conv-1') {
  const broker = h.broker as NonNullable<Harness['broker']>;
  return authoringToolExternal({
    drafts: h.skillDrafts,
    // The live broker registry, exactly as the chat route passes it.
    toolIds: new Set(broker.manifests.map((manifest) => manifest.id)),
    conversationId,
    personaId: 'p-analyst',
  });
}

function calls(
  h: Harness,
  callsIn: Array<{ name: string; arguments: string }>,
  deps: Partial<ChatToolPassDeps> = {},
) {
  const broker = h.broker as NonNullable<Harness['broker']>;
  const provider = authoringProvider(h);
  const notes: string[] = [];
  const run = runNativeToolCalls(callsIn, {
    persona: persona('suggest'),
    broker,
    external: provider === undefined ? [] : [provider],
    audit: h.audit,
    conversationId: 'conv-1',
    appendSystemNote: (content) => notes.push(content),
    ...deps,
  });
  return { run, notes };
}

describe('authoringInstructions', () => {
  const text = authoringInstructions(['files.read', 'files.search']);

  it('states the contract the worker actually implements', () => {
    expect(text).toContain('partner.tools.exec');
    expect(text).toContain('export async function run');
    expect(text).toContain('no network access');
  });

  it('names the exact declarable tool ids and both tools', () => {
    expect(text).toContain('files.read, files.search');
    expect(text).toContain(DRAFT_TOOL_ID);
    expect(text).toContain(REQUEST_INSTALL_TOOL_ID);
  });

  it('forbids installing and requires re-calling the same id to fix errors', () => {
    expect(text).toContain('You CANNOT install a skill');
    expect(text).toContain('SAME id');
    expect(text).toContain('cannot run a draft');
    expect(text).toContain('NO network access');
  });

  it('teaches the FLOW vocabulary (M28 E), with the llm node only where it exists', () => {
    // One vocabulary, one place: the instructions CALL the same `flowContract`
    // the flow prompts and the Studio palette mirror, so the chat cannot
    // describe a node type the compiler would refuse.
    expect(text).toContain('A FLOW is the other way to author the same entry');
    for (const type of [
      'input',
      'const',
      'tool',
      'template',
      'filter',
      'map',
      'branch',
      'merge',
      'output',
    ]) {
      expect(text).toContain(type);
    }
    // No model reach in this call, so no `llm` node is offered — and the
    // prohibition is stated rather than left implicit.
    expect(text).toContain('the `llm` node does NOT exist in this build');
    const wired = authoringInstructions(['files.read'], { llm: true });
    expect(wired).toContain('llm      {"prompt"');
    expect(wired).not.toContain('does NOT exist in this build');
  });
});

describe('D8: when authoring is advertised at all', () => {
  it('holds only for desktop + >= suggest + no ban', () => {
    expect(canAdvertiseAuthoring({ persona: persona('suggest'), clientClass: 'desktop' })).toBe(
      true,
    );
    expect(canAdvertiseAuthoring({ persona: persona('auto'), clientClass: 'desktop' })).toBe(true);
    expect(
      canAdvertiseAuthoring({ persona: persona('autonomous'), clientClass: 'desktop' }),
    ).toBe(true);
  });

  it('refuses an assist persona, another class, and a banned tool', () => {
    expect(canAdvertiseAuthoring({ persona: persona('assist'), clientClass: 'desktop' })).toBe(
      false,
    );
    expect(canAdvertiseAuthoring({ persona: persona('suggest'), clientClass: 'mobile' })).toBe(
      false,
    );
    expect(canAdvertiseAuthoring({ persona: persona('suggest'), clientClass: 'extension' })).toBe(
      false,
    );
    // An unknown class is denied rather than assumed (the envelope's rule).
    expect(canAdvertiseAuthoring({ persona: persona('suggest'), clientClass: 'tablet' })).toBe(
      false,
    );
    expect(
      canAdvertiseAuthoring({ persona: persona('suggest', [DRAFT_TOOL_ID]), clientClass: 'desktop' }),
    ).toBe(false);
    expect(
      canAdvertiseAuthoring({
        persona: persona('suggest', [REQUEST_INSTALL_TOOL_ID]),
        clientClass: 'desktop',
      }),
    ).toBe(false);
  });
});

describe('the advertised set', () => {
  it('is exactly the two inert tools, with no network and a class capability', () => {
    const h = harness();
    try {
      const provider = authoringProvider(h);
      expect(provider).toBeDefined();
      const ids = provider?.manifests.map((manifest) => manifest.id) ?? [];
      expect(ids).toEqual([DRAFT_TOOL_ID, REQUEST_INSTALL_TOOL_ID]);
      expect(provider?.capability).toBe('skill.author');
      for (const manifest of provider?.manifests ?? []) {
        // Every advertised tool is offline, and the ONLY ids are these two.
        expect(manifest.network).toBe(false);
        expect(AUTHORING_TOOL_IDS).toContain(manifest.id);
      }
    } finally {
      h.close();
    }
  });

  it('cannot install or run a draft, whatever it is asked to do', async () => {
    const h = harness();
    try {
      const provider = authoringProvider(h);
      const draftCall = JSON.stringify({
        name: 'Scratch To Checklist',
        description: 'turns notes into a checklist',
        tools: ['files.read'],
        code: 'export async function run(args){ return { ok: true }; }',
      });
      const staged = await provider?.exec(DRAFT_TOOL_ID, JSON.parse(draftCall));
      expect(staged).toMatchObject({ outcome: 'executed' });
      const stagedResult = (staged as { result: Record<string, unknown> }).result;
      const draftId = String(stagedResult.draftId);
      expect(stagedResult.ok).toBe(true);

      // Both advertised tools were used, and NOTHING became executable or
      // installed: the drafts manager is the only thing that moved.
      const asked = await provider?.exec(REQUEST_INSTALL_TOOL_ID, { draftId });
      expect(asked).toMatchObject({ outcome: 'executed' });
      expect(h.skills?.list()).toEqual([]);
      expect(h.skillDrafts?.get(draftId)?.status).toBe('draft');

      // There is no entry point on the provider that promotes or runs one.
      expect(Object.keys(provider ?? {})).not.toContain('promote');
      expect(Object.keys(provider ?? {})).not.toContain('runDraft');
    } finally {
      h.close();
    }
  });
});

describe('the tool pass with the authoring provider', () => {
  it('stages a draft, names the problems, and fixes them on a second call', async () => {
    const h = harness();
    try {
      // A manifest the core refuses at SHAPE level (risk is not a risk tier):
      // it stages, and the validation result says exactly what is wrong.
      const bad = JSON.stringify({
        name: 'Scratch To Checklist',
        manifestText: JSON.stringify({
          id: 'scratch-to-checklist',
          name: 'Scratch To Checklist',
          description: 'turns notes into a checklist',
          author: 'Partner',
          version: '0.1.0',
          entrypoint: 'entry.mjs',
          permissions: { tools: [], network: false, risk: 'extreme' },
          budget: { timeMs: 5000 },
        }),
        code: 'export function run(args){ return { ok: true }; }',
      });
      const first = calls(h, [{ name: DRAFT_TOOL_ID, arguments: bad }]);
      const firstPass = await first.run;
      expect(firstPass.decisions).toEqual([{ toolId: DRAFT_TOOL_ID, decision: 'executed' }]);
      const firstNote = first.notes.join('\n');
      expect(firstNote).toContain('problems:');
      expect(firstNote).toContain('risk');
      const draftId = /draftId: ([A-Za-z0-9._-]+)/.exec(firstNote)?.[1] ?? '';
      expect(draftId).not.toBe('');
      expect(draftId).not.toBe('null');
      expect(h.skillDrafts?.get(draftId)?.validation.ok).toBe(false);

      // The L2 loop: same id, fixed manifest -> valid.
      const fixed = JSON.stringify({
        id: draftId,
        name: 'Scratch To Checklist',
        manifestText: JSON.stringify({
          id: draftId,
          name: 'Scratch To Checklist',
          description: 'turns notes into a checklist',
          author: 'Partner',
          version: '0.1.0',
          entrypoint: 'entry.mjs',
          permissions: { tools: [], network: false, risk: 'low' },
          budget: { timeMs: 5000 },
        }),
        code: 'export function run(args){ return { ok: true }; }',
      });
      const second = await calls(h, [{ name: DRAFT_TOOL_ID, arguments: fixed }]).run;
      expect(second.decisions).toEqual([{ toolId: DRAFT_TOOL_ID, decision: 'executed' }]);
      const draft = h.skillDrafts?.get(draftId);
      expect(draft?.validation.ok).toBe(true);
      // One draft, iterated in place - not two.
      expect(h.skillDrafts?.list()).toHaveLength(1);
      expect(h.skills?.list()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('refuses a bundle the core would have to silently trim', async () => {
    const h = harness();
    try {
      const result = await calls(h, [
        {
          name: DRAFT_TOOL_ID,
          arguments: JSON.stringify({
            name: 'Wants Notes',
            tools: ['files.write'],
            code: 'export function run(){ return 1; }',
          }),
        },
      ]).run;
      expect(result.decisions).toEqual([{ toolId: DRAFT_TOOL_ID, decision: 'executed' }]);
      // Nothing staged: the tool was dropped by the sanitiser, and a draft with
      // less reach than declared is worse than a refusal.
      // NOTE (M27 S1): this used to use 'notes.read'. S1 put the app-scoped
      // notes tools IN the broker registry, so that id is now deliverable and
      // the guarantee has to be asserted with one that still is not —
      // `files.write` has never existed (the writers are edit/apply/delete).
      expect(h.skillDrafts?.list()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('asks for an install into the ACTIVE conversation and installs nothing', async () => {
    const h = harness();
    try {
      const provider = authoringProvider(h, 'conv-42');
      const staged = await provider?.exec(DRAFT_TOOL_ID, {
        name: 'Scratch To Checklist',
        tools: [],
        code: 'export function run(){ return 1; }',
      });
      const draftId = String((staged as { result: Record<string, unknown> }).result.draftId);

      const notes: string[] = [];
      const pass = await runNativeToolCalls(
        [{ name: REQUEST_INSTALL_TOOL_ID, arguments: JSON.stringify({ draftId }) }],
        {
          persona: persona('suggest'),
          broker: h.broker as NonNullable<Harness['broker']>,
          external: provider === undefined ? [] : [provider],
          audit: h.audit,
          conversationId: 'conv-42',
          appendSystemNote: (content) => notes.push(content),
        },
      );
      expect(pass.decisions).toEqual([
        { toolId: REQUEST_INSTALL_TOOL_ID, decision: 'executed' },
      ]);
      const open = h.broker?.pending.list() ?? [];
      expect(open).toHaveLength(1);
      expect(open[0]).toMatchObject({
        kind: 'skill_install',
        draftId,
        requestedBy: 'persona',
        conversationId: 'conv-42',
      });
      // The ask is all it is: still nothing installed.
      expect(h.skills?.list()).toEqual([]);
      expect(notes.join('\n')).toContain('Nothing is installed until');
    } finally {
      h.close();
    }
  });

  it('refuses a mobile turn BY CLASS, with the device note and an audit row', async () => {
    const h = harness();
    try {
      const { run, notes } = calls(
        h,
        [
          {
            name: DRAFT_TOOL_ID,
            arguments: JSON.stringify({
              name: 'Phone Draft',
              tools: [],
              code: 'export function run(){ return 1; }',
            }),
          },
        ],
        { clientClass: 'mobile' },
      );
      const result = await run;
      expect(result.decisions).toEqual([
        { toolId: DRAFT_TOOL_ID, decision: 'refused', reason: 'capability_denied' },
      ]);
      expect(notes.join('\n')).toContain('not available to this device');
      expect(h.skillDrafts?.list()).toEqual([]);
      const denied = h.audit.query({ limit: 20, action: 'capability.denied' });
      expect(denied.some((row) => row.target === DRAFT_TOOL_ID)).toBe(true);
    } finally {
      h.close();
    }
  });

  it('refuses an assist persona and a banned tool at the gate', async () => {
    const h = harness();
    try {
      const assist = await runNativeToolCalls(
        [{ name: DRAFT_TOOL_ID, arguments: '{"name":"Nope","code":"export function run(){}"}' }],
        {
          persona: persona('assist'),
          broker: h.broker as NonNullable<Harness['broker']>,
          external: [authoringProvider(h)].filter((p) => p !== undefined),
          audit: h.audit,
          conversationId: 'conv-1',
          appendSystemNote: () => undefined,
        },
      );
      expect(assist.decisions[0]).toMatchObject({ decision: 'refused' });

      const banned = await runNativeToolCalls(
        [{ name: DRAFT_TOOL_ID, arguments: '{"name":"Nope","code":"export function run(){}"}' }],
        {
          persona: persona('suggest', [DRAFT_TOOL_ID]),
          broker: h.broker as NonNullable<Harness['broker']>,
          external: [authoringProvider(h)].filter((p) => p !== undefined),
          audit: h.audit,
          conversationId: 'conv-1',
          appendSystemNote: () => undefined,
        },
      );
      expect(banned.decisions[0]).toMatchObject({
        decision: 'refused',
        reason: 'tool_banned_by_persona',
      });
      expect(h.skillDrafts?.list()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('is absent entirely when the drafts manager is not wired', () => {
    expect(authoringToolExternal({ drafts: undefined, toolIds: new Set() })).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// D8 at the ROUTE: what the model actually receives on a real chat turn. The
// predicate tests above prove the RULE; these prove the chat route APPLIES it
// to the advertised functions and the system prompt.
// ---------------------------------------------------------------------------

const upstreams: Array<{ close(): Promise<void> }> = [];

async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const pairRes = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(pairRes.status).toBe(200);
  return pairRes.body.token as string;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

afterEach(async () => {
  for (const server of upstreams.splice(0)) await server.close();
});

/** Upstream that captures every request body and streams one short reply. */
async function captureUpstream(): Promise<{ base: string; bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = [];
  const started = await startHttpServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (path === '/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }] }));
      return;
    }
    if (path === '/chat/completions') {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      req.on('end', () => {
        try {
          bodies.push(JSON.parse(raw) as Record<string, unknown>);
        } catch {
          bodies.push({});
        }
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(sseReply(['Noted.'], { prompt: 5, completion: 5 }));
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  upstreams.push(started);
  return { base: started.base, bodies };
}

function advertisedNames(body: Record<string, unknown>): string[] {
  const tools = Array.isArray(body.tools) ? body.tools : [];
  return tools.map((entry) => {
    const fn = (entry as { function?: { name?: unknown } }).function;
    return typeof fn?.name === 'string' ? fn.name : '';
  });
}

function systemText(body: Record<string, unknown>): string {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  return messages
    .filter((message) => (message as { role?: string }).role === 'system')
    .map((message) => String((message as { content?: unknown }).content ?? ''))
    .join('\n');
}

/** Force a seeded persona to a level the D8 rule cares about. */
async function setPersonaLevel(
  h: Harness,
  headers: Record<string, string>,
  personaId: string,
  level: Persona['independence']['level'],
  banned: string[] = [],
): Promise<void> {
  const persona = h.personas.get(personaId);
  expect(persona).not.toBeNull();
  const res = await request(h.app)
    .put(`/v1/personas/${personaId}`)
    .set(headers)
    .send({
      name: persona?.name,
      character: persona?.character,
      model: persona?.model,
      independence: { level, requireHumanFor: ['high'], autoScopes: [] },
      memory: persona?.memory,
      isDefault: persona?.isDefault,
      ...(banned.length > 0 ? { policy: { tools: { banned } } } : {}),
    });
  expect(res.status).toBe(200);
}

describe('D8 at the route', () => {
  it('advertises both tools AND the contract for a desktop suggest persona', async () => {
    const h = demoHarness({ demo: false });
    try {
      const upstream = await captureUpstream();
      const provider = await h.providerManager.create({
        name: 'authoring-upstream',
        endpoint: upstream.base,
        defaultModels: ['gpt-4o'],
      });
      await h.providerManager.setKey(provider.id, 'sk-fake-authoring-00000000001');
      const token = await pairToken(h);
      const headers = authed(token);
      const created = await request(h.app)
        .post('/v1/personas')
        .set(headers)
        .send({
          name: 'Author Bot',
          character: { voice: 'warm', language: 'en', systemPrompt: 'Be helpful.', temperature: 0.5 },
          model: { taskClasses: {} },
          independence: { level: 'suggest', requireHumanFor: ['high'], autoScopes: [] },
          memory: { userProfile: 'none', episodes: 'none' },
        });
      expect(created.status).toBe(201);

      await request(h.app)
        .post('/v1/chat')
        .set(headers)
        .send({
          personaId: created.body.id as string,
          tools: true,
          messages: [{ role: 'user', content: 'draft me a skill' }],
        });
      const body = upstream.bodies[0] ?? {};
      const names = advertisedNames(body);
      expect(names).toContain(DRAFT_TOOL_ID);
      expect(names).toContain(REQUEST_INSTALL_TOOL_ID);
      expect(systemText(body)).toContain('Skill authoring is available to you');
      expect(systemText(body)).toContain(REQUEST_INSTALL_TOOL_ID);
    } finally {
      h.close();
    }
  });

  it('tells an assist persona and a mobile session nothing about authoring', async () => {
    const h = demoHarness({ demo: false });
    try {
      const upstream = await captureUpstream();
      const provider = await h.providerManager.create({
        name: 'authoring-upstream-2',
        endpoint: upstream.base,
        defaultModels: ['gpt-4o'],
      });
      await h.providerManager.setKey(provider.id, 'sk-fake-authoring-00000000002');
      const token = await pairToken(h);
      const headers = authed(token);
      const created = await request(h.app)
        .post('/v1/personas')
        .set(headers)
        .send({
          name: 'Assist Bot',
          character: { voice: 'warm', language: 'en', systemPrompt: 'Be careful.', temperature: 0.5 },
          model: { taskClasses: {} },
          independence: { level: 'assist', requireHumanFor: ['high'], autoScopes: [] },
          memory: { userProfile: 'none', episodes: 'none' },
        });
      expect(created.status).toBe(201);
      await request(h.app)
        .post('/v1/chat')
        .set(headers)
        .send({
          personaId: created.body.id as string,
          tools: true,
          messages: [{ role: 'user', content: 'draft me a skill' }],
        });
      const assistBody = upstream.bodies[0] ?? {};
      expect(advertisedNames(assistBody)).not.toContain(DRAFT_TOOL_ID);
      expect(advertisedNames(assistBody)).not.toContain(REQUEST_INSTALL_TOOL_ID);
      expect(systemText(assistBody)).not.toContain('Skill authoring is available');

      // The SAME suggest persona, from a phone: no advertisement either.
      await setPersonaLevel(h, headers, 'p-analyst', 'suggest');
      const mobile = await h.sessions.create({
        kind: 'web',
        origin: ALLOWED_HOST,
        clientClass: 'mobile',
      });
      await request(h.app)
        .post('/v1/chat')
        .set({ Host: ALLOWED_HOST, Authorization: `Bearer ${mobile.token}` })
        .send({
          personaId: 'p-analyst',
          tools: true,
          messages: [{ role: 'user', content: 'draft me a skill' }],
        });
      const mobileBody = upstream.bodies[1] ?? {};
      expect(advertisedNames(mobileBody)).not.toContain(DRAFT_TOOL_ID);
      expect(advertisedNames(mobileBody)).not.toContain(REQUEST_INSTALL_TOOL_ID);
      expect(systemText(mobileBody)).not.toContain('Skill authoring is available');
    } finally {
      h.close();
    }
  });
});

/** args -> tool -> output text. A graph the broker registry can actually run. */
function chatFlow(toolId = 'files.read'): Record<string, unknown> {
  return {
    version: 1,
    nodes: [
      {
        id: 'in',
        type: 'input',
        position: { x: 0, y: 0 },
        data: { fields: [{ name: 'path', type: 'string', required: true }] },
      },
      {
        id: 'read',
        type: 'tool',
        position: { x: 200, y: 0 },
        data: { toolId, args: { path: 'path' } },
      },
      { id: 'out', type: 'output', position: { x: 400, y: 0 }, data: { shape: 'text' } },
    ],
    edges: [
      { id: 'e0', source: 'in', target: 'read' },
      { id: 'e1', source: 'read', target: 'out' },
    ],
  };
}

describe('M28 E: `skills.draft` accepts a FLOW payload', () => {
  it('advertises the flow option without adding a third tool', () => {
    const h = harness();
    try {
      const provider = authoringProvider(h);
      const ids = provider?.manifests.map((manifest) => manifest.id) ?? [];
      expect(ids).toEqual([DRAFT_TOOL_ID, REQUEST_INSTALL_TOOL_ID]);
      expect(provider?.manifests[0]?.description).toMatch(/flow/i);
    } finally {
      h.close();
    }
  });

  it('stages a COMPILED, flow-backed draft whose permissions come from the graph', async () => {
    const h = harness();
    try {
      const provider = authoringProvider(h);
      const staged = await provider?.exec(DRAFT_TOOL_ID, {
        name: 'Read a file',
        description: 'reads one file',
        flow: chatFlow(),
      });
      expect(staged).toMatchObject({ outcome: 'executed' });
      const result = (staged as { result: Record<string, unknown> }).result;
      expect(result.ok).toBe(true);
      const draft = h.skillDrafts?.get(String(result.draftId));
      expect(draft?.flow).not.toBeNull();
      expect(draft?.flowStale).toBe(false);
      expect(draft?.code).toContain('files.read');
      // D5: the manifest declares exactly what the graph reaches — derived by the
      // compiler, never copied from anything the model said.
      expect(draft?.manifest?.permissions.tools).toEqual(['files.read']);
      expect(draft?.validation.ok).toBe(true);
      // Still inert: nothing was installed.
      expect(h.skills?.list()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('refuses `flow` AND `code` together, and names an unknown tool the model can fix', async () => {
    const h = harness();
    try {
      const provider = authoringProvider(h);
      const both = await provider?.exec(DRAFT_TOOL_ID, {
        name: 'Both',
        code: 'export function run(){ return 1; }',
        flow: chatFlow(),
      });
      const bothResult = (both as unknown as { result: { ok: boolean; problems: string } }).result;
      expect(bothResult.ok).toBe(false);
      expect(bothResult.problems).toMatch(/either `flow` \(a graph\) or `code`/);

      // A tool id outside the broker registry is refused by the COMPILER, and the
      // model is told which one — it can re-call with the same id and fix it.
      const unknown = await provider?.exec(DRAFT_TOOL_ID, {
        name: 'Unknown tool',
        flow: chatFlow('files.teleport'),
      });
      const refused = (unknown as { result: Record<string, unknown> }).result;
      expect(refused.ok).toBe(false);
      expect(String(refused.problems)).toContain('files.teleport');
      // Nothing was staged, so there is no half-built draft to clean up.
      expect(h.skillDrafts?.list()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('re-calling with the SAME id re-stages the graph (the fix-it loop, for flows)', async () => {
    const h = harness();
    try {
      const provider = authoringProvider(h);
      const first = await provider?.exec(DRAFT_TOOL_ID, {
        name: 'Iterated',
        flow: chatFlow('files.read'),
      });
      const draftId = String((first as unknown as { result: { draftId: string } }).result.draftId);
      // A graph with the input field dropped: the update replaces code, manifest
      // and the stored flow together, so the draft is never half-migrated.
      const narrowed = chatFlow('files.read');
      const firstNode = (narrowed.nodes as Array<{ data: Record<string, unknown> }>)[0];
      if (firstNode !== undefined) firstNode.data.fields = [];
      const second = await provider?.exec(DRAFT_TOOL_ID, {
        id: draftId,
        name: 'Iterated',
        flow: narrowed,
      });
      expect((second as unknown as { result: { ok: boolean } }).result.ok).toBe(true);
      const draft = h.skillDrafts?.get(draftId);
      expect(draft?.code).toContain('files.read');
      expect(draft?.flow?.nodes).toHaveLength(3);
      expect(draft?.flowStale).toBe(false);
      // One draft, not two: an update by id never allocates a second row.
      expect(h.skillDrafts?.list()).toHaveLength(1);
    } finally {
      h.close();
    }
  });
});

// ---------------------------------------------------------------------------
// M28 cut E at the ROUTE: a real chat turn whose native tool call carries a
// `flow` instead of `code`. The seam tests above prove the tool; this proves the
// whole turn — the model's graph reaches the drafts manager through the same
// gate, lands as a COMPILED flow-backed draft, and the conversation keeps the
// note the Studio's deep link is built from.
// ---------------------------------------------------------------------------

/** Upstream whose SSE carries ONE native `skills.draft` call with a `flow`. */
async function flowCallUpstream(
  flow: Record<string, unknown>,
): Promise<{ base: string; bodies: Array<Record<string, unknown>> }> {
  const bodies: Array<Record<string, unknown>> = [];
  let served = 0;
  const started = await startHttpServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? '';
    if (path === '/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }] }));
      return;
    }
    if (path === '/chat/completions') {
      let raw = '';
      req.on('data', (chunk: Buffer) => {
        raw += chunk.toString('utf8');
      });
      req.on('end', () => {
        try {
          bodies.push(JSON.parse(raw) as Record<string, unknown>);
        } catch {
          bodies.push({});
        }
        if (served > 0) {
          // The continuation turn: a plain answer, so the loop terminates.
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(sseReply(['Staged it.'], { prompt: 5, completion: 5 }));
          return;
        }
        served += 1;
        const args = JSON.stringify({ name: 'Chat Flow', description: 'from chat', flow });
        const half = Math.floor(args.length / 2);
        const frames = [
          {
            choices: [
              {
                index: 0,
                delta: {
                  role: 'assistant',
                  tool_calls: [
                    { index: 0, id: 'call_1', function: { name: DRAFT_TOOL_ID, arguments: '' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(0, half) } }] },
              },
            ],
          },
          {
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(half) } }] },
              },
            ],
          },
          {
            choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
          },
        ];
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        res.end(
          frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('') +
            'data: [DONE]\n\n',
        );
      });
      return;
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  upstreams.push(started);
  return { base: started.base, bodies };
}

describe('M28 E at the route: a chat turn can stage a flow', () => {
  it('stages a COMPILED flow-backed draft and keeps the note the Studio links from', async () => {
    const h = demoHarness({ demo: false });
    try {
      // A graph with no tool nodes, so the turn needs no grants: the point here
      // is the authoring path, not the runtime reach.
      const upstream = await flowCallUpstream({
        version: 1,
        nodes: [
          {
            id: 'in',
            type: 'input',
            position: { x: 0, y: 0 },
            data: { fields: [{ name: 'text', type: 'string', required: true }] },
          },
          {
            id: 'msg',
            type: 'template',
            position: { x: 240, y: 0 },
            data: { text: 'from chat: {{text}}' },
          },
          { id: 'out', type: 'output', position: { x: 480, y: 0 }, data: { shape: 'text' } },
        ],
        edges: [
          { id: 'e0', source: 'in', target: 'msg' },
          { id: 'e1', source: 'msg', target: 'out' },
        ],
      });
      const provider = await h.providerManager.create({
        name: 'flow-call-upstream',
        endpoint: upstream.base,
        defaultModels: ['gpt-4o'],
      });
      await h.providerManager.setKey(provider.id, 'sk-fake-flow-call-0000000001');
      const token = await pairToken(h);
      const headers = authed(token);
      await setPersonaLevel(h, headers, 'p-analyst', 'suggest');

      const chat = await request(h.app)
        .post('/v1/chat')
        .set(headers)
        .send({
          personaId: 'p-analyst',
          tools: true,
          messages: [{ role: 'user', content: 'stage a flow that prefixes the text' }],
        });
      expect(chat.status).toBe(200);

      // The draft landed FLOW-BACKED and COMPILED — the same artifact any other
      // authoring path produces.
      const drafts = h.skillDrafts?.list() ?? [];
      expect(drafts).toHaveLength(1);
      const staged = h.skillDrafts?.get(drafts[0]!.id);
      expect(staged?.origin).toBe('chat');
      expect(staged?.flow).not.toBeNull();
      expect(staged?.flowStale).toBe(false);
      expect(staged?.validation.ok).toBe(true);
      expect(staged?.manifest?.permissions.tools).toEqual([]);
      // Nothing became executable: drafting is inert, and the install ask is a
      // separate tool the model did not call.
      expect(h.skills?.list()).toEqual([]);

      // The conversation carries the note naming the draft — that is the source
      // of the Studio's deep link ("Review in Studio").
      const meta = /"done_meta".*?"conversationId":"([^"]+)"/.exec(chat.text);
      expect(meta?.[1]).toBeDefined();
      const detail = h.conversations.get(meta?.[1] ?? '');
      const note = detail.messages.find((message) =>
        String(message.content).includes(String(staged?.id)),
      );
      expect(note).toBeDefined();
    } finally {
      h.close();
    }
  }, 30_000);
});
