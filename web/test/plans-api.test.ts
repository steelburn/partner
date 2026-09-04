import { describe, expect, it } from 'vitest';
import type { Plan, PlanSummary } from '@partner/shared';
import { ApiRequestError, type FetchLike } from '../src/lib/api.js';
import {
  createPlan,
  deletePlan,
  exportPlan,
  getPlan,
  listPlans,
  parsePlan,
  parsePlanList,
  setTaskStatus,
  updatePlan,
} from '../src/lib/plans.js';

const TOKEN = 'tok-secret';
const AUTH = { authorization: 'Bearer tok-secret' };

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

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan-1',
    title: 'Launch',
    description: 'Ship it',
    document: {
      milestones: [
        {
          id: 'm1',
          title: 'Build',
          tasks: [
            { id: 't1', title: 'Api', status: 'done', ownerPersonaId: 'p-1' },
            { id: 't2', title: 'UI', status: 'blocked', note: 'Waiting on design' },
          ],
        },
      ],
    },
    taskCount: 2,
    doneCount: 1,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

function planSummary(overrides: Partial<PlanSummary> = {}): PlanSummary {
  return {
    id: 'plan-1',
    title: 'Launch',
    description: null,
    taskCount: 2,
    doneCount: 1,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

describe('plan list + parsers', () => {
  it('listPlans GETs /v1/plans and reads the {plans: [...]} envelope', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ plans: [planSummary(), planSummary({ id: 'plan-2' })] }),
    );
    const result = await listPlans(TOKEN, { fetchImpl });
    expect(result).toHaveLength(2);
    expect(calls[0]?.input).toBe('/v1/plans');
    expect(calls[0]?.init?.headers).toMatchObject(AUTH);
  });

  it('listPlans tolerates a bare array', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse([planSummary({ id: 'p2' })]));
    const result = await listPlans(TOKEN, { fetchImpl });
    expect(result[0]?.id).toBe('p2');
  });

  it('parsePlanList derives counts from an embedded document when present', async () => {
    const list = parsePlanList({ plans: [planSummary()] });
    // summary rows carry the counts the core reported
    expect(list[0]?.taskCount).toBe(2);
    const withDoc = parsePlanList({ plans: [{ ...planSummary(), document: plan().document }] });
    expect(withDoc[0]).toMatchObject({ taskCount: 2, doneCount: 1 });
  });

  it('parsePlanList defaults counts to 0 and rejects malformed rows', () => {
    const row = parsePlanList([{ id: 'x', title: 'T', createdAt: 1, updatedAt: 2 }])[0];
    expect(row).toMatchObject({ taskCount: 0, doneCount: 0, description: null });
    expect(() => parsePlanList({ nope: [] })).toThrow(ApiRequestError);
    expect(() => parsePlanList([{ id: 7 }])).toThrow(ApiRequestError);
  });

  it('parsePlan accepts bare + {plan} envelopes and recomputes counts from the document', () => {
    const full = plan({ taskCount: 99, doneCount: 99 }); // stale counts — document wins
    const parsed = parsePlan(full);
    expect(parsed).toMatchObject({ taskCount: 2, doneCount: 1 });
    expect(parsePlan({ plan: full }).id).toBe('plan-1');
    expect(() => parsePlan({ nope: true })).toThrow(ApiRequestError);
  });

  it('parsePlan rejects unknown task statuses and malformed milestones', () => {
    expect(() => parsePlan(plan({ document: { milestones: [{ id: 'm', title: 'M', tasks: [{ id: 't', title: 'T', status: 'maybe' }] }] } }))).toThrow(ApiRequestError);
    expect(() => parsePlan(plan({ document: { milestones: [{ id: 'm', title: 'M', tasks: [{}] }] } }))).toThrow(ApiRequestError);
  });
});

