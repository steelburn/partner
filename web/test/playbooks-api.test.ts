import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../src/lib/api.js';
import {
  asPlaybookRunEvent,
  createDeployProfile,
  deleteDeployProfile,
  listDeployProfiles,
  listPlaybooks,
  packageProfile,
  parsePackageResult,
  parsePlaybookList,
  parseProfile,
  parseProfileList,
  readRunDoneMeta,
  resumeRun,
  runPlaybook,
  type FetchLike,
} from '../src/lib/playbooks.js';

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

/** Build a Response whose body is an SSE text payload (chat-stream style). */
function sseResponse(frames: Array<{ type: string; [k: string]: unknown }>): Response {
  const text = frames
    .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
    .join('');
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

const PLAYBOOK = {
  id: 'pb-research',
  name: 'Research',
  area: 'research',
  description: 'Summarize inputs and sources into a structured note.',
  allowedTools: ['files.read'],
  defaultIndependence: 'suggest',
  inputs: [
    { name: 'topic', hint: 'What to research' },
    { name: 'noteId', hint: 'an existing note to build on', optional: true },
  ],
};

const PROFILE = {
  id: 'dp-1',
  name: 'prod',
  kind: 'docker-ssh',
  host: 'enter.ne1.dev',
  username: 'root',
  port: 22,
  remoteBaseDir: '/opt/apps',
  createdAt: 1,
  updatedAt: 2,
};

describe('playbook registry client', () => {
  it('listPlaybooks GETs /v1/playbooks with the Bearer token and reads the envelope', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ playbooks: [PLAYBOOK] }));
    const result = await listPlaybooks(TOKEN, { fetchImpl });
    expect(result).toEqual([PLAYBOOK]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/v1/playbooks');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
  });

  it('listPlaybooks tolerates a bare-array response and normalizes rows', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse([PLAYBOOK]));
    const result = await listPlaybooks(TOKEN, { fetchImpl });
    expect(result).toHaveLength(1);
    expect(result[0]?.inputs).toEqual(PLAYBOOK.inputs);
    expect(result[0]?.defaultIndependence).toBe('suggest');
  });

  it('parsePlaybookList defaults independence and drops malformed inputs defensively', () => {
    const rows = parsePlaybookList([
      PLAYBOOK,
      {
        id: 'pb-x',
        name: 'X',
        area: 'analysis',
        description: 'd',
        defaultIndependence: 'not-a-level',
        inputs: [{ name: 'csv', hint: 'paste a CSV' }, { hint: 'no name' }, 'junk'],
      },
    ]);
    expect(rows[1]?.defaultIndependence).toBe('suggest');
    expect(rows[1]?.inputs).toEqual([{ name: 'csv', hint: 'paste a CSV' }]);
  });

  it('listPlaybooks rejects an unexpected body shape', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ items: [] }));
    await expect(listPlaybooks(TOKEN, { fetchImpl })).rejects.toThrow('unexpected shape');
  });
});

