/**
 * M11 F2 search manager tests (PLAN-M11.md).
 *
 * Fake Tavily/Brave upstreams over loopback http exercise the real fetch
 * path; default-deny (disabled / no key) refuses before any network call.
 * Audit carries query LENGTH + hit count only — never the query/results.
 */
import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { openDatabase } from '../../src/stores/db.js';
import { createAuditStore, createSettingsStore } from '../../src/stores/db.js';
import { createSearchManager } from '../../src/search/index.js';
import type { SearchManager } from '../../src/search/index.js';
import { createKeychainFake } from '../../src/keychain/keychain.js';
import { auditLog } from '../../src/services/redaction.js';

const servers: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

function startFakeUpstream(handler: (body: string, headers: http.IncomingHttpHeaders) => string | null): Promise<{ base: string }> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => {
        raw += c.toString('utf8');
      });
      req.on('end', () => {
        const reply = handler(raw, req.headers);
        if (reply === null) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end('{"error":"nope"}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(reply);
      });
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
      resolve({ base: `http://127.0.0.1:${port}` });
    });
  });
}

function makeSearch(): { db: ReturnType<typeof openDatabase>; manager: SearchManager; audit: ReturnType<typeof auditLog> } {
  const db = openDatabase(':memory:');
  const audit = auditLog({ store: createAuditStore(db) });
  const manager = createSearchManager({
    settings: createSettingsStore(db),
    keychain: createKeychainFake(),
    audit,
  });
  return { db, manager, audit };
}

async function enableFake(search: SearchManager, endpoint: string): Promise<void> {
  search.updateConfig({ enabled: true, provider: 'tavily', endpoint });
  await search.setKey('sk-fake-search-key-1234567890');
}

describe('M11 F2 search manager', () => {
  it('refuses before any network call when disabled or keyless', async () => {
    const { manager } = makeSearch();
    await expect(manager.search('hello')).rejects.toMatchObject({ code: 'disabled' });
    manager.updateConfig({ enabled: true });
    await expect(manager.search('hello')).rejects.toMatchObject({ code: 'disabled' });
    expect(() => manager.updateConfig({ provider: 'openai' as 'tavily' })).toThrow(/tavily or brave/);
  });

  it('queries the tavily-style backend end-to-end with a fake upstream', async () => {
    const fake = await startFakeUpstream((body) => {
      const parsed = JSON.parse(body) as { query?: string; api_key?: string };
      expect(parsed.api_key).toBe('sk-fake-search-key-1234567890');
      return JSON.stringify({
        results: [{ title: parsed.query ?? '', url: 'https://example.com/a', content: 'a snippet' }],
      });
    });
    const { manager } = makeSearch();
    await enableFake(manager, `${fake.base}/search`);
    const result = await manager.search('pizza');
    expect(result.provider).toBe('tavily');
    expect(result.hits[0]).toMatchObject({ title: 'pizza', url: 'https://example.com/a', snippet: 'a snippet' });
  });

  it('parses the brave-style backend response', async () => {
    const fake = await startFakeUpstream((_body, headers) => {
      expect(headers['x-subscription-token']).toBe('sk-brave-key-abcdef');
      return JSON.stringify({ web: { results: [{ title: 'T', url: 'https://b.example', description: 'D' }] } });
    });
    const { manager } = makeSearch();
    manager.updateConfig({ enabled: true, provider: 'brave', endpoint: `${fake.base}/res` });
    await manager.setKey('sk-brave-key-abcdef');
    const result = await manager.search('query here');
    expect(result.provider).toBe('brave');
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]?.url).toBe('https://b.example');
  });

  it('rejects non-loopback http endpoints and cleans the key from audit', async () => {
    const { manager, audit } = makeSearch();
    expect(() => manager.updateConfig({ endpoint: 'http://not-local.example/search' })).toThrow(
      /loopback/,
    );
    await manager.setKey('sk-ultra-secret-999999999');
    manager.updateConfig({ enabled: true });
    // No query ran (disabled upstream default would 502) — check setkey audit
    // only carries the LENGTH, never the key.
    const rows = audit.query({ limit: 10, action: 'search.setkey' });
    expect(rows.length).toBe(1);
    expect(rows[0]?.details).not.toContain('sk-ultra-secret');
  });
});
