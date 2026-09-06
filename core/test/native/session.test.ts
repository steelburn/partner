/**
 * M7 native-messaging SESSION tests (PLAN-M7.md), in-process over a demo
 * harness: a full pair sequence (unpaired gate -> pair.code -> wrong pair ->
 * pair ok), scope.get resolution, denied_scope for ask + blocked origins,
 * read+act granted over the HTTP surface then capture ok + analyze demo
 * (deterministic text incl. the selection echo), persona_paused, unknown
 * commands, bad-frame recovery, and audit rows that never carry page text.
 *
 * The session harness is an in-memory duplex: prebuilt inbound frames ->
 * collected outbound frames, over the REAL managers/db the HTTP app shares.
 */
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import request from 'supertest';
import type { NmEnvelope } from '@partner/shared';
import { SCHEMA_VERSION } from '@partner/shared';
import { CORE_VERSION } from '../../src/config.js';
import { createNativeSession } from '../../src/native/index.js';
import type { NativeSessionDeps, NativeSessionResult } from '../../src/native/index.js';
import { demoHarness, ALLOWED_HOST } from '../helpers.js';
import type { Harness } from '../helpers.js';

function frameEnvelope(envelope: NmEnvelope): Buffer {
  const body = Buffer.from(JSON.stringify(envelope), 'utf8');
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32LE(body.length, 0);
  body.copy(out, 4);
  return out;
}

function requestFrame(id: string, command: string, payload?: unknown): Buffer {
  return frameEnvelope({
    type: 'request',
    id,
    command,
    ...(payload !== undefined ? { payload } : {}),
  });
}

function decodeFrames(raw: Buffer): NmEnvelope[] {
  const out: NmEnvelope[] = [];
  let offset = 0;
  while (offset + 4 <= raw.length) {
    const length = raw.readUInt32LE(offset);
    offset += 4;
    if (offset + length > raw.length) break;
    out.push(JSON.parse(raw.subarray(offset, offset + length).toString('utf8')) as NmEnvelope);
    offset += length;
  }
  return out;
}

function runSession(
  h: Harness,
  frames: Buffer[],
  chunkSize?: number,
  options: { themes?: import('../../src/theming/manager.js').ThemeManager } = {},
): Promise<{ result: NativeSessionResult; responses: NmEnvelope[] }> {
  const deps: NativeSessionDeps = {
    version: CORE_VERSION,
    demo: true,
    schemaVersion: SCHEMA_VERSION,
    pairing: h.pairing,
    scopes: h.scopes as NonNullable<Harness['scopes']>,
    personas: h.personas,
    providers: h.providerManager,
    audit: h.audit,
    ...(options.themes !== undefined ? { themes: options.themes } : {}),
  };
  const stdout = new PassThrough();
  const chunks: Buffer[] = [];
  stdout.on('data', (c: Buffer) => chunks.push(c));
  async function* stdin(): AsyncGenerator<Buffer> {
    for (const f of frames) {
      if (chunkSize === undefined || chunkSize <= 0) {
        yield f;
      } else {
        for (let i = 0; i < f.length; i += chunkSize) {
          yield f.subarray(i, i + chunkSize);
        }
      }
    }
  }
  return createNativeSession(deps, { stdin: stdin(), stdout }).then(async (result) => {
    await new Promise<void>((resolve) => stdout.end(resolve));
    return { result, responses: decodeFrames(Buffer.concat(chunks)) };
  });
}

async function pairToken(h: Harness): Promise<string> {
  const code = await h.pairing.issue();
  const pairRes = await request(h.app).post('/v1/pair').set('Host', ALLOWED_HOST).send({ code });
  expect(pairRes.status).toBe(200);
  return pairRes.body.token as string;
}

function authed(token: string): Record<string, string> {
  return { Host: ALLOWED_HOST, Authorization: `Bearer ${token}` };
}

