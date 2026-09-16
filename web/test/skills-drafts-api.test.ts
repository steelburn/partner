/**
 * M26 skill-draft API client tests (PLAN-M26.md cut D).
 *
 * The client is the only thing between the Studio and the core, so what is
 * asserted here is the WIRE: the route and method for every call, the body that
 * actually travels, envelope tolerance, and — the two that matter most — that a
 * coded `409 permission_change` comes back as a typed outcome (so the Studio can
 * offer "review and confirm" instead of a dead end) while a `401` still throws
 * as a lost session.
 *
 * Redaction discipline: the fixtures carry draft CODE and manifest TEXT because
 * those are the owner's own content crossing to the owner's UI. No assertion
 * here prints a token, and the token only ever travels in the Authorization
 * header.
 */
import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../src/lib/api.js';
import {
  createDraft,
  discardDraft,
  editSkill,
  exportDraftBundle,
  forkSkill,
  getDraft,
  importDraftBundle,
  installDraft,
  listDrafts,
  listSkillTemplates,
  runDraft,
  updateDraft,
  validateDraft,
  type FetchLike,
} from '../src/lib/skills.js';

const TOKEN = 'tok-secret';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function recordFetch(fn: (input: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(fn(input, init));
  };
  return { fetchImpl, calls };
}

function bodyOf(call: { input: string; init?: RequestInit }): Record<string, unknown> {
  return JSON.parse(String(call.init?.body ?? '{}')) as Record<string, unknown>;
}

function authOf(call: { input: string; init?: RequestInit }): string | undefined {
  return (call.init?.headers as Record<string, string> | undefined)?.authorization;
}

const VALIDATION = { ok: true, errors: [], warnings: ['cannot reach the network'], checkedAt: 1000 };

const MANIFEST = {
  id: 'scratch-checklist',
  name: 'Scratch checklist',
  description: 'Turns scratch notes into a checklist',
  author: 'You',
  version: '0.1.0',
  entrypoint: 'entry.mjs',
  permissions: { tools: [], network: false, risk: 'low' },
  budget: { timeMs: 30000 },
};

const SUMMARY = {
  id: 'scratch-checklist',
  name: 'Scratch checklist',
  description: 'Turns scratch notes into a checklist',
  status: 'draft',
  origin: 'generated',
  manifest: MANIFEST,
  validation: VALIDATION,
  model: 'demo',
  conversationId: null,
  personaId: null,
  pendingInstallId: null,
  createdAt: 900,
  updatedAt: 1000,
};

const DRAFT = {
  ...SUMMARY,
  code: 'export function run(args = {}) { return args; }',
  prompt: 'turn my scratch notes into a checklist',
  manifestText: JSON.stringify(MANIFEST, null, 2),
  installedVersion: null,
  flow: null,
  flowSha256: null,
  flowCompiledAt: null,
  flowStale: false,
};

const SKILL_ROW = {
  id: 'scratch-checklist',
  name: 'Scratch checklist',
  description: 'Turns scratch notes into a checklist',
  author: 'You',
  version: '0.1.0',
  source: 'authored',
  status: 'installed',
  sha256: 'abc',
  installedAt: 2000,
  updatedAt: 2000,
};

describe('draft list + detail', () => {
  it('GETs the drafts list with the bearer token and reads the envelope', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ drafts: [SUMMARY] }));
    const drafts = await listDrafts(TOKEN, { fetchImpl });
    expect(calls[0]?.input).toBe('/v1/skills/drafts');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(authOf(calls[0]!)).toBe(`Bearer ${TOKEN}`);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.id).toBe('scratch-checklist');
  });

  it('tolerates a bare array (either spelling of the same contract)', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse([SUMMARY]));
    await expect(listDrafts(TOKEN, { fetchImpl })).resolves.toHaveLength(1);
  });

  it('encodes the draft id in the path and tolerates a {draft} envelope', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ draft: DRAFT }));
    const draft = await getDraft(TOKEN, 'a/b c', { fetchImpl });
    expect(calls[0]?.input).toBe('/v1/skills/drafts/a%2Fb%20c');
    expect(draft.code).toContain('export function run');
  });

  it('refuses a row that is not a draft rather than rendering a guess', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ nope: true }));
    await expect(getDraft(TOKEN, 'x', { fetchImpl })).rejects.toBeInstanceOf(ApiRequestError);
  });

  it('throws ApiRequestError with the status on a lost session', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ error: 'unauthorized' }, 401));
    await expect(listDrafts(TOKEN, { fetchImpl })).rejects.toMatchObject({ status: 401 });
  });
});

