import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { loadConfig } from '../src/config.js';
import { createCore } from '../src/index.js';
import { ALLOWED_HOST } from './helpers.js';

/**
 * Smoke-test the assembled bundle (config -> stores -> managers -> app) that
 * index.ts exports for tests and later packages.
 */
describe('core index bundle', () => {
  it('createCore wires demo mode into a working app', async () => {
    const config = loadConfig({ DEMO_MODE: '1', DB_PATH: ':memory:', PORT: '4390' });
    const bundle = createCore(config);
    try {
      expect(bundle.config.demo).toBe(true);
      expect(bundle.pairing).toBeDefined();
      expect(bundle.sessions).toBeDefined();
      expect(bundle.audit).toBeDefined();

      const health = await request(bundle.app).get('/v1/health').set('Host', ALLOWED_HOST);
      expect(health.status).toBe(200);
      expect(health.body.demo).toBe(true);

      // demo provider is wired, so an authed chat round streams.
      const codeRes = await request(bundle.app)
        .get('/v1/dev/pair-code')
        .set('Host', ALLOWED_HOST);
      const code = codeRes.body.code as string;
      const pairRes = await request(bundle.app)
        .post('/v1/pair')
        .set('Host', ALLOWED_HOST)
        .send({ code });
      expect(pairRes.status).toBe(200);
      const chat = await request(bundle.app)
        .post('/v1/chat')
        .set('Host', ALLOWED_HOST)
        .set('Authorization', `Bearer ${pairRes.body.token as string}`)
        .send({ messages: [{ role: 'user', content: 'round trip' }] });
      expect(chat.status).toBe(200);
      expect(chat.text).toContain('"type":"done"');
    } finally {
      bundle.close();
    }
  });
});
