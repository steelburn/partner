/**
 * M5 plan manager tests (PLAN-M5.md §"Tests"): CRUD with document shape
 * validation (rejects bad shapes), task status transitions (unknown
 * plan/task -> typed not_found), done counts + updatedAt bumps, plan FTS kept
 * in step with writes/deletes, export bundle shape, and audit rows that carry
 * ids/status/lengths but NEVER document or task-note content.
 */
import { describe, expect, it } from 'vitest';
import type { PlanDocument, PlanTask } from '@partner/shared';
import { PlanError, validateDocument } from '../../src/plans/index.js';
import { makeNotesEnv, sequentialClock } from '../notes/notesEnv.js';
import type { NotesTestEnv } from '../notes/notesEnv.js';
import { escapeFtsQuery } from '../../src/memory/search.js';

const DOC: PlanDocument = {
  milestones: [
    {
      id: 'm1',
      title: 'Milestone one',
      tasks: [
        { id: 't1', title: 'Task one', status: 'open' },
        { id: 't2', title: 'Task two', status: 'open', ownerPersonaId: 'p-scribe' },
      ],
    },
    { id: 'm2', title: 'Milestone two', tasks: [{ id: 't3', title: 'Task three', status: 'blocked' }] },
  ],
};

describe('plan manager — create/update/list/get/remove', () => {
  it('create() makes an EMPTY plan (milestones []) with trimmed title', () => {
    const env = makeNotesEnv({ now: sequentialClock() });
    try {
      const plan = env.plans.create({ title: '  Ship M5  ', description: 'core + web' });
      expect(plan).toMatchObject({
        title: 'Ship M5',
        description: 'core + web',
        document: { milestones: [] },
        taskCount: 0,
        doneCount: 0,
      });
      expect(typeof plan.id).toBe('string');
      expect(env.plans.get(plan.id)).toEqual(plan);
    } finally {
      env.close();
    }
  });

  it('validates create input -> invalid_input', () => {
    const env = makeNotesEnv();
    try {
      for (const input of [
        {},
        { title: '   ' },
        { title: 42 },
        { title: 'x', description: 7 },
      ] as unknown[]) {
        try {
          env.plans.create(input as never);
          expect.unreachable('should throw');
        } catch (err) {
          expect(err).toBeInstanceOf(PlanError);
          expect((err as PlanError).code).toBe('invalid_input');
        }
      }
      expect(env.plans.list()).toHaveLength(0);
    } finally {
      env.close();
    }
  });

  it('update() replaces title/description/document; null description clears it', () => {
    const env = makeNotesEnv();
    try {
      const plan = env.plans.create({ title: 'Original', description: 'desc' });
      const updated = env.plans.update(plan.id, {
        title: 'Renamed',
        description: null,
        document: DOC,
      });
      expect(updated.title).toBe('Renamed');
      expect(updated.description).toBeNull();
      expect(updated.document.milestones).toHaveLength(2);
      expect(updated.taskCount).toBe(3);

      const touched = env.plans.update(plan.id, { title: 'Only title' });
      expect(touched.document.milestones).toHaveLength(2); // document untouched
    } finally {
      env.close();
    }
  });

  it('remove() deletes the plan; list() sorts newest first; unknown ids are typed not_found', () => {
    const env = makeNotesEnv({ now: sequentialClock() });
    try {
      const a = env.plans.create({ title: 'A' });
      const b = env.plans.create({ title: 'B' });
      expect(env.plans.list().map((p) => p.title)).toEqual(['B', 'A']); // created desc tie-break

      env.plans.remove(a.id);
      expect(env.plans.get(a.id)).toBeNull();
      expect(env.plans.list().map((p) => p.id)).toEqual([b.id]);

      for (const call of [
        () => env.plans.remove('missing'),
        () => env.plans.update('missing', { title: 'z' }),
      ]) {
        try {
          call();
          expect.unreachable('should throw');
        } catch (err) {
          expect(err).toBeInstanceOf(PlanError);
          expect((err as PlanError).code).toBe('not_found');
        }
      }
    } finally {
      env.close();
    }
  });
});