describe('draft create / update / validate', () => {
  it('POSTs the create body verbatim (201)', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse(DRAFT, 201));
    const draft = await createDraft(
      TOKEN,
      {
        mode: 'generate',
        name: 'Scratch checklist',
        description: 'Turns scratch notes into a checklist',
        prompt: 'turn my scratch notes into a checklist',
        id: 'scratch-checklist',
      },
      { fetchImpl },
    );
    expect(calls[0]?.input).toBe('/v1/skills/drafts');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(bodyOf(calls[0]!)).toEqual({
      mode: 'generate',
      name: 'Scratch checklist',
      description: 'Turns scratch notes into a checklist',
      prompt: 'turn my scratch notes into a checklist',
      id: 'scratch-checklist',
    });
    expect(draft.id).toBe('scratch-checklist');
  });

  it('PUTs only the fields handed to updateDraft', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse(DRAFT));
    await updateDraft(TOKEN, 'scratch-checklist', { code: 'export const run = () => 1;' }, { fetchImpl });
    expect(calls[0]?.input).toBe('/v1/skills/drafts/scratch-checklist');
    expect(calls[0]?.init?.method).toBe('PUT');
    expect(bodyOf(calls[0]!)).toEqual({ code: 'export const run = () => 1;' });
  });

  it('POSTs an empty body to validate (deterministic, never executes)', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse(DRAFT));
    await validateDraft(TOKEN, 'scratch-checklist', { fetchImpl });
    expect(calls[0]?.input).toBe('/v1/skills/drafts/scratch-checklist/validate');
    expect(bodyOf(calls[0]!)).toEqual({});
  });
});

describe('installDraft (the one privileged call)', () => {
  it('returns the installed skill + the mode on success', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ skill: SKILL_ROW, mode: 'created', permissionDiff: [] }),
    );
    const outcome = await installDraft(TOKEN, 'scratch-checklist', {}, { fetchImpl });
    expect(outcome).toEqual({
      ok: true,
      result: { skill: SKILL_ROW, mode: 'created', permissionDiff: [] },
    });
    // No acknowledgement unless the caller asked for one.
    expect(bodyOf(calls[0]!)).toEqual({});
  });

  it('sends acknowledgePermissions only when the caller acknowledges', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ skill: SKILL_ROW, mode: 'updated', permissionDiff: [] }),
    );
    await installDraft(TOKEN, 'scratch-checklist', { acknowledgePermissions: true }, { fetchImpl });
    expect(bodyOf(calls[0]!)).toEqual({ acknowledgePermissions: true });
  });

  it('maps a coded 409 permission_change to a typed outcome, not an exception', async () => {
    const { fetchImpl } = recordFetch(() =>
      jsonResponse(
        {
          error: 'permission_change',
          message: "this install widens the skill's permissions (tools) with no acknowledgement",
        },
        409,
      ),
    );
    const outcome = await installDraft(TOKEN, 'scratch-checklist', {}, { fetchImpl });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('unreachable');
    expect(outcome.code).toBe('permission_change');
    expect(outcome.message).toContain('widens');
  });

  it('maps the other coded refusals the route documents', async () => {
    for (const [status, code] of [
      [400, 'invalid_input'],
      [404, 'not_found'],
      [409, 'conflict'],
    ] as const) {
      const { fetchImpl } = recordFetch(() => jsonResponse({ error: code, message: 'no' }, status));
      const outcome = await installDraft(TOKEN, 'd', {}, { fetchImpl });
      expect(outcome).toMatchObject({ ok: false, code });
    }
  });

  it('still treats a 401 as a lost session (no coded body)', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ error: 'unauthorized' }, 401));
    await expect(installDraft(TOKEN, 'd', {}, { fetchImpl })).rejects.toMatchObject({
      status: 401,
    });
  });

  it('refuses an install response that is not an install result', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ ok: true }));
    await expect(installDraft(TOKEN, 'd', {}, { fetchImpl })).rejects.toBeInstanceOf(
      ApiRequestError,
    );
  });
});

