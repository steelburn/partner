/**
 * M11 + M13 multimodal route integration (PLAN-M11.md F1/C2, PLAN-M13.md F1).
 *
 * A bound image attachment rides the newest user turn as an inline image
 * part. M13 adds the vision handoff: when routing was IMPLICIT (no
 * model/taskClass/providerId pin from the client) and landed on a model that
 * cannot see, the turn is rerouted to the best vision-capable model so the
 * photo is actually analyzed instead of degrading to a text stub. An
 * EXPLICIT pick is the user's confirmed choice and is never overridden; when
 * nothing enabled can see images the turn stays on the text model (plain
 * content + descriptor context).
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { demoHarness, ALLOWED_HOST } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { sseReply } from '../support/server.js';

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

interface Capture {
  base: string;
  bodies: Array<{ model?: string; messages?: unknown[] }>;
}

function startCapture(models: string[]): Promise<Capture> {
  return new Promise((resolve, reject) => {
    const bodies: Capture['bodies'] = [];
    const server = http.createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (path === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
        return;
      }
      if (path === '/chat/completions') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
            model?: string;
            messages?: unknown[];
          };
          bodies.push(parsed);
          res.writeHead(200, { 'Content-Type': 'text/event-stream' });
          res.end(sseReply(['seen'], { prompt: 3, completion: 3 }));
        });
        return;
      }
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'nf' }));
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      servers.push({
        close: async () => {
          server.closeAllConnections?.();
          await new Promise<void>((done) => server.close(() => done()));
        },
      });
      resolve({ base: `http://127.0.0.1:${port}`, bodies });
    });
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

async function register(h: Harness, base: string, models: string[]): Promise<string> {
  const created = await h.providerManager.create({
    name: 'upstream',
    endpoint: base,
    defaultModels: models,
  });
  await h.providerManager.setKey(created.id, 'sk-fake-key-1234567890');
  return created.id;
}

function newestUser(capture: Capture): unknown {
  const body = capture.bodies[0] as { messages?: Array<{ role?: string; content?: unknown }> } | undefined;
  const user = [...(body?.messages ?? [])].reverse().find((m) => m.role === 'user');
  return user?.content;
}

describe('M11 multimodal image parts + M13 vision handoff (route)', () => {
  it('inlines a bound image for an image-capable persona model', async () => {
    const vision = await startCapture(['gpt-4o']);
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const providerId = await register(h, vision.base, ['gpt-4o']);
      const persona = h.personas.create({
        name: 'Visionary',
        character: { voice: 'v', language: 'en', systemPrompt: '', temperature: 0.5 },
        model: {
          providerId,
          taskClasses: { chat: 'vision-gpt-4o-x' },
        },
        independence: { level: 'auto', requireHumanFor: ['high'], autoScopes: [] },
        memory: { userProfile: 'none', episodes: 'none' },
      });
      const conv = h.conversations.create({ title: 'vision' });
      const attachment = h.attachments?.upload(conv.id, {
        name: 'pixel.png',
        mime: 'image/png',
        dataBase64: PNG_1PX,
      });
      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({
          conversationId: conv.id,
          personaId: persona.id,
          attachmentIds: [attachment?.id ?? ''],
          messages: [{ role: 'user', content: 'what is in this image?' }],
        });
      expect(chat.status).toBe(200);
      expect(JSON.stringify(newestUser(vision))).toContain('data:image/png;base64,');
    } finally {
      h.close();
    }
  });

  it('hands an implicit image turn to the vision provider when the persona chat model is text-only', async () => {
    const text = await startCapture(['llama-3.1-8b']);
    const vision = await startCapture(['gpt-4o']);
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      // General (text) provider + separate vision provider; persona routes
      // chat to the text model and pins nothing.
      await register(h, text.base, ['llama-3.1-8b']);
      await register(h, vision.base, ['gpt-4o']);
      const persona = h.personas.create({
        name: 'Visionary',
        character: { voice: 'v', language: 'en', systemPrompt: '', temperature: 0.5 },
        model: { taskClasses: { chat: 'llama-3.1-8b' } },
        independence: { level: 'auto', requireHumanFor: ['high'], autoScopes: [] },
        memory: { userProfile: 'none', episodes: 'none' },
      });
      const conv = h.conversations.create({ title: 'vision' });
      const attachment = h.attachments?.upload(conv.id, {
        name: 'pixel.png',
        mime: 'image/png',
        dataBase64: PNG_1PX,
      });
      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({
          conversationId: conv.id,
          personaId: persona.id,
          attachmentIds: [attachment?.id ?? ''],
          messages: [{ role: 'user', content: 'what is in this image?' }],
        });
      expect(chat.status).toBe(200);
      // The text provider never saw the turn — the vision provider did.
      expect(text.bodies).toHaveLength(0);
      expect(vision.bodies).toHaveLength(1);
      expect(vision.bodies[0]?.model).toBe('gpt-4o');
      expect(JSON.stringify(newestUser(vision))).toContain('data:image/png;base64,');
    } finally {
      h.close();
    }
  });

  it('keeps plain text when the client EXPLICITLY pins a text model (confirmed per-turn pick)', async () => {
    const text = await startCapture(['llama-3.1-8b']);
    const vision = await startCapture(['gpt-4o']);
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const textId = await register(h, text.base, ['llama-3.1-8b']);
      const visionId = await register(h, vision.base, ['gpt-4o']);
      const persona = h.personas.create({
        name: 'Visionary',
        character: { voice: 'v', language: 'en', systemPrompt: '', temperature: 0.5 },
        model: { taskClasses: { chat: 'llama-3.1-8b' } },
        independence: { level: 'auto', requireHumanFor: ['high'], autoScopes: [] },
        memory: { userProfile: 'none', episodes: 'none' },
      });
      const conv = h.conversations.create({ title: 'vision' });
      const attachment = h.attachments?.upload(conv.id, {
        name: 'pixel.png',
        mime: 'image/png',
        dataBase64: PNG_1PX,
      });
      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({
          conversationId: conv.id,
          personaId: persona.id,
          providerId: textId,
          model: 'llama-3.1-8b',
          attachmentIds: [attachment?.id ?? ''],
          messages: [{ role: 'user', content: 'describe it as text' }],
        });
      expect(chat.status).toBe(200);
      expect(text.bodies).toHaveLength(1);
      expect(text.bodies[0]?.model).toBe('llama-3.1-8b');
      expect(vision.bodies).toHaveLength(0);
      expect(typeof newestUser(text)).toBe('string');
      expect(String(newestUser(text))).not.toContain('data:image/png');
    } finally {
      h.close();
    }
  });

  it('stays on the text model when no enabled provider can see images', async () => {
    const text = await startCapture(['llama-3.1-8b']);
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      await register(h, text.base, ['llama-3.1-8b']);
      const persona = h.personas.create({
        name: 'Visionary',
        character: { voice: 'v', language: 'en', systemPrompt: '', temperature: 0.5 },
        model: { taskClasses: { chat: 'llama-3.1-8b' } },
        independence: { level: 'auto', requireHumanFor: ['high'], autoScopes: [] },
        memory: { userProfile: 'none', episodes: 'none' },
      });
      const conv = h.conversations.create({ title: 'vision' });
      const attachment = h.attachments?.upload(conv.id, {
        name: 'pixel.png',
        mime: 'image/png',
        dataBase64: PNG_1PX,
      });
      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({
          conversationId: conv.id,
          personaId: persona.id,
          attachmentIds: [attachment?.id ?? ''],
          messages: [{ role: 'user', content: 'what is in this image?' }],
        });
      expect(chat.status).toBe(200);
      expect(text.bodies).toHaveLength(1);
      expect(typeof newestUser(text)).toBe('string');
      expect(String(newestUser(text))).not.toContain('data:image/png');
      // The descriptor context still tells the text model an image is there.
      expect(String(newestUser(text))).toContain('Image attachment');
    } finally {
      h.close();
    }
  });
});