describe('M7 native session — pairing gate + policy', () => {
  it('gates every command except hello/pair.code/pair until a pair succeeds', async () => {
    const h = demoHarness();
    try {
      const { responses } = await runSession(h, [
        requestFrame('1', 'hello'),
        requestFrame('2', 'page.capture', {
          url: 'https://news.example/a',
          title: 'T',
          origin: 'news.example',
          text: 'secret text',
        }),
        requestFrame('3', 'scope.get', { origin: 'news.example' }),
        requestFrame('4', 'pair.code'),
      ]);

      expect(responses).toHaveLength(4);
      expect(responses[0]).toMatchObject({ id: '1', ok: true });
      expect(responses[0]?.payload).toEqual({
        version: CORE_VERSION,
        demo: true,
        schemaVersion: SCHEMA_VERSION,
      });
      // Unpaired commands are refused with not_paired (nothing executed).
      expect(responses[1]).toMatchObject({ id: '2', ok: false, error: 'not_paired' });
      expect(responses[2]).toMatchObject({ id: '3', ok: false, error: 'not_paired' });
      expect(responses[3]).toMatchObject({ id: '4', ok: true });
      const code = (responses[3]?.payload as { code: string }).code;
      expect(code).toMatch(/^\d{6}$/);
    } finally {
      h.close();
    }
  });

  it('pairs with the code (wrong codes refused), then resolves scopes and denials', async () => {
    const h = demoHarness();
    try {
      const codeRes = await runSession(h, [requestFrame('c', 'pair.code')]);
      const code = (codeRes.responses[0]?.payload as { code: string }).code;
      const guess = code === '000001' ? '000002' : '000001';

      const { responses } = await runSession(h, [
        requestFrame('w', 'pair', { code: guess }),
        requestFrame('g', 'pair', { code }),
        requestFrame('s1', 'scope.get', { origin: 'https://news.example/article?x=1' }),
        requestFrame('c1', 'page.capture', {
          url: 'https://news.example/a',
          title: 'T',
          origin: 'news.example',
          text: 'some page text',
        }),
        requestFrame('c2', 'page.capture', {
          url: 'https://www.wellsfargo.com/login',
          title: 'T',
          origin: 'www.wellsfargo.com',
          text: 'account numbers',
        }),
        requestFrame('s2', 'scope.get', { origin: 'https://www.wellsfargo.com/x' }),
        requestFrame('x', 'frobnicate', {}),
      ]);

      // Wrong code -> not_paired; right code -> paired.
      expect(responses[0]).toMatchObject({ id: 'w', ok: false, error: 'not_paired' });
      expect(responses[0]?.payload).toMatchObject({ reason: 'invalid' });
      expect(responses[1]).toMatchObject({ id: 'g', ok: true, payload: { paired: true } });

      // scope.get resolves the DEFAULT ask policy (blocklist first).
      expect(responses[2]).toMatchObject({ id: 's1', ok: true });
      expect(responses[2]?.payload).toEqual({
        origin: 'news.example',
        scope: 'ask',
        blocked: false,
        reason: null,
      });

      // ask -> denied_scope carrying the policy + required scope.
      expect(responses[3]).toMatchObject({ id: 'c1', ok: false, error: 'denied_scope' });
      expect((responses[3]?.payload as { policy: { scope: string } }).policy.scope).toBe('ask');
      expect((responses[3]?.payload as { required: string }).required).toBe('read+act');

      // Hard-blocked origin -> denied_scope with the blocked policy.
      expect(responses[4]).toMatchObject({ id: 'c2', ok: false, error: 'denied_scope' });
      expect(responses[4]?.payload).toMatchObject({
        policy: { origin: 'www.wellsfargo.com', scope: 'off', blocked: true, reason: 'blocked_origin' },
      });

      expect(responses[5]?.payload).toMatchObject({
        origin: 'www.wellsfargo.com',
        blocked: true,
        reason: 'blocked_origin',
      });

      // Unknown command -> unknown_command, channel stays alive.
      expect(responses[6]).toMatchObject({ id: 'x', ok: false, error: 'unknown_command' });
    } finally {
      h.close();
    }
  });
});

