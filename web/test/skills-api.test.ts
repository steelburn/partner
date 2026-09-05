import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../src/lib/api.js';
import {
  disableSkill,
  enableSkill,
  getSkill,
  installSkill,
  invokeSkill,
  listCatalog,
  listInvocations,
  listSkills,
  uninstallSkill,
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

function bodyOf(call: { input: string; init?: RequestInit }): unknown {
  return JSON.parse(String(call.init?.body ?? '{}'));
}

const SUMMARY = {
  id: 'hello-skill',
  name: 'Hello skill',
  description: 'Echoes its args back',
  author: 'partner',
  version: '1.0.0',
  source: 'local',
  status: 'installed',
  sha256: 'abc123',
  installedAt: 100,
  updatedAt: 100,
} as const;

const MANIFEST = {
  id: 'hello-skill',
  name: 'Hello skill',
  description: 'Echoes its args back',
  author: 'partner',
  version: '1.0.0',
  entrypoint: 'entry.mjs',
  permissions: { tools: [], network: false, risk: 'low' },
  budget: { timeMs: 30000 },
} as const;

const CATALOG_ITEM = {
  id: 'hello-skill',
  name: 'Hello skill',
  description: 'Echoes its args back',
  author: 'partner',
  version: '1.0.0',
  permissions: { tools: [], network: false, risk: 'low' },
} as const;

const INVOCATION = {
  id: 'inv-1',
  skillId: 'hello-skill',
  personaId: null,
  startedAt: 200,
  finishedAt: 300,
  ok: true,
  toolCalls: 0,
  error: null,
  ms: 100,
} as const;

describe('skills list + catalog', () => {
  it('listSkills GETs /v1/skills with the Bearer token and reads the envelope', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ skills: [SUMMARY] }));
    const result = await listSkills(TOKEN, { fetchImpl });
    expect(result).toEqual([SUMMARY]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/v1/skills');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
  });

  it('listSkills tolerates a bare-array response', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse([SUMMARY]));
    expect(await listSkills(TOKEN, { fetchImpl })).toEqual([SUMMARY]);
  });

  it('listSkills rejects an unexpected body shape', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ items: [] }));
    await expect(listSkills(TOKEN, { fetchImpl })).rejects.toThrow('unexpected shape');
  });

  it('listCatalog reads /v1/skills/catalog with either envelope key', async () => {
    const { fetchImpl: a, calls: ca } = recordFetch(() => jsonResponse({ catalog: [CATALOG_ITEM] }));
    expect(await listCatalog(TOKEN, { fetchImpl: a })).toEqual([CATALOG_ITEM]);
    expect(ca[0]?.input).toBe('/v1/skills/catalog');

    const { fetchImpl: b } = recordFetch(() => jsonResponse({ skills: [CATALOG_ITEM] }));
    expect(await listCatalog(TOKEN, { fetchImpl: b })).toEqual([CATALOG_ITEM]);
  });
});

describe('install / get / status / uninstall', () => {
  it('installSkill POSTs {catalogId} to /v1/skills/install and parses the row', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ skill: SUMMARY }));
    const result = await installSkill(TOKEN, 'hello-skill', { fetchImpl });
    expect(result).toEqual(SUMMARY);
    expect(calls[0]?.input).toBe('/v1/skills/install');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(bodyOf(calls[0]!)).toEqual({ catalogId: 'hello-skill' });
    expect(String(calls[0]?.input)).not.toContain(TOKEN);
    expect(JSON.stringify(bodyOf(calls[0]!))).not.toContain(TOKEN);
  });

  it('installSkill treats an empty 204 as installed (no body to parse)', async () => {
    const { fetchImpl } = recordFetch(() => new Response(null, { status: 204 }));
    expect(await installSkill(TOKEN, 'hello-skill', { fetchImpl })).toBeNull();
  });

  it('installSkill surfaces the 409 already-installed conflict as ApiRequestError', async () => {
    const { fetchImpl } = recordFetch(() =>
      jsonResponse({ error: { message: 'already installed' } }, 409),
    );
    await expect(installSkill(TOKEN, 'hello-skill', { fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 409,
      message: 'already installed',
    });
  });

  it('installSkill rejects a malformed installed row', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ something: 'else' }));
    await expect(installSkill(TOKEN, 'hello-skill', { fetchImpl })).rejects.toBeInstanceOf(
      ApiRequestError,
    );
  });

  it('getSkill returns the detail (summary + manifest) under /v1/skills/:id', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ skill: { ...SUMMARY, manifest: MANIFEST } }),
    );
    const result = await getSkill(TOKEN, 'hello-skill', { fetchImpl });
    expect(result.manifest.permissions.risk).toBe('low');
    expect(calls[0]?.input).toBe('/v1/skills/hello-skill');
  });

  it('getSkill rejects a response without a manifest', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse(SUMMARY));
    await expect(getSkill(TOKEN, 'hello-skill', { fetchImpl })).rejects.toThrow(
      'unexpected shape',
    );
  });

  it('disable/enable POST the right suffix and parse the updated row', async () => {
    const disabled = recordFetch(() => jsonResponse({ ...SUMMARY, status: 'disabled' }));
    const after = await disableSkill(TOKEN, 'hello-skill', { fetchImpl: disabled.fetchImpl });
    expect(after?.status).toBe('disabled');
    expect(disabled.calls[0]?.input).toBe('/v1/skills/hello-skill/disable');
    expect(disabled.calls[0]?.init?.method).toBe('POST');

    const enabled = recordFetch(() => new Response(null, { status: 204 }));
    expect(await enableSkill(TOKEN, 'hello-skill', { fetchImpl: enabled.fetchImpl })).toBeNull();
    expect(enabled.calls[0]?.input).toBe('/v1/skills/hello-skill/enable');
  });

  it('uninstallSkill DELETEs /v1/skills/:id and expects 204', async () => {
    const { fetchImpl, calls } = recordFetch(() => new Response(null, { status: 204 }));
    await uninstallSkill(TOKEN, 'hello-skill', { fetchImpl });
    expect(calls[0]?.input).toBe('/v1/skills/hello-skill');
    expect(calls[0]?.init?.method).toBe('DELETE');

    const failing = recordFetch(() => jsonResponse({ error: { message: 'in use' } }, 409));
    await expect(uninstallSkill(TOKEN, 'hello-skill', { fetchImpl: failing.fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 409,
      message: 'in use',
    });
  });
});

