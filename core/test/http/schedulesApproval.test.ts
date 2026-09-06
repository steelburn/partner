/**
 * M14 end-to-end approval → auto-resume (PLAN-M14.md S5 hook).
 *
 * The one seam unit tests can't prove: a REAL persona tool loop (shared
 * playbook engine over the REAL broker + pending stores) queued by a missing
 * grant, decided through the HTTP pending route, and resumed headlessly by
 * the decide hook — no client ever calls a resume endpoint.
 *
 * Scripted provider (loop.test pattern): turn 1 emits a files.read
 * directive; the autonomous persona has NO grant, so the loop queues
 * (needs_grant) and the run pauses. The test then POSTs the approval
 * (approve → broker executes the read once against a real temp root), and
 * asserts the run continues to done with the transcript + audit rows in
 * place — proof that tryResumeAfterDecision fired from the decide route.
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type {
  ChatEvent,
  ChatRequest,
  ChatMessage,
  HealthReport,
  ProviderClient,
} from '@partner/shared';
import { demoHarness, ALLOWED_HOST, makeTempRoot, removeTempRoot } from '../helpers.js';
import type { Harness } from '../helpers.js';

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) removeTempRoot(tempDirs.pop() as string);
});

async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const pairRes = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(pairRes.status).toBe(200);
  return pairRes.body.token as string;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

/** Scripted provider: reply[i] per model call (directive first, then done). */
function scriptedProvider(replies: string[]): {
  client: ProviderClient;
  seen: () => ChatMessage[][];
} {
  const seen: ChatMessage[][] = [];
  let calls = 0;
  const client: ProviderClient = {
    async *chatStream(req: ChatRequest): AsyncGenerator<ChatEvent> {
      seen.push(req.messages);
      const idx = Math.min(calls, replies.length - 1);
      calls += 1;
      const text = replies[idx] ?? '';
      yield { type: 'delta', text };
      yield { type: 'usage', promptTokens: 1, completionTokens: text.length, totalTokens: 1 + text.length };
      yield { type: 'done', model: 'scripted-model', latencyMs: 1 };
    },
    async health(): Promise<HealthReport> {
      return { ok: true, latencyMs: 0 };
    },
  };
  return { client, seen: () => seen };
}

const readDirective = (projectId: string): string =>
  `Read hello.txt and report.\n[[partner:tool files.read ${JSON.stringify({
    projectId,
    path: 'hello.txt',
  })}]]`;