describe('plan document validation', () => {
  it('accepts a valid document and keeps optional fields', () => {
    const doc = validateDocument(DOC);
    expect(doc).toEqual(DOC);
  });

  it('rejects bad shapes with typed invalid_input naming the path only', () => {
    const env = makeNotesEnv();
    const plan = env.plans.create({ title: 'P' });
    const badDocs: Array<[string, unknown]> = [
      ['non-object', 'nope'],
      ['array', []],
      ['milestones not an array', { milestones: 'x' }],
      ['milestone not an object', { milestones: ['x'] }],
      ['milestone missing id', { milestones: [{ title: 'm', tasks: [] }] }],
      ['milestone missing title', { milestones: [{ id: 'm1', tasks: [] }] }],
      ['milestone tasks not an array', { milestones: [{ id: 'm1', title: 'm', tasks: {} }] }],
      ['task not an object', { milestones: [{ id: 'm1', title: 'm', tasks: ['x'] }] }],
      ['task missing title', { milestones: [{ id: 'm1', title: 'm', tasks: [{ id: 't1', status: 'open' }] }] }],
      ['task missing status', { milestones: [{ id: 'm1', title: 'm', tasks: [{ id: 't1', title: 't' }] }] }],
      ['task bad status', { milestones: [{ id: 'm1', title: 'm', tasks: [{ id: 't1', title: 't', status: 'maybe' }] }] }],
      ['task empty id', { milestones: [{ id: 'm1', title: 'm', tasks: [{ id: ' ', title: 't', status: 'open' }] }] }],
      ['ownerPersonaId non-string', { milestones: [{ id: 'm1', title: 'm', tasks: [{ id: 't1', title: 't', status: 'open', ownerPersonaId: 9 }] }] }],
      ['task note non-string', { milestones: [{ id: 'm1', title: 'm', tasks: [{ id: 't1', title: 't', status: 'open', note: [] }] }] }],
    ];
    for (const [label, doc] of badDocs) {
      try {
        env.plans.update(plan.id, { document: doc as never });
        expect.unreachable(`should reject: ${label}`);
      } catch (err) {
        expect(err, label).toBeInstanceOf(PlanError);
        expect((err as PlanError).code, label).toBe('invalid_input');
        // Error messages never echo the offending document content.
        expect((err as PlanError).message).not.toContain('m1');
        expect((err as PlanError).message).not.toContain('milestone one');
      }
    }
    // The failed updates left the plan document untouched.
    expect(env.plans.get(plan.id)?.document).toEqual({ milestones: [] });
  });
});

describe('task status transitions', () => {
  function planWithTasks(env: NotesTestEnv): { planId: string; t1: string; t2: string; t3: string } {
    const plan = env.plans.create({ title: 'Plan', description: 'goals' });
    env.plans.update(plan.id, { document: DOC });
    return {
      planId: plan.id,
      t1: DOC.milestones[0]?.tasks[0]?.id ?? '',
      t2: DOC.milestones[0]?.tasks[1]?.id ?? '',
      t3: DOC.milestones[1]?.tasks[0]?.id ?? '',
    };
  }

  it('toggles status, replaces the note and bumps updatedAt; doneCount follows', () => {
    const env = makeNotesEnv({ now: sequentialClock() });
    try {
      const { planId, t1, t3 } = planWithTasks(env);
      const before = env.plans.get(planId);

      const done = env.plans.setTaskStatus(planId, t1, { status: 'done', note: 'finished it' });
      expect(done.doneCount).toBe(1);
      expect(done.taskCount).toBe(3);
      expect(done.updatedAt).toBeGreaterThanOrEqual(before?.updatedAt ?? 0);
      const task = findTask(done.document, t1);
      expect(task).toMatchObject({ status: 'done', note: 'finished it' });

      // Re-toggling back to open with a NEW note replaces the old note.
      const open = env.plans.setTaskStatus(planId, t1, { status: 'open' });
      const reopened = findTask(open.document, t1);
      expect(reopened).toMatchObject({ status: 'open' });
      expect(reopened?.note).toBeUndefined(); // omitted note clears the previous one
      expect(open.doneCount).toBe(0);

      // A transition on the OTHER milestone's task still finds it.
      const third = env.plans.setTaskStatus(planId, t3, { status: 'done', note: '' });
      expect(third.doneCount).toBe(1);
      expect(findTask(third.document, t3)?.note).toBe('');
    } finally {
      env.close();
    }
  });

  it('unknown plan or task -> typed not_found; bad status/body -> invalid_input', () => {
    const env = makeNotesEnv();
    try {
      const { planId } = planWithTasks(env);
      const cases: Array<[string, string, string, PlanError['code']]> = [
        ['unknown plan', 'missing-plan', 't1', 'not_found'],
        ['unknown task', planId, 'no-such-task', 'not_found'],
        ['empty task id', planId, '', 'invalid_input'],
        ['bad status', planId, 't1', 'invalid_input'],
        ['non-object body', planId, 't1', 'invalid_input'],
      ];
      for (const [label, pid, taskId, code] of cases) {
        const input =
          label === 'bad status'
            ? { status: 'maybe' }
            : label === 'non-object body'
              ? 'nope'
              : { status: 'done' };
        try {
          env.plans.setTaskStatus(pid, taskId, input as never);
          expect.unreachable(`should throw for ${label}`);
        } catch (err) {
          expect(err, label).toBeInstanceOf(PlanError);
          expect((err as PlanError).code, label).toBe(code);
        }
      }
    } finally {
      env.close();
    }
  });

  it('keeps the other milestones/tasks byte-identical on a transition', () => {
    const env = makeNotesEnv();
    try {
      const { planId, t2, t3 } = planWithTasks(env);
      const before = env.plans.get(planId)?.document;
      const afterDoc = env.plans.setTaskStatus(planId, t2, { status: 'done' }).document;
      const afterBefore: PlanDocument = JSON.parse(JSON.stringify(before)) as PlanDocument;
      for (const milestone of afterBefore.milestones) {
        for (const task of milestone.tasks) {
          if (task.id === t2) task.status = 'done';
        }
      }
      expect(afterDoc).toEqual(afterBefore);
      void t3;
    } finally {
      env.close();
    }
  });
});

