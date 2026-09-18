/**
 * M34 — the session-title suggestion route (PLAN-M34.md slice B).
 *
 * The request: "write chat session title at the top. Make it
 * editable/AI-suggestible — meaning the chat topic can be reviewed after a few
 * back and forth communication between persona and user."
 *
 * These tests pin the contract that makes "suggestible" safe:
 *
 *   1. OFFERED AFTER A FEW TURNS. Before that the route answers 400
 *      `not_enough_context` instead of naming a session from "hello".
 *   2. A PROPOSAL, NEVER A WRITE. The conversation's title is byte-identical
 *      after the call; the accept path stays the ordinary PUT.
 *   3. HONEST. Demo/no-provider answers with the derived title and says so
 *      (`source: 'transcript'`); a reply the core cannot use is `ok:false` with
 *      a sentence at 200; a provider that cannot serve the call is a typed
 *      failure the UI can report.
 *   4. COUNTED, NEVER QUOTED. The audit row carries message/turn counts, the
 *      model name and the title LENGTH — never a message or the title text.
 */
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { demoHarness, ALLOWED_HOST } from '../helpers.js';
import type { Harness } from '../helpers.js';
import type { TitleSuggester } from '../../src/conversations/title.js';
import type { ConversationMessage } from '@partner/shared';

async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const pairRes = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(pairRes.status).toBe(200);
  return pairRes.body.token as string;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

/** Seed a conversation with `turns` user messages (each answered). */
function seed(h: Harness, turns: number): string {
  const created = h.conversations.create({});
  for (let turn = 0; turn < turns; turn += 1) {
    h.conversations.append(created.id, 'user', { content: `question ${turn}` });
    h.conversations.append(created.id, 'assistant', {
      content: `answer ${turn}`,
      model: 'demo',
      latencyMs: 1,
    });
  }
  return created.id;
}

function fakeSuggester(outcome: Awaited<ReturnType<TitleSuggester['suggest']>>): {
  suggester: TitleSuggester;
  seen: ConversationMessage[][];
} {
  const seen: ConversationMessage[][] = [];
  return {
    seen,
    suggester: {
      async suggest(input) {
        seen.push([...input.messages]);
        return outcome;
      },
    },
  };
}

describe('auth gate on the title-suggestion route', () => {
  it('returns 401 without a token', async () => {
    const h = demoHarness();
    try {
      const res = await request(h.app)
        .post('/v1/conversations/x/title-suggestion')
        .set('Host', ALLOWED_HOST)
        .send({});
      expect(res.status).toBe(401);
    } finally {
      h.close();
    }
  });
});

describe('POST /v1/conversations/:id/title-suggestion', () => {
  it('501s when the suggester is not wired', async () => {
    const h = demoHarness({ titleSuggester: null });
    try {
      const token = await pairToken(h);
      const id = seed(h, 2);
      const res = await request(h.app)
        .post(`/v1/conversations/${id}/title-suggestion`)
        .set(authed(token))
        .send({});
      expect(res.status).toBe(501);
      expect(res.body.error).toBe('not_configured');
    } finally {
      h.close();
    }
  });

  it('404s an unknown conversation and 400s one with too few turns', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const missing = await request(h.app)
        .post('/v1/conversations/nope/title-suggestion')
        .set(authed(token))
        .send({});
      expect(missing.status).toBe(404);
      expect(missing.body.error).toBe('not_found');

      const early = await request(h.app)
        .post(`/v1/conversations/${seed(h, 1)}/title-suggestion`)
        .set(authed(token))
        .send({});
      expect(early.status).toBe(400);
      expect(early.body.error).toBe('not_enough_context');
    } finally {
      h.close();
    }
  });

  it('proposes a title, writes nothing, and audits counts only', async () => {
    const { suggester, seen } = fakeSuggester({
      ok: true,
      title: 'Rotating the sqlite key',
      model: 'fake-model',
      source: 'model',
    });
    const h = demoHarness({ titleSuggester: suggester });
    try {
      const token = await pairToken(h);
      const id = seed(h, 2);
      const res = await request(h.app)
        .post(`/v1/conversations/${id}/title-suggestion`)
        .set(authed(token))
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: true,
        title: 'Rotating the sqlite key',
        model: 'fake-model',
        source: 'model',
        userTurns: 2,
        messageCount: 4,
      });
      // The suggester saw the real transcript (ascending), and the route did
      // not have to be told the id twice.
      expect(seen[0]?.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);

      // A PROPOSAL: the stored conversation still has no title.
      expect(h.conversations.get(id).summary.title).toBeNull();
      const list = await request(h.app).get('/v1/conversations').set(authed(token));
      expect(list.body.conversations[0].title).toBeNull();

      // The audit row carries counts and a length — never content.
      const rows = h.audit.query({ limit: 20, action: 'conversation.title_suggested' });
      expect(rows).toHaveLength(1);
      const row = rows[0] as { details: string };
      expect(row.details).toContain('"messages":4');
      expect(row.details).toContain('"userTurns":2');
      expect(row.details).toContain('"chars":23');
      expect(row.details).not.toContain('Rotating');
      expect(row.details).not.toContain('question 0');
    } finally {
      h.close();
    }
  });

  it('accepting the proposal is the ordinary PUT (and the AI reply is never stored by this route)', async () => {
    const { suggester } = fakeSuggester({
      ok: true,
      title: 'Rotating the sqlite key',
      model: 'fake-model',
      source: 'model',
    });
    const h = demoHarness({ titleSuggester: suggester });
    try {
      const token = await pairToken(h);
      const id = seed(h, 2);
      const put = await request(h.app)
        .put(`/v1/conversations/${id}`)
        .set(authed(token))
        .send({ title: 'Rotating the sqlite key' });
      expect(put.status).toBe(200);
      expect(put.body.conversation.title).toBe('Rotating the sqlite key');
      expect(h.conversations.get(id).summary.title).toBe('Rotating the sqlite key');
    } finally {
      h.close();
    }
  });

  it('answers 200 with ok:false when the reply was unusable, and audits the code', async () => {
    const { suggester } = fakeSuggester({
      ok: false,
      code: 'unusable_reply',
      message: 'the model returned no usable title',
    });
    const h = demoHarness({ titleSuggester: suggester });
    try {
      const token = await pairToken(h);
      const id = seed(h, 2);
      const res = await request(h.app)
        .post(`/v1/conversations/${id}/title-suggestion`)
        .set(authed(token))
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        ok: false,
        code: 'unusable_reply',
        message: 'the model returned no usable title',
      });
      const rows = h.audit.query({ limit: 20, action: 'conversation.title_suggested' });
      expect((rows[0] as { details: string }).details).toContain('unusable_reply');
    } finally {
      h.close();
    }
  });

  it('derives the title and says so when no model is configured (the default harness wiring)', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      const id = h.conversations.create({}).id;
      h.conversations.append(id, 'user', { content: 'how do I rotate the sqlite key?' });
      h.conversations.append(id, 'assistant', { content: 'Back up first.', model: 'demo', latencyMs: 1 });
      h.conversations.append(id, 'user', { content: 'and the vault passphrase?' });
      h.conversations.append(id, 'assistant', { content: 'Separate step.', model: 'demo', latencyMs: 1 });

      const res = await request(h.app)
        .post(`/v1/conversations/${id}/title-suggestion`)
        .set(authed(token))
        .send({});
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        ok: true,
        title: 'how do I rotate the sqlite key?',
        source: 'transcript',
        userTurns: 2,
        messageCount: 4,
      });
    } finally {
      h.close();
    }
  });
});