describe('M7 native session — capture + analyze happy path', () => {
  it('captures + analyzes in demo mode with deterministic reply text', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      await request(h.app)
        .put('/v1/browser/scopes/news.example')
        .set(authed(token))
        .send({ scope: 'read+act' });

      const text = 'The quick brown fox.';
      const selection = 'Selected text';
      const run = await runSession(h, [
        requestFrame('p', 'pair.code'),
        requestFrame('q', 'pair', { code: '000000' }), // wrong (no active pairing yet) -> not_paired
      ]);
      expect(run.responses[0]).toMatchObject({ ok: true });
      const code = (run.responses[0]?.payload as { code: string }).code;
      void code;

      // One full session: pair -> capture ok -> analyze demo (with and
      // without a selection) -> persona_paused -> unknown.
      const second = await runSession(h, [requestFrame('p', 'pair.code')]);
      const realCode = (second.responses[0]?.payload as { code: string }).code;

      const session = await runSession(h, [
        requestFrame('1', 'pair', { code: realCode }),
        requestFrame('2', 'page.capture', {
          url: 'https://news.example/a',
          title: 'Article',
          origin: 'https://news.example',
          text,
          selection,
        }),
        requestFrame('3', 'page.analyze', {
          url: 'https://news.example/a',
          title: 'Article',
          origin: 'news.example',
          text,
          selection,
        }),
        requestFrame('4', 'page.analyze', {
          url: 'https://news.example/b',
          title: 'Article',
          origin: 'news.example',
          text,
        }),
        requestFrame('5', 'page.analyze', {
          url: 'https://news.example/c',
          title: 'Article',
          origin: 'news.example',
          personaId: 'p-researcher',
          text: 'zz',
          selection: 's'.repeat(200),
        }),
        requestFrame('6', 'page.capture', {
          url: 'https://accounts.google.com/signin',
          title: 'A',
          origin: 'accounts.google.com',
          text: 'auditmustneverseeme',
        }),
      ]);
      const r = session.responses;

      expect(r[0]).toMatchObject({ id: '1', ok: true, payload: { paired: true } });
      expect(r[1]).toMatchObject({ id: '2', ok: true });
      expect(r[1]?.payload).toEqual({ captured: true, chars: text.length, selectionChars: selection.length });

      // analyze (selection) -> deterministic preview text incl. the echo.
      expect(r[2]).toMatchObject({ id: '3', ok: true });
      const replyWithSelection = (r[2]?.payload as { reply: string }).reply;
      expect(replyWithSelection).toBe(
        `Partner preview (demo): page has ${text.length} chars, selection has ${selection.length} chars. ${selection}`,
      );
      expect(r[2]?.payload).toMatchObject({ personaId: 'p-default', mode: 'demo' });

      // analyze (no selection) -> no echo, selection count 0.
      expect(r[3]).toMatchObject({ id: '4', ok: true });
      const replyPlain = (r[3]?.payload as { reply: string }).reply;
      expect(replyPlain).toBe(
        `Partner preview (demo): page has ${text.length} chars, selection has 0 chars.`,
      );

      // Long selection is echoed only to the 120-char preview cap.
      const replyLong = (r[4]?.payload as { reply: string }).reply;
      expect(replyLong).toBe(
        `Partner preview (demo): page has 2 chars, selection has 200 chars. ${'s'.repeat(120)}`,
      );
      expect(r[4]?.payload).toMatchObject({ personaId: 'p-researcher' });

      // A hard-blocked origin is denied even with read+act stored elsewhere.
      expect(r[5]).toMatchObject({ id: '6', ok: false, error: 'denied_scope' });
      expect(r[5]?.payload).toMatchObject({
        policy: { origin: 'accounts.google.com', blocked: true, reason: 'blocked_origin' },
      });
    } finally {
      h.close();
    }
  });

  it('refuses analyze for a paused persona with persona_paused', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      await request(h.app)
        .put('/v1/browser/scopes/news.example')
        .set(authed(token))
        .send({ scope: 'trusted' });
      h.personas.pause('p-default');

      const codeRun = await runSession(h, [requestFrame('pc', 'pair.code')]);
      const code = (codeRun.responses[0]?.payload as { code: string }).code;
      const { responses } = await runSession(h, [
        requestFrame('1', 'pair', { code }),
        requestFrame('2', 'page.analyze', {
          url: 'https://news.example/x',
          title: 'T',
          origin: 'news.example',
          text: 'content while paused',
        }),
      ]);
      expect(responses[0]).toMatchObject({ ok: true });
      expect(responses[1]).toMatchObject({ id: '2', ok: false, error: 'persona_paused' });
      expect(responses[1]?.payload).toEqual({ personaId: 'p-default' });
    } finally {
      h.close();
    }
  });

  it('recovers after a bad frame and never logs page text', async () => {
    const h = demoHarness();
    try {
      const garbage = Buffer.alloc(4 + 5); // length 5, body "hello" (invalid JSON)
      garbage.writeUInt32LE(5, 0);
      garbage.write('hello', 4, 'utf8');

      const { result, responses } = await runSession(h, [
        requestFrame('1', 'hello'),
        garbage,
        requestFrame('3', 'hello'),
      ]);
      expect(result.frames).toBe(3);
      expect(result.responded).toBe(3);
      expect(responses).toHaveLength(3);
      expect(responses[0]).toMatchObject({ id: '1', ok: true });
      expect(responses[1]).toMatchObject({ ok: false, error: 'bad_frame' });
      expect(responses[1]?.id).toBe('');
      // The channel is aligned again: the next request is answered.
      expect(responses[2]).toMatchObject({ id: '3', ok: true });
    } finally {
      h.close();
    }
  });

  it('keeps page text out of audit rows (origins + counts only)', async () => {
    const h = demoHarness();
    try {
      const token = await pairToken(h);
      await request(h.app)
        .put('/v1/browser/scopes/news.example')
        .set(authed(token))
        .send({ scope: 'read+act' });
      const codeRun = await runSession(h, [requestFrame('pc', 'pair.code')]);
      const code = (codeRun.responses[0]?.payload as { code: string }).code;
      await runSession(h, [
        requestFrame('1', 'pair', { code }),
        requestFrame('2', 'page.capture', {
          url: 'https://news.example/x',
          title: 'Article',
          origin: 'news.example',
          text: 'the-super-secret-bank-transfer-number-42',
          selection: 'even-more-secret-selection',
        }),
        requestFrame('3', 'page.analyze', {
          url: 'https://news.example/x',
          title: 'Article',
          origin: 'news.example',
          text: 'the-super-secret-bank-transfer-number-42',
        }),
      ]);

      const rows = h.auditStore.list(50).filter((row) => row.action.startsWith('browser.'));
      expect(rows.length).toBeGreaterThanOrEqual(2);
      for (const row of rows) {
        const details = JSON.stringify(row.details);
        expect(details).not.toContain('secret');
        expect(details).not.toContain('42');
      }
      expect(rows.some((row) => row.action === 'browser.capture' && row.target === 'news.example')).toBe(true);
      expect(rows.some((row) => row.action === 'browser.analyze' && row.target === 'news.example')).toBe(true);
    } finally {
      h.close();
    }
  });
});