describe('plan FTS mirror + export', () => {
  it('keeps plan text (titles only) in step with update/remove', () => {
    const env = makeNotesEnv();
    try {
      const plan = env.plans.create({ title: 'Kitchen remodel', description: 'fix the tiles' });
      env.plans.update(plan.id, {
        document: {
          milestones: [{ id: 'm1', title: 'Demolition', tasks: [{ id: 't1', title: 'Demo wall', status: 'open' }] }],
        },
      });
      const match = (q: string): Array<{ kind: string; refId: string }> =>
        env.stores.fts.match(escapeFtsQuery(q), 50).map((h) => ({ kind: h.kind, refId: h.refId }));
      expect(match('remodel')).toEqual([{ kind: 'plan', refId: plan.id }]);
      expect(match('demolition')).toEqual([{ kind: 'plan', refId: plan.id }]);
      // Milestone/task titles are indexed; task note content is NOT.
      env.plans.update(plan.id, {
        document: {
          milestones: [
            {
              id: 'm1',
              title: 'Demolition',
              tasks: [
                {
                  id: 't1',
                  title: 'Demo wall',
                  status: 'open',
                  note: 'super-secret-task-note-content',
                },
              ],
            },
          ],
        },
      });
      expect(match('super-secret-task-note-content')).toEqual([]);

      // Renaming the title re-indexes (old phrase gone, new phrase found).
      env.plans.update(plan.id, { title: 'Bathroom remodel' });
      expect(match('kitchen')).toEqual([]);
      expect(match('bathroom')).toEqual([{ kind: 'plan', refId: plan.id }]);

      env.plans.remove(plan.id);
      expect(match('bathroom')).toEqual([]);
    } finally {
      env.close();
    }
  });

  it('exportPlan() returns the plan/v1 bundle; unknown id -> not_found', () => {
    const env = makeNotesEnv();
    try {
      const plan = env.plans.create({ title: 'Exported', description: 'd' });
      env.plans.update(plan.id, { document: DOC });
      const bundle = env.plans.exportPlan(plan.id);
      expect(bundle.schema).toBe('plan/v1');
      expect(typeof bundle.exportedAt).toBe('number');
      expect(bundle.plan.id).toBe(plan.id);
      expect(bundle.plan.document.milestones).toHaveLength(2);
      try {
        env.plans.exportPlan('missing');
        expect.unreachable('should throw');
      } catch (err) {
        expect((err as PlanError).code).toBe('not_found');
      }
    } finally {
      env.close();
    }
  });
});

describe('plan audit privacy', () => {
  it('audit rows carry ids/status/lengths — never document or task-note content', () => {
    const env = makeNotesEnv();
    try {
      const secretMilestone = 'hidden-milestone-title-zebra';
      const secretTaskNote = 'task note with classified details';
      const plan = env.plans.create({ title: 'Public plan title', description: 'public desc' });
      env.plans.update(plan.id, {
        document: {
          milestones: [
            {
              id: 'm1',
              title: secretMilestone,
              tasks: [{ id: 't1', title: 'open task', status: 'open' }],
            },
          ],
        },
      });
      env.plans.setTaskStatus(plan.id, 't1', { status: 'done', note: secretTaskNote });
      env.plans.remove(plan.id);

      const rows = env.auditStore.list(50);
      const actions = rows.map((r) => r.action);
      for (const action of ['plan.create', 'plan.update', 'plan.setTaskStatus', 'plan.delete']) {
        expect(actions).toContain(action);
      }
      const details = rows.map((r) => `${r.action}|${r.target}|${r.details}`).join('\n');
      expect(details).not.toContain(secretMilestone);
      expect(details).not.toContain(secretTaskNote);
      expect(details).not.toContain('open task');
      expect(details).not.toContain('Public plan title');
      // Useful signals remain: status + lengths, never content.
      expect(details).toContain('"status":"done"');
      expect(details).toContain('noteLength');
      expect(details).toContain('titleLength');
    } finally {
      env.close();
    }
  });
});

/** Find a task by id anywhere in the document. */
function findTask(document: PlanDocument, taskId: string): PlanTask | undefined {
  for (const milestone of document.milestones) {
    const task = milestone.tasks.find((t) => t.id === taskId);
    if (task) return task;
  }
  return undefined;
}
