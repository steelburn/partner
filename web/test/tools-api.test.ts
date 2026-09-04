import { describe, expect, it } from 'vitest';
import { ApiRequestError } from '../src/lib/api.js';
import {
  addGrant,
  addRoot,
  applyProposal,
  decidePending,
  discardProposal,
  execTool,
  getProposal,
  listGrants,
  listPending,
  listRoots,
  removeGrant,
  removeRoot,
  type FetchLike,
} from '../src/lib/tools.js';

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

const ROOT = {
  id: 'r-1',
  label: 'My project',
  path: '/home/me/projects/foo',
  readOnly: false,
  addedAt: 1,
};

const GRANT = {
  id: 'g-1',
  toolId: 'files.list',
  projectId: 'r-1',
  source: 'user',
  createdAt: 1,
  expiresAt: null,
} as const;

describe('roots API', () => {
  it('listRoots GETs /v1/roots with the Bearer token and reads the envelope', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ roots: [ROOT] }));
    const result = await listRoots(TOKEN, { fetchImpl });
    expect(result).toEqual([ROOT]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toBe('/v1/roots');
    expect(calls[0]?.init?.method).toBe('GET');
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
  });

  it('listRoots tolerates a bare-array response', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse([ROOT]));
    const result = await listRoots(TOKEN, { fetchImpl });
    expect(result).toEqual([ROOT]);
  });

  it('listRoots rejects an unexpected body shape', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ items: [] }));
    await expect(listRoots(TOKEN, { fetchImpl })).rejects.toThrow('unexpected shape');
  });

  it('addRoot POSTs {label, path, readOnly} and returns the created root', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ ...ROOT, readOnly: true }));
    const result = await addRoot(
      TOKEN,
      { label: 'My project', path: '/home/me/projects/foo', readOnly: true },
      { fetchImpl },
    );
    expect(result.readOnly).toBe(true);
    expect(calls[0]?.input).toBe('/v1/roots');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(bodyOf(calls[0]!)).toEqual({
      label: 'My project',
      path: '/home/me/projects/foo',
      readOnly: true,
    });
  });

  it('removeRoot DELETEs /v1/roots/:id and maps errors to ApiRequestError', async () => {
    const { fetchImpl, calls } = recordFetch(() => new Response(null, { status: 204 }));
    await removeRoot(TOKEN, 'r-1', { fetchImpl });
    expect(calls[0]?.input).toBe('/v1/roots/r-1');
    expect(calls[0]?.init?.method).toBe('DELETE');

    const failing = recordFetch(() => jsonResponse({ error: { message: 'root busy' } }, 409));
    await expect(removeRoot(TOKEN, 'r-1', { fetchImpl: failing.fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 409,
      message: 'root busy',
    });
  });

  it('grant endpoints round-trip list / add / revoke', async () => {
    const list = recordFetch(() => jsonResponse({ grants: [GRANT] }));
    expect(await listGrants(TOKEN, { fetchImpl: list.fetchImpl })).toEqual([GRANT]);

    const added = recordFetch(() => jsonResponse(GRANT));
    const created = await addGrant(
      TOKEN,
      { toolId: 'files.list', projectId: 'r-1', note: 'browse' },
      { fetchImpl: added.fetchImpl },
    );
    expect(created.toolId).toBe('files.list');
    expect(bodyOf(added.calls[0]!)).toEqual({ toolId: 'files.list', projectId: 'r-1', note: 'browse' });

    const removed = recordFetch(() => new Response(null, { status: 204 }));
    await removeGrant(TOKEN, 'g-1', { fetchImpl: removed.fetchImpl });
    expect(removed.calls[0]?.input).toBe('/v1/grants/g-1');
    expect(removed.calls[0]?.init?.method).toBe('DELETE');
  });
});