describe('plan CRUD + status transitions', () => {
  it('createPlan POSTs {title, description?} and parses the created plan', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ plan: plan({ id: 'p-new', document: { milestones: [] }, taskCount: 0, doneCount: 0 }) }),
    );
    const result = await createPlan(TOKEN, { title: 'New', description: 'desc' }, { fetchImpl });
    expect(result.id).toBe('p-new');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ title: 'New', description: 'desc' });
  });

  it('getPlan GETs /v1/plans/:id and updatePlan PUTs the full resource', async () => {
    const get = recordFetch(() => jsonResponse(plan()));
    expect((await getPlan(TOKEN, 'plan-1', { fetchImpl: get.fetchImpl })).title).toBe('Launch');
    expect(get.calls[0]?.input).toBe('/v1/plans/plan-1');

    const put = recordFetch(() => jsonResponse(plan({ updatedAt: 999 })));
    const updated = await updatePlan(
      TOKEN,
      'plan-1',
      { title: 'Renamed', description: null, document: plan().document },
      { fetchImpl: put.fetchImpl },
    );
    expect(updated.updatedAt).toBe(999);
    expect(put.calls[0]?.input).toBe('/v1/plans/plan-1');
    expect(put.calls[0]?.init?.method).toBe('PUT');
    const body = JSON.parse(String(put.calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.title).toBe('Renamed');
    expect(body.description).toBeNull();
    expect(body.document).toBeDefined();
  });

  it('deletePlan resolves on 204 and surfaces a typed 404', async () => {
    const ok = recordFetch(() => new Response(null, { status: 204 }));
    await expect(deletePlan(TOKEN, 'plan-1', { fetchImpl: ok.fetchImpl })).resolves.toBeUndefined();
    expect(ok.calls[0]?.init?.method).toBe('DELETE');
    const missing = recordFetch(() => jsonResponse({ error: 'not found' }, 404));
    await expect(deletePlan(TOKEN, 'plan-x', { fetchImpl: missing.fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 404,
    });
  });

  it('setTaskStatus POSTs to /v1/plans/:id/tasks/:taskId and returns the refreshed plan', async () => {
    const { fetchImpl, calls } = recordFetch(() => jsonResponse({ plan: plan({ updatedAt: 300 }) }));
    const result = await setTaskStatus(TOKEN, 'plan-1', 't2', { status: 'done' }, { fetchImpl });
    expect(result.updatedAt).toBe(300);
    expect(calls[0]?.input).toBe('/v1/plans/plan-1/tasks/t2');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toMatchObject({ 'content-type': 'application/json' });
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ status: 'done' });
  });

  it('setTaskStatus trims + sends the note and omits blank notes', async () => {
    const withNote = recordFetch(() => jsonResponse({ plan: plan() }));
    await setTaskStatus(TOKEN, 'plan-1', 't2', { status: 'blocked', note: '  blocked by review  ' }, {
      fetchImpl: withNote.fetchImpl,
    });
    expect(JSON.parse(String(withNote.calls[0]?.init?.body))).toEqual({
      status: 'blocked',
      note: 'blocked by review',
    });
    const blank = recordFetch(() => jsonResponse({ plan: plan() }));
    await setTaskStatus(TOKEN, 'plan-1', 't2', { status: 'open', note: '   ' }, {
      fetchImpl: blank.fetchImpl,
    });
    expect(JSON.parse(String(blank.calls[0]?.init?.body))).toEqual({ status: 'open' });
  });

  it('setTaskStatus rejects an invalid status BEFORE fetching (typed 400)', async () => {
    let fetched = false;
    const fetchImpl: FetchLike = () => {
      fetched = true;
      return Promise.resolve(new Response(null, { status: 204 }));
    };
    await expect(
      setTaskStatus(TOKEN, 'plan-1', 't1', { status: 'maybe' as never }, { fetchImpl }),
    ).rejects.toMatchObject({ name: 'ApiRequestError', status: 400 });
    expect(fetched).toBe(false);
  });

  it('setTaskStatus surfaces a typed 404 for an unknown task', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ error: 'task not found' }, 404));
    await expect(
      setTaskStatus(TOKEN, 'plan-1', 'nope', { status: 'done' }, { fetchImpl }),
    ).rejects.toMatchObject({ name: 'ApiRequestError', status: 404 });
  });
});

describe('plan export client', () => {
  it('exportPlan POSTs /v1/plans/:id/export and reads a canonical bundle', async () => {
    const { fetchImpl, calls } = recordFetch(() =>
      jsonResponse({ schema: 'plan/v1', exportedAt: 777, plan: plan() }),
    );
    const result = await exportPlan(TOKEN, 'plan-1', { fetchImpl });
    expect(result).toMatchObject({ schema: 'plan/v1', exportedAt: 777 });
    expect(result.plan.id).toBe('plan-1');
    expect(calls[0]?.input).toBe('/v1/plans/plan-1/export');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.headers).toMatchObject(AUTH);
  });

  it('exportPlan tolerates a bare plan or a {plan: …} wrapper', async () => {
    const bare = recordFetch(() => jsonResponse(plan()));
    const wrapped = recordFetch(() => jsonResponse({ plan: plan() }));
    const fromBare = await exportPlan(TOKEN, 'plan-1', { fetchImpl: bare.fetchImpl });
    expect(fromBare.schema).toBe('plan/v1');
    expect(fromBare.plan.title).toBe('Launch');
    expect(Number.isFinite(fromBare.exportedAt)).toBe(true);
    const fromWrapped = await exportPlan(TOKEN, 'plan-1', { fetchImpl: wrapped.fetchImpl });
    expect(fromWrapped.plan.id).toBe('plan-1');
  });

  it('exportPlan surfaces a typed 404', async () => {
    const { fetchImpl } = recordFetch(() => jsonResponse({ error: 'not found' }, 404));
    await expect(exportPlan(TOKEN, 'plan-x', { fetchImpl })).rejects.toMatchObject({
      name: 'ApiRequestError',
      status: 404,
    });
  });
});