describe('draft run / discard', () => {
  it('POSTs args and returns the worker result with its log lines', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ ok: true, result: { text: 'hi' }, logs: ['imported entry.mjs'], ms: 42 }),
    );
    const run = await runDraft(TOKEN, 'scratch-checklist', { args: { text: 'hi' } }, { fetchImpl });
    expect(calls[0]?.input).toBe('/v1/skills/drafts/scratch-checklist/run');
    expect(bodyOf(calls[0]!)).toEqual({ args: { text: 'hi' } });
    expect(run).toEqual({ ok: true, result: { text: 'hi' }, logs: ['imported entry.mjs'], ms: 42 });
  });

  it('carries the coded failure and the logs back on a failed run', async () => {
    const { fetchImpl } = recordFetch(() =>
      jsonResponse({ ok: false, error: 'crashed', logs: ['SyntaxError: unexpected token'], ms: 3 }),
    );
    const run = await runDraft(TOKEN, 'd', {}, { fetchImpl });
    expect(run.ok).toBe(false);
    if (run.ok) throw new Error('unreachable');
    expect(run.error).toBe('crashed');
    expect(run.logs[0]).toContain('SyntaxError');
  });

  it('DELETEs a draft and requires a 204', async () => {
    const { fetchImpl, calls } = recordFetch(() => new Response(null, { status: 204 }));
    await discardDraft(TOKEN, 'scratch-checklist', { fetchImpl });
    expect(calls[0]?.init?.method).toBe('DELETE');
    expect(calls[0]?.input).toBe('/v1/skills/drafts/scratch-checklist');
  });

  it('surfaces a failed discard instead of reporting success', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ error: 'not_found' }, 404));
    await expect(discardDraft(TOKEN, 'd', { fetchImpl })).rejects.toMatchObject({ status: 404 });
  });
});

describe('fork / edit / templates', () => {
  it('POSTs fork and edit against the installed skill id (201)', async () => {
    const fork = recordFetch(() => jsonResponse({ ...DRAFT, origin: 'fork' }, 201));
    await forkSkill(TOKEN, 'scratch-checklist', { fetchImpl: fork.fetchImpl });
    expect(fork.calls[0]?.input).toBe('/v1/skills/scratch-checklist/fork');
    expect(fork.calls[0]?.init?.method).toBe('POST');

    const edit = recordFetch(() => jsonResponse({ ...DRAFT, origin: 'edit' }, 201));
    await editSkill(TOKEN, 'scratch-checklist', { fetchImpl: edit.fetchImpl });
    expect(edit.calls[0]?.input).toBe('/v1/skills/scratch-checklist/edit');
  });

  it('reads the template list from its envelope', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({
        templates: [
          {
            id: 'pure',
            name: 'Pure skill',
            description: 'Transforms its arguments',
            reach: 'Nothing outside itself.',
          },
        ],
      }),
    );
    const templates = await listSkillTemplates(TOKEN, { fetchImpl });
    expect(calls[0]?.input).toBe('/v1/skills/templates');
    expect(templates[0]).toEqual({
      id: 'pure',
      name: 'Pure skill',
      description: 'Transforms its arguments',
      reach: 'Nothing outside itself.',
    });
  });
});

describe('bundle export / import', () => {
  const BUNDLE = { version: 1, manifestText: DRAFT.manifestText, code: DRAFT.code };

  it('exports the bundle the core built', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse(BUNDLE));
    const bundle = await exportDraftBundle(TOKEN, 'scratch-checklist', { fetchImpl });
    expect(calls[0]?.input).toBe('/v1/skills/drafts/scratch-checklist/bundle');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(bundle).toEqual(BUNDLE);
  });

  it('refuses a bundle-shaped response that carries no source', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ version: 1 }));
    await expect(exportDraftBundle(TOKEN, 'd', { fetchImpl })).rejects.toBeInstanceOf(
      ApiRequestError,
    );
  });

  it('imports a bundle as a NEW inert draft (201)', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ ...DRAFT, id: 'scratch-checklist-2', origin: 'import' }, 201),
    );
    const draft = await importDraftBundle(TOKEN, BUNDLE, { fetchImpl });
    expect(calls[0]?.input).toBe('/v1/skills/drafts/import');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(bodyOf(calls[0]!)).toEqual(BUNDLE);
    expect(draft.origin).toBe('import');
    expect(draft.status).toBe('draft');
  });
});