describe('theme.active (M11 extension theme stream)', () => {
  it('returns the resolved active theme after pairing when themes are wired', async () => {
    const h = demoHarness();
    try {
      const codeRes = await runSession(h, [requestFrame('c', 'pair.code')]);
      const code = (codeRes.responses[0]?.payload as { code: string }).code;
      // Pair + theme in ONE session: the pairing code is single-use.
      const themeRes = await runSession(h, [requestFrame('p', 'pair', { code }), requestFrame('t', 'theme.active')], undefined, {
        themes: h.themes ?? undefined,
      });
      expect(themeRes.responses[0]).toMatchObject({ id: 'p', ok: true, payload: { paired: true } });
      const reply = themeRes.responses[1];
      expect(reply).toMatchObject({ id: 't', ok: true });
      const payload = reply?.payload as { themeId: string; source: string; light: unknown; dark: unknown };
      expect(typeof payload.themeId).toBe('string');
      expect(payload.light).toBeTruthy();
      expect(payload.dark).toBeTruthy();
    } finally {
      h.close();
    }
  });

  it('answers unknown_command when themes are not wired', async () => {
    const h = demoHarness();
    try {
      const codeRes = await runSession(h, [requestFrame('c', 'pair.code')]);
      const code = (codeRes.responses[0]?.payload as { code: string }).code;
      const { responses } = await runSession(h, [requestFrame('p', 'pair', { code }), requestFrame('t', 'theme.active')]);
      expect(responses[1]).toMatchObject({ id: 't', ok: false, error: 'unknown_command' });
    } finally {
      h.close();
    }
  });
});
