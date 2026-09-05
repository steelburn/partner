/**
 * M11 multimodal route integration (PLAN-M11.md F1/C2).
 *
 * A bound image attachment rides the newest user turn as an inline image
 * part ONLY when the resolved model is image-capable (managed path). Text-
 * model turns keep the plain content (plus the descriptor context).
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

function startCapture(): Promise<{ server: http.Server; base: string; bodies: Array<{ messages?: unknown[] }> }> {
  return new Promise((resolve, reject) => {
    const bodies: Array<{ messages?: unknown[] }> = [];
    const server = http.createServer((req, res) => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (path === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ data: [{ id: 'gpt-4o' }] }));
        return;
      }
      if (path === '/chat/completions') {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          bodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: unknown[] });
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
      resolve({ server, base: `http://127.0.0.1:${port}`, bodies });
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

async function setup(h: Harness, token: string, capture: { base: string }): Promise<{ personaId: string; convId: string; attachmentId: string }> {
  const provider = await h.providerManager.create({
    name: 'vision-upstream',
    endpoint: capture.base,
    defaultModels: ['gpt-4o'],
  });
  await h.providerManager.setKey(provider.id, 'sk-fake-vision-key-12345678');
  const persona = h.personas.create({
    name: 'Visionary',
    character: { voice: 'v', language: 'en', systemPrompt: '', temperature: 0.5 },
    model: { taskClasses: {}, providerId: provider.id },
    independence: { level: 'auto', requireHumanFor: ['high'], autoScopes: [] },
    memory: { userProfile: 'none', episodes: 'none' },
  });
  const conv = h.conversations.create({ title: 'vision' });
  const attachment = h.attachments?.upload(conv.id, {
    name: 'pixel.png',
    mime: 'image/png',
    dataBase64: PNG_1PX,
  });
  if (!attachment) throw new Error('attachments manager missing');
  return { personaId: persona.id, convId: conv.id, attachmentId: attachment.id };
}

describe('M11 multimodal image parts (route)', () => {
  it('inlines a bound image for an image-capable model', async () => {
    const capture = await startCapture();
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const s = await setup(h, token, capture);
      // Point the persona's chat task class at a vision-capable model id.
      const persona = h.personas.get(s.personaId) as NonNullable<ReturnType<Harness['personas']['get']>>;
      h.personas.update(s.personaId, {
        name: persona.name,
        character: persona.character,
        model: { ...persona.model, taskClasses: { ...persona.model.taskClasses, chat: 'vision-gpt-4o-x' } },
        independence: persona.independence,
        memory: persona.memory,
        isDefault: persona.isDefault,
      });
      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({
          conversationId: s.convId,
          personaId: s.personaId,
          attachmentIds: [s.attachmentId],
          messages: [{ role: 'user', content: 'what is in this image?' }],
        });
      expect(chat.status).toBe(200);
      const body = capture.bodies[0] as { messages?: Array<{ role?: string; content?: unknown }> };
      const user = [...(body?.messages ?? [])].reverse().find((m) => m.role === 'user');
      const content = user?.content as unknown;
      expect(Array.isArray(content)).toBe(true);
      expect(JSON.stringify(content)).toContain('data:image/png;base64,');
    } finally {
      h.close();
    }
  });

  it('keeps plain text for a model that is not image-capable', async () => {
    const capture = await startCapture();
    const h = demoHarness({ demo: false });
    try {
      const token = await pairToken(h);
      const s = await setup(h, token, capture);
      const persona = h.personas.get(s.personaId) as NonNullable<ReturnType<Harness['personas']['get']>>;
      h.personas.update(s.personaId, {
        name: persona.name,
        character: persona.character,
        model: { ...persona.model, taskClasses: { ...persona.model.taskClasses, chat: 'plain-model-x' } },
        independence: persona.independence,
        memory: persona.memory,
        isDefault: persona.isDefault,
      });
      const chat = await request(h.app)
        .post('/v1/chat')
        .set(authed(token))
        .send({
          conversationId: s.convId,
          personaId: s.personaId,
          attachmentIds: [s.attachmentId],
          messages: [{ role: 'user', content: 'what is in this image?' }],
        });
      expect(chat.status).toBe(200);
      const body = capture.bodies[0] as { messages?: Array<{ role?: string; content?: unknown }> };
      const user = [...(body?.messages ?? [])].reverse().find((m) => m.role === 'user');
      expect(typeof user?.content).toBe('string');
      expect(String(user?.content)).not.toContain('data:image/png');
    } finally {
      h.close();
    }
  });
});