describe('invokeSkill', () => {
  it('POSTs {args, personaId} and returns the result envelope', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ result: { echoed: { greeting: 'hi' } } }),
    );
    const result = await invokeSkill(
      TOKEN,
      'hello-skill',
      { args: { greeting: 'hi' }, personaId: 'p-1' },
      { fetchImpl },
    );
    expect(result).toEqual({ ok: true, result: { echoed: { greeting: 'hi' } } });
    expect(calls[0]?.input).toBe('/v1/skills/hello-skill/invoke');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(bodyOf(calls[0]!)).toEqual({ args: { greeting: 'hi' }, personaId: 'p-1' });
  });

  it('omits args when undefined and supports an empty body', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ result: null }));
    const result = await invokeSkill(TOKEN, 'hello-skill', {}, { fetchImpl });
    expect(result).toEqual({ ok: true, result: null });
    expect(bodyOf(calls[0]!)).toEqual({});
  });

  it('maps documented coded failures to {ok:false} outcomes', async () => {
    // 403 with a recognized code is an invoke outcome, not a lost session.
    const denied = recordFetch(() => jsonResponse({ error: { code: 'denied' } }, 403));
    expect(await invokeSkill(TOKEN, 'hello-skill', {}, { fetchImpl: denied.fetchImpl })).toEqual({
      ok: false,
      code: 'denied',
      message: 'Invocation denied',
    });

    // Plain-string error bodies carrying a known code also parse.
    const budget = recordFetch(() => jsonResponse({ error: 'budget_exceeded' }, 429));
    expect(await invokeSkill(TOKEN, 'hello-skill', {}, { fetchImpl: budget.fetchImpl })).toEqual({
      ok: false,
      code: 'budget_exceeded',
      message: 'Budget exceeded — run stopped',
    });

    // Top-level {code} shape without a message falls back to the label.
    const crashed = recordFetch(() => jsonResponse({ code: 'crashed' }, 500));
    const outcome = await invokeSkill(TOKEN, 'hello-skill', {}, { fetchImpl: crashed.fetchImpl });
    expect(outcome).toEqual({ ok: false, code: 'crashed', message: 'Skill crashed' });
  });

  it('throws ApiRequestError for 401/403 without a coded body (session lost)', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ error: 'unauthorized' }, 401));
    await expect(invokeSkill(TOKEN, 'hello-skill', {}, { fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 401,
    });
  });

  it('throws ApiRequestError for non-coded failures with a readable message', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ error: { message: 'bad request' } }, 400));
    await expect(invokeSkill(TOKEN, 'hello-skill', {}, { fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 400,
      message: 'bad request',
    });
  });

  it('rejects a 200 whose body has no result key', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ output: 'x' }));
    await expect(invokeSkill(TOKEN, 'hello-skill', {}, { fetchImpl })).rejects.toBeInstanceOf(
      ApiRequestError,
    );
  });
});

describe('recent invocations', () => {
  it('listInvocations reads /v1/skills/:id/invocations with either envelope', async () => {
    const { fetchImpl: a, calls } = recordFetch(() => jsonResponse({ invocations: [INVOCATION] }));
    expect(await listInvocations(TOKEN, 'hello-skill', { fetchImpl: a })).toEqual([INVOCATION]);
    expect(calls[0]?.input).toBe('/v1/skills/hello-skill/invocations');

    const { fetchImpl: b } = recordFetch(() => jsonResponse([INVOCATION]));
    expect(await listInvocations(TOKEN, 'hello-skill', { fetchImpl: b })).toEqual([INVOCATION]);
  });
});

describe('invoke 2xx runner envelopes (M8 review finding 1)', () => {
  it('maps the core 200 {ok:false,error} shape to a coded result', async () => {
    const { fetchImpl } = recordFetch(() =>
      jsonResponse({ ok: false, error: 'tool_denied', meta: { id: 'inv-1' } }),
    );
    const result = await invokeSkill(TOKEN, 'files-preview', { args: {} }, { fetchImpl });
    expect(result).toEqual({
      ok: false,
      code: 'tool_denied',
      message: 'A tool request was denied',
    });
  });

  it('maps budget_exceeded and caps_exceeded labels from 200 bodies', async () => {
    const budget = recordFetch(() => jsonResponse({ ok: false, error: 'budget_exceeded' }));
    const b = await invokeSkill(TOKEN, 's', {}, { fetchImpl: budget.fetchImpl });
    expect(b).toMatchObject({ ok: false, code: 'budget_exceeded' });

    const caps = recordFetch(() => jsonResponse({ ok: false, error: 'caps_exceeded' }));
    const c = await invokeSkill(TOKEN, 's', {}, { fetchImpl: caps.fetchImpl });
    expect(c).toMatchObject({ ok: false, code: 'caps_exceeded' });
  });

  it('still throws on a 2xx body with neither result nor a coded error', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ nope: true }));
    await expect(invokeSkill(TOKEN, 's', {}, { fetchImpl })).rejects.toThrow(
      /unexpected shape/,
    );
  });
});