describe('playbook run stream', () => {
  it('runPlaybook POSTs /v1/playbooks/:id/run with the run body and dispatches events', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      sseResponse([
        { type: 'delta', text: 'Drafting…' },
        { type: 'loop_step', round: 1 },
        { type: 'persona_tool', toolId: 'files.read', decision: 'executed' },
        { type: 'delta', text: 'done' },
        { type: 'done' },
        {
          type: 'done_meta',
          runId: 'run-1',
          status: 'done',
          noteId: null,
          pendingId: null,
          noteTitle: null,
          conversationId: 'c-1',
        },
      ]),
    );
    const events: string[] = [];
    let meta: unknown = null;
    const result = await runPlaybook({
      token: TOKEN,
      playbookId: 'pb-research',
      inputs: { topic: 'SQLite' },
      personaId: 'p-1',
      conversationId: 'c-1',
      saveNote: true,
      fetchImpl,
      onEvent: (event) => events.push(event.type),
      onDoneMeta: (m) => {
        meta = m;
      },
    });
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.input).toBe('/v1/playbooks/pb-research/run');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toMatchObject({ accept: 'text/event-stream' });
    expect(bodyOf(calls[0]!)).toEqual({
      inputs: { topic: 'SQLite' },
      personaId: 'p-1',
      conversationId: 'c-1',
      note: true,
    });
    expect(events).toEqual(['delta', 'loop_step', 'persona_tool', 'delta', 'done', 'done_meta']);
    expect(meta).toMatchObject({ type: 'done_meta', runId: 'run-1', status: 'done' });
    // The token never rides in the URL or the body.
    expect(String(calls[0]?.input)).not.toContain(TOKEN);
    expect(JSON.stringify(bodyOf(calls[0]!))).not.toContain(TOKEN);
  });

  it('runPlaybook omits persona/conversation/note when they are absent', async () => {
    const { fetchImpl, calls } = recordFetch(() => sseResponse([{ type: 'done' }]));
    await runPlaybook({
      token: TOKEN,
      playbookId: 'pb-x',
      inputs: {},
      fetchImpl,
      onEvent: () => undefined,
    });
    expect(bodyOf(calls[0]!)).toEqual({ inputs: {} });
  });

  it('runPlaybook maps non-2xx responses incl. the paused-persona 423', async () => {
    const paused = recordFetch(() => jsonResponse({ error: { message: 'paused' } }, 423));
    const pausedResult = await runPlaybook({
      token: TOKEN,
      playbookId: 'pb-x',
      inputs: {},
      fetchImpl: paused.fetchImpl,
      onEvent: () => undefined,
    });
    expect(pausedResult).toMatchObject({ ok: false, paused: true, status: 423 });

    const forbidden = recordFetch(() => jsonResponse({ error: { message: 'session gone' } }, 401));
    const forbiddenResult = await runPlaybook({
      token: TOKEN,
      playbookId: 'pb-x',
      inputs: {},
      fetchImpl: forbidden.fetchImpl,
      onEvent: () => undefined,
    });
    expect(forbiddenResult).toMatchObject({ ok: false, unauthorized: true, status: 401 });
  });

  it('asPlaybookRunEvent guards each event kind tolerantly', () => {
    expect(asPlaybookRunEvent({ type: 'delta', text: 'hi' })).toEqual({ type: 'delta', text: 'hi' });
    expect(asPlaybookRunEvent({ type: 'delta' })).toBeNull();
    expect(asPlaybookRunEvent({ type: 'loop_step', round: 2 })).toEqual({ type: 'loop_step', round: 2 });
    expect(asPlaybookRunEvent({ type: 'loop_step', round: 0 })).toBeNull();
    expect(asPlaybookRunEvent({ type: 'loop_step', round: 1, message: 'cap' })).toEqual({
      type: 'loop_step',
      round: 1,
      message: 'cap',
    });
    expect(asPlaybookRunEvent({ type: 'done' })).toEqual({ type: 'done' });
    expect(asPlaybookRunEvent({ type: 'bogus' })).toBeNull();
    expect(asPlaybookRunEvent('junk')).toBeNull();
  });

  it('guards a queued persona tool with its pending id (queue-hint path)', () => {
    const queued = asPlaybookRunEvent({
      type: 'persona_tool',
      toolId: 'files.read',
      decision: 'queued',
      pendingId: 'p-77',
      args: { path: 'a.ts' },
    });
    expect(queued).toMatchObject({
      type: 'persona_tool',
      toolId: 'files.read',
      decision: 'queued',
      pendingId: 'p-77',
    });
    if (queued !== null && queued.type === 'persona_tool') {
      expect(queued.pendingId).toBe('p-77');
      expect(queued.args).toEqual({ path: 'a.ts' });
    }
    // A queued decision without its approval id cannot be resumed — dropped.
    expect(
      asPlaybookRunEvent({ type: 'persona_tool', toolId: 'files.read', decision: 'queued' }),
    ).toBeNull();
    // executed/refused do not need a pending id.
    expect(
      asPlaybookRunEvent({ type: 'persona_tool', toolId: 'files.edit', decision: 'executed' }),
    ).toMatchObject({ decision: 'executed' });
    expect(
      asPlaybookRunEvent({
        type: 'persona_tool',
        toolId: 'files.apply',
        decision: 'refused',
        reason: 'high risk',
      }),
    ).toMatchObject({ decision: 'refused', reason: 'high risk' });
    expect(asPlaybookRunEvent({ type: 'persona_tool', decision: 'executed' })).toBeNull();
  });

  it('readRunDoneMeta surfaces a pause meta and a terminal meta', () => {
    const pause = readRunDoneMeta({
      type: 'done_meta',
      runId: 'run-9',
      status: 'running',
      pendingId: 'p-77',
      noteId: null,
      noteTitle: null,
      conversationId: null,
    });
    expect(pause).not.toBeNull();
    if (pause !== null && pause.type === 'done_meta') {
      expect(pause.pendingId).toBe('p-77');
      expect(pause.runId).toBe('run-9');
    }
    const terminal = readRunDoneMeta({
      type: 'done_meta',
      runId: 'run-9',
      status: 'done',
      pendingId: null,
      noteId: 'n-1',
      noteTitle: 'Research',
      conversationId: 'c-1',
    });
    expect(terminal).not.toBeNull();
    if (terminal !== null && terminal.type === 'done_meta') {
      expect(terminal.noteId).toBe('n-1');
      expect(terminal.status).toBe('done');
    }
    expect(readRunDoneMeta({ type: 'delta', text: 'x' })).toBeNull();
    expect(readRunDoneMeta({ type: 'done_meta', runId: 'run-9' })).not.toBeNull();
  });

  it('resumeRun POSTs the pending id to the run resume route', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      sseResponse([
        { type: 'delta', text: '…' },
        { type: 'done_meta', runId: 'run-9', status: 'loop_exhausted', pendingId: null, noteId: null, noteTitle: null, conversationId: null },
      ]),
    );
    const events: string[] = [];
    const result = await resumeRun('run-9', 'p-77', {
      token: TOKEN,
      fetchImpl,
      onEvent: (event) => events.push(event.type),
    });
    expect(result).toEqual({ ok: true });
    expect(calls[0]?.input).toBe('/v1/playbook-runs/run-9/resume');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(bodyOf(calls[0]!)).toEqual({ pendingId: 'p-77' });
    expect(events).toEqual(['delta', 'done_meta']);
  });

  it('skips malformed and [DONE] frames defensively', async () => {
    const raw =
      'data: [DONE]\n\n' +
      'data: not json\n\n' +
      'data: {"type":"delta","text":"ok"}\n\n' +
      'data: {"type":"bogus"}\n\n';
    const { fetchImpl } = recordFetch(
      () =>
        new Response(raw, {
          status: 200,
          headers: { 'content-type': 'text/event-stream' },
        }),
    );
    const seen: string[] = [];
    const result = await runPlaybook({
      token: TOKEN,
      playbookId: 'pb-x',
      inputs: {},
      fetchImpl,
      onEvent: (event) => seen.push(event.type),
    });
    expect(result).toEqual({ ok: true });
    expect(seen).toEqual(['delta']);
  });
});