describe('tools.exec', () => {
  it('POSTs {tool, params} and maps an executed result', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ outcome: 'executed', result: { entries: [] } }),
    );
    const result = await execTool(TOKEN, 'files.list', { projectId: 'r-1', path: '.' }, { fetchImpl });
    expect(result).toEqual({ outcome: 'executed', result: { entries: [] } });
    expect(calls[0]?.input).toBe('/v1/tools/exec');
    expect(bodyOf(calls[0]!)).toEqual({
      tool: 'files.list',
      params: { projectId: 'r-1', path: '.' },
    });
    // The token only ever travels in the Authorization header — never in the
    // URL or the body.
    expect(String(calls[0]?.input)).not.toContain(TOKEN);
    expect(JSON.stringify(bodyOf(calls[0]!))).not.toContain(TOKEN);
  });

  it('surfaces needs_approval distinctly with the pending id', async () => {
    const { fetchImpl } = recordFetch(() =>
      jsonResponse({ outcome: 'needs_approval', pendingId: 'p-77' }),
    );
    const result = await execTool(TOKEN, 'files.edit', { projectId: 'r-1', path: 'a.ts' }, { fetchImpl });
    expect(result).toEqual({ outcome: 'needs_approval', pendingId: 'p-77' });
    if (result.outcome === 'needs_approval') {
      expect(result.pendingId).toBe('p-77');
    }
  });

  it('maps an HTTP 403 denied body to the denied union instead of throwing', async () => {
    const { fetchImpl } = recordFetch(() =>
      jsonResponse({ outcome: 'denied', reason: 'no grant' }, 403),
    );
    const result = await execTool(TOKEN, 'files.read', { projectId: 'r-1', path: 'x' }, { fetchImpl });
    expect(result).toEqual({ outcome: 'denied', reason: 'no grant' });
  });

  it('throws ApiRequestError for non-broker failures without echoing params', async () => {
    const secret = 'sk-very-secret-key-material';
    const { fetchImpl } = recordFetch(() =>
      jsonResponse({ error: { message: 'bad params' } }, 400),
    );
    await expect(
      execTool(TOKEN, 'files.read', { projectId: 'r-1', path: 'x', apiKey: secret }, { fetchImpl }),
    ).rejects.toMatchObject({ name: 'ApiRequestError', status: 400, message: 'bad params' });
  });

  it('rejects a 200 whose body is not broker-shaped', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ outcome: 'executed' }));
    await expect(
      execTool(TOKEN, 'files.read', { projectId: 'r-1', path: 'x' }, { fetchImpl }),
    ).rejects.toBeInstanceOf(ApiRequestError);
  });
});

describe('approval queue decisions', () => {
  it('listPending reads the pending envelope', async () => {
    const item = {
      id: 'p-1',
      toolId: 'files.edit',
      params: { projectId: 'r-1', path: 'a.ts' },
      risk: 'medium',
      requestedBy: 'web',
      createdAt: 1,
    };
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ pending: [item] }));
    const result = await listPending(TOKEN, { fetchImpl });
    expect(result).toEqual([item]);
    expect(calls[0]?.input).toBe('/v1/tools/pending');
  });

  it('decidePending sends {decision: approve, remember: true} when remembering and returns the outcome', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ grantId: 'g-1', executed: true, result: { proposalId: 'pr-9' } }),
    );
    const outcome = await decidePending(
      TOKEN,
      'p-1',
      { decision: 'approve', remember: true },
      { fetchImpl },
    );
    expect(calls[0]?.input).toBe('/v1/tools/pending/p-1');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(bodyOf(calls[0]!)).toEqual({ decision: 'approve', remember: true });
    expect(outcome).toEqual({
      grantId: 'g-1',
      executed: true,
      result: { proposalId: 'pr-9' },
    });
  });

  it('decidePending omits remember when not remembering, supports deny, and surfaces execution errors', async () => {
    const approve = recordFetch(() => jsonResponse({ grantId: null, executed: false, error: 'not_pending' }));
    const approveOutcome = await decidePending(
      TOKEN,
      'p-1',
      { decision: 'approve' },
      { fetchImpl: approve.fetchImpl },
    );
    expect(bodyOf(approve.calls[0]!)).toEqual({ decision: 'approve' });
    expect(approveOutcome).toEqual({ grantId: null, executed: false, error: 'not_pending' });

    const deny = recordFetch(() => jsonResponse({ grantId: null, executed: false }));
    const denyOutcome = await decidePending(TOKEN, 'p-1', { decision: 'deny', note: 'nope' }, { fetchImpl: deny.fetchImpl });
    expect(bodyOf(deny.calls[0]!)).toEqual({ decision: 'deny', note: 'nope' });
    expect(denyOutcome.executed).toBe(false);
  });

  it('decidePending tolerates a legacy 204 response', async () => {
    const { fetchImpl } = recordFetch(() => new Response(null, { status: 204 }));
    const outcome = await decidePending(TOKEN, 'p-1', { decision: 'deny' }, { fetchImpl });
    expect(outcome).toEqual({ grantId: null, executed: false });
  });
});