async function waitForStatus(
  h: Harness,
  token: string,
  runId: string,
  wanted: 'queued' | 'done',
  timeoutMs = 5000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await request(h.app).get(`/v1/schedules/runs/${runId}`).set(authed(token));
    expect(res.status).toBe(200);
    const run = res.body as { status: string };
    if (run.status === wanted) return res.body as Record<string, unknown>;
    if (Date.now() > deadline) {
      throw new Error(`run never reached ${wanted}: ${JSON.stringify(run)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('M14 real-loop approval -> auto-resume over HTTP', () => {
  it('approve: queues on a missing grant, executes on decide, resumes headlessly to done', async () => {
    const dir = makeTempRoot();
    tempDirs.push(dir);
    writeFileSync(join(dir, 'hello.txt'), 'scheduled work read me', 'utf8');

    // The resolver is a holder: it is only called when the run fires (after
    // the real root id exists, so the directive can name it).
    let target: { client: ProviderClient; model: string } | null = null;
    const h = demoHarness({
      playbookProvider: () => target,
    });
    try {
      const root = h.projectRootManager?.add({ label: 'root', path: dir, readOnly: false });
      expect(root).toBeDefined();
      const script = scriptedProvider([
        readDirective(root?.id as string),
        'All set — the scheduled task is complete.',
      ]);
      target = { client: script.client, model: 'scripted-model' };

      const token = await pairToken(h);
      const persona = h.personas.create({
        name: 'Approval runner',
        independence: {
          level: 'autonomous',
          schedules: [
            {
              id: 's-read',
              label: 'Read a file',
              when: { kind: 'interval', everyMinutes: 5 },
              prompt: 'Read hello.txt and confirm.',
              enabled: true,
            },
          ],
        },
      });

      const fired = await request(h.app)
        .post(`/v1/personas/${persona.id}/schedules/s-read/run-now`)
        .set(authed(token));
      expect(fired.status).toBe(200);
      const { runId } = fired.body as { runId: string };

      // The run pauses waiting for a human approval (status queued).
      const queuedRun = await waitForStatus(h, token, runId, 'queued');
      const pendingId = queuedRun.pendingId as string;
      expect(typeof pendingId).toBe('string');
      expect(queuedRun.live).toBe(true);

      // The queued approval row is persona-requested (the loop's enqueue).
      const pending = h.broker?.pending.get(pendingId);
      expect(pending).toBeDefined();
      expect((pending as { requestedBy?: string }).requestedBy).toBe('persona');

      // Approve through the real pending route: broker executes the read
      // once; the decide hook resumes the run headlessly (no client resume).
      const approve = await request(h.app)
        .post(`/v1/tools/pending/${pendingId}`)
        .set(authed(token))
        .send({ decision: 'approve', remember: false });
      expect(approve.status).toBe(200);

      const done = await waitForStatus(h, token, runId, 'done');
      expect(done.status).toBe('done');
      expect(done.error).toBeNull();
      expect(done.model).toBe('scripted-model');
      expect(done.rounds).toBe(2);
      expect(done.pendingId).toBeNull();

      // The provider saw two rounds; round 2's history carries the fed-back
      // tool result note (real loop mechanics after the approve).
      const history = script.seen();
      expect(history).toHaveLength(2);
      // The approve executed the tool via broker.decide; resume feeds the
      // approval outcome note back into the next model round.
      expect(
        history[1]?.some((m) => m.content.includes('was approved by the user and executed')),
      ).toBe(true);

      // Transcript: the brief (user) + the final answer (assistant).
      const conversationId = done.conversationId as string;
      const detail = h.conversations.get(conversationId);
      const messages = (detail as { messages: Array<{ role: string; content: string }> }).messages;
      expect(messages).toHaveLength(2);
      expect(messages[1]?.content).toBe('All set — the scheduled task is complete.');

      // Audit proves run + resume + the executed tool decision (the loop's
      // 'playbook.tool' rows land per tool decision).
      const auditRows = h.audit.list(50);
      expect(auditRows.some((r) => r.action === 'schedule.run')).toBe(true);
      expect(auditRows.some((r) => r.action === 'schedule.resume')).toBe(true);
      const toolRow = auditRows.find((r) => r.target === 'files.read');
      expect(toolRow).toBeDefined();
      const toolDetails = JSON.parse(toolRow?.details ?? '{}') as { decision?: string };
      expect(toolDetails.decision).toBe('executed');
      // Content discipline: no file body or brief text in any audit row.
      expect(JSON.stringify(auditRows)).not.toContain('scheduled work read me');
      expect(JSON.stringify(auditRows)).not.toContain('Read hello.txt and confirm.');
    } finally {
      h.close();
    }
  });

  it('deny: the decision note is fed back, the run resumes and finishes', async () => {
    const dir = makeTempRoot();
    tempDirs.push(dir);
    writeFileSync(join(dir, 'hello.txt'), 'x', 'utf8');
    let target: { client: ProviderClient; model: string } | null = null;
    const h = demoHarness({ playbookProvider: () => target });
    try {
      const root = h.projectRootManager?.add({ label: 'root', path: dir, readOnly: false });
      const script = scriptedProvider([
        readDirective(root?.id as string),
        'Understood — I will not read it.',
      ]);
      target = { client: script.client, model: 'scripted-model' };

      const token = await pairToken(h);
      const persona = h.personas.create({
        name: 'Denied runner',
        independence: {
          level: 'autonomous',
          schedules: [
            {
              id: 's-read2',
              label: 'Read attempt',
              when: { kind: 'interval', everyMinutes: 10 },
              prompt: 'Try reading hello.txt.',
              enabled: true,
            },
          ],
        },
      });
      const fired = await request(h.app)
        .post(`/v1/personas/${persona.id}/schedules/s-read2/run-now`)
        .set(authed(token));
      const { runId } = fired.body as { runId: string };
      const queuedRun = await waitForStatus(h, token, runId, 'queued');

      const denied = await request(h.app)
        .post(`/v1/tools/pending/${queuedRun.pendingId as string}`)
        .set(authed(token))
        .send({ decision: 'deny' });
      expect(denied.status).toBe(200);

      const done = await waitForStatus(h, token, runId, 'done');
      expect(done.status).toBe('done');
      expect(done.rounds).toBe(2);
      const detail = h.conversations.get(done.conversationId as string);
      const messages = (detail as { messages: Array<{ role: string; content: string }> }).messages;
      expect(messages[1]?.content).toBe('Understood — I will not read it.');
      // Denied: the tool never executed (no executed decision row).
      const auditRows = h.audit.list(50);
      expect(auditRows.some((r) => r.action === 'schedule.resume')).toBe(true);
      const executed = auditRows.find(
        (r) => r.target === 'files.read' && r.details.includes('"decision":"executed"'),
      );
      expect(executed).toBeUndefined();
    } finally {
      h.close();
    }
  });
});