describe('deploy profile client', () => {
  it('listDeployProfiles GETs /v1/deploy-profiles and normalizes rows', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ profiles: [PROFILE] }));
    const result = await listDeployProfiles(TOKEN, { fetchImpl });
    expect(result).toEqual([PROFILE]);
    expect(calls[0]?.input).toBe('/v1/deploy-profiles');
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
  });

  it('parseProfileList defaults port/username/baseDir when absent', () => {
    const rows = parseProfileList([
      { id: 'dp-2', name: 'home', kind: 'docker-ssh', host: '10.0.0.5', createdAt: 1, updatedAt: 1 },
    ]);
    expect(rows[0]).toMatchObject({ port: 22, username: null, remoteBaseDir: null });
  });

  it('parseProfileList rejects a body that is not a list', () => {
    expect(() => parseProfileList({ items: [] })).toThrow('unexpected shape');
  });

  it('parseProfile reads a bare or enveloped profile and throws on garbage', () => {
    expect(parseProfile(PROFILE).name).toBe('prod');
    expect(parseProfile({ profile: PROFILE }).host).toBe('enter.ne1.dev');
    expect(() => parseProfile({ id: 'dp-1' })).toThrow('unexpected shape');
  });

  it('createDeployProfile POSTs the input and returns the created profile', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ ...PROFILE, id: 'dp-new' }));
    const created = await createDeployProfile(
      TOKEN,
      { name: 'prod', host: 'enter.ne1.dev', username: 'root', port: 2222, remoteBaseDir: '/srv' },
      { fetchImpl },
    );
    expect(created.id).toBe('dp-new');
    expect(calls[0]?.input).toBe('/v1/deploy-profiles');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(bodyOf(calls[0]!)).toEqual({
      name: 'prod',
      host: 'enter.ne1.dev',
      username: 'root',
      port: 2222,
      remoteBaseDir: '/srv',
    });
  });

  it('deleteDeployProfile DELETEs /v1/deploy-profiles/:id and maps errors', async () => {
    const ok = recordFetch(() => new Response(null, { status: 204 }));
    await deleteDeployProfile(TOKEN, 'dp-1', { fetchImpl: ok.fetchImpl });
    expect(ok.calls[0]?.input).toBe('/v1/deploy-profiles/dp-1');
    expect(ok.calls[0]?.init?.method).toBe('DELETE');

    const failing = recordFetch(() => jsonResponse({ error: { message: 'profile busy' } }, 409));
    await expect(
      deleteDeployProfile(TOKEN, 'dp-1', { fetchImpl: failing.fetchImpl }),
    ).rejects.toMatchObject({ name: 'ApiRequestError', status: 409, message: 'profile busy' });
  });

  it('packageProfile POSTs the dirs to /v1/deploy-profiles/:id/package and parses the result', async () => {
    const payload = {
      profileId: 'dp-1',
      outDir: '/home/me/projects/foo/dist-deploy',
      files: ['Dockerfile', 'core.tgz', 'web-dist.tgz', 'README.md'],
      dockerfile: 'FROM node:22\n',
    };
    const { fetchImpl, calls } = recordFetch(() => jsonResponse(payload));
    const result = await packageProfile(
      TOKEN,
      'dp-1',
      { projectDir: '/home/me/projects/foo', outDir: '/home/me/projects/foo/dist-deploy' },
      { fetchImpl },
    );
    expect(result).toEqual(payload);
    expect(calls[0]?.input).toBe('/v1/deploy-profiles/dp-1/package');
    expect(bodyOf(calls[0]!)).toEqual({
      projectDir: '/home/me/projects/foo',
      outDir: '/home/me/projects/foo/dist-deploy',
    });
  });

  it('parsePackageResult requires the identity fields', () => {
    expect(() => parsePackageResult({})).toThrow('unexpected shape');
    expect(() => parsePackageResult({ profileId: 'x', outDir: 'o', files: [], dockerfile: '' })).not.toThrow();
    expect(() => parsePackageResult({ profileId: 'x', outDir: 'o', files: ['a', '', 3], dockerfile: '' })).not.toThrow();
    expect(
      parsePackageResult({ profileId: 'x', outDir: 'o', files: ['a', '', 3], dockerfile: '' }).files,
    ).toEqual(['a']);
    expect(() => parsePackageResult({ profileId: 'x', outDir: 'o', files: [], dockerfile: 7 })).toThrow(
      'unexpected shape',
    );
  });

  it('non-2xx package/CRUD responses surface ApiRequestError without echoing dirs', async () => {
    const { fetchImpl } = recordFetch(() =>
      jsonResponse({ error: { message: 'no grant' } }, 403),
    );
    await expect(
      packageProfile(TOKEN, 'dp-1', { projectDir: '/a', outDir: '/b' }, { fetchImpl }),
    ).rejects.toMatchObject({ name: 'ApiRequestError', status: 403, message: 'no grant' });
  });

  it('createDeployProfile rejects a garbage body', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ created: true }));
    await expect(
      createDeployProfile(TOKEN, { name: 'x', host: 'h' }, { fetchImpl }),
    ).rejects.toBeInstanceOf(ApiRequestError);
  });
});