describe('edit proposals', () => {
  const proposal = {
    id: 'pr-1',
    projectId: 'r-1',
    path: 'notes.md',
    originalContent: 'one',
    proposedContent: 'two',
    createdAt: 1,
  };

  it('getProposal GETs the detail payload from /v1/tools/proposals/:id', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse(proposal));
    const result = await getProposal(TOKEN, 'pr-1', { fetchImpl });
    expect(result).toEqual(proposal);
    expect(calls[0]?.input).toBe('/v1/tools/proposals/pr-1');
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
  });

  it('getProposal rejects a malformed payload', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ id: 'pr-1' }));
    await expect(getProposal(TOKEN, 'pr-1', { fetchImpl })).rejects.toThrow('unexpected shape');
  });

  it('applyProposal POSTs projectId+proposalId and maps executed / needs_approval', async () => {
    const ran = recordFetch(() =>
      jsonResponse({ outcome: 'needs_approval', pendingId: 'p-9' }),
    );
    const result = await applyProposal(
      TOKEN,
      { projectId: 'r-1', proposalId: 'pr-1' },
      { fetchImpl: ran.fetchImpl },
    );
    expect(result).toEqual({ outcome: 'needs_approval', pendingId: 'p-9' });
    expect(ran.calls[0]?.input).toBe('/v1/proposals/pr-1/apply');
    expect(bodyOf(ran.calls[0]!)).toEqual({ projectId: 'r-1', proposalId: 'pr-1' });

    const executed = recordFetch(() => jsonResponse({ outcome: 'executed', result: { applied: true } }));
    const second = await applyProposal(
      TOKEN,
      { projectId: 'r-1', proposalId: 'pr-1' },
      { fetchImpl: executed.fetchImpl },
    );
    expect(second).toEqual({ outcome: 'executed', result: { applied: true } });
  });

  it('applyProposal treats a 204 as executed and errors otherwise', async () => {
    const ok = recordFetch(() => new Response(null, { status: 204 }));
    const result = await applyProposal(
      TOKEN,
      { projectId: 'r-1', proposalId: 'pr-1' },
      { fetchImpl: ok.fetchImpl },
    );
    expect(result).toEqual({ outcome: 'executed', result: {} });

    const failing = recordFetch(() => jsonResponse({ error: 'gone' }, 404));
    await expect(
      applyProposal(TOKEN, { projectId: 'r-1', proposalId: 'pr-1' }, { fetchImpl: failing.fetchImpl }),
    ).rejects.toMatchObject({ name: 'ApiRequestError', status: 404 });
  });

  it('discardProposal DELETEs /v1/proposals/:id', async () => {
    const { fetchImpl, calls } = recordFetch(() => new Response(null, { status: 204 }));
    await discardProposal(TOKEN, 'pr-1', { fetchImpl });
    expect(calls[0]?.input).toBe('/v1/proposals/pr-1');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });
});
