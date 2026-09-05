/**
 * M11 F2 MCP slice-2 tests (PLAN-M11.md).
 *
 * Manager-level tests against a REAL stdio MCP server implemented as a tiny
 * inline Node script (spawned with the current process.execPath). Covers
 * default-deny (created OFF), enable, tools/list, tools/call (success +
 * error + timeout + disabled refusal), missing-command spawn failure, and
 * audit hygiene (ids/names only — never args/results).
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/stores/db.js';
import { createAuditStore, createMcpServerStore } from '../../src/stores/db.js';
import { createMcpManager } from '../../src/mcp/index.js';
import type { McpManager } from '../../src/mcp/index.js';
import { auditLog } from '../../src/services/redaction.js';

const FAKE_SERVER = `
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
let initialized = false;
rl.on('line', (line) => {
  if (line.trim() === '') return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    initialized = true;
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } }) + '\\n');
    return;
  }
  if (msg.method && msg.method.startsWith('notifications/')) return;
  if (msg.method === 'tools/list') {
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'echo', description: 'echo arguments', inputSchema: { type: 'object' } },
      { name: 'explode', description: 'always errors', inputSchema: { type: 'object' } }
    ] } }) + '\\n');
    return;
  }
  if (msg.method === 'tools/call') {
    const name = msg.params && msg.params.name;
    if (name === 'hang') return; // never respond -> timeout test
    if (name === 'explode') {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'boom' }], isError: true } }) + '\\n');
      return;
    }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: 'echoed:' + JSON.stringify(msg.params.arguments || {}) }] } }) + '\\n');
    return;
  }
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'method not found' } }) + '\\n');
});
`;

interface Harness {
  dir: string;
  serverFile: string;
  manager: McpManager;
  db: ReturnType<typeof openDatabase>;
  audit: ReturnType<typeof auditLog>;
}

const harnesses: Harness[] = [];

function makeHarness(): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'partner-mcp-'));
  const serverFile = join(dir, 'fake-server.cjs');
  writeFileSync(serverFile, FAKE_SERVER);
  const db = openDatabase(':memory:');
  const audit = auditLog({ store: createAuditStore(db) });
  const manager = createMcpManager({
    store: createMcpServerStore(db),
    audit,
  });
  const h: Harness = { dir, serverFile, manager, db, audit };
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses.splice(0)) {
    try {
      h.db.close();
    } catch {
      // ignore
    }
    try {
      rmSync(h.dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

const NODE = process.execPath;

describe('M11 F2 MCP manager', () => {
  it('creates servers OFF by default and refuses calls until enabled', async () => {
    const { manager } = makeHarness();
    const created = manager.create({
      name: 'fake',
      command: NODE,
      args: ['fake-server.cjs'],
    });
    expect(created.enabled).toBe(false);
    await expect(manager.listTools(created.id)).rejects.toMatchObject({ code: 'disabled' });
    await expect(manager.call(created.id, { tool: 'echo' })).rejects.toMatchObject({ code: 'disabled' });
  });

  it('lists tools and calls them through a real stdio server', async () => {
    const { manager, serverFile } = makeHarness();
    const created = manager.create({ name: 'fake', command: NODE, args: [serverFile] });
    manager.update(created.id, { enabled: true });

    const tools = await manager.listTools(created.id);
    expect(tools.map((t) => t.name)).toEqual(['echo', 'explode']);

    const result = await manager.call(created.id, { tool: 'echo', args: { hello: 'world' } });
    expect(result.isError).toBe(false);
    expect(result.content[0]?.type).toBe('text');
    expect(String(result.content[0]?.text)).toContain('hello');

    const broken = await manager.call(created.id, { tool: 'explode' });
    expect(broken.isError).toBe(true);
    expect(broken.content[0]?.text).toBe('boom');
  });

  it('times out hung tools and still lets the next call run', async () => {
    const { manager, serverFile } = makeHarness();
    const created = manager.create({ name: 'fake', command: NODE, args: [serverFile] });
    manager.update(created.id, { enabled: true });

    await expect(
      manager.call(created.id, { tool: 'hang', timeoutMs: 1500 }),
    ).rejects.toMatchObject({ code: 'timeout' });

    const ok = await manager.call(created.id, { tool: 'echo', args: { again: true } });
    expect(ok.isError).toBe(false);
  });

  it('surfaces a clear upstream error when the command cannot start', async () => {
    const { manager } = makeHarness();
    const created = manager.create({ name: 'ghost', command: 'definitely-not-a-real-binary-xyz', args: [] });
    manager.update(created.id, { enabled: true });
    await expect(manager.listTools(created.id)).rejects.toMatchObject({ code: 'upstream' });
  });

  it('validates inputs and removes servers with audit rows', () => {
    const { manager, audit } = makeHarness();
    expect(() => manager.create({ name: '', command: 'x' })).toThrow(/name is required/);
    expect(() => manager.create({ name: 'x', command: '  ' })).toThrow(/command is required/);
    expect(() => manager.create({ name: 'x', command: 'c', args: 'nope' as unknown as string[] })).toThrow(/args must be an array/);

    const created = manager.create({ name: 'fake', command: NODE });
    manager.update(created.id, { name: 'renamed' });
    expect(manager.get(created.id)?.name).toBe('renamed');
    manager.remove(created.id);
    expect(manager.get(created.id)).toBeNull();
    expect(() => manager.remove(created.id)).toThrow(/not found/);

    const actions = audit.query({ limit: 20, action: 'mcp.' }).map((r) => r.action);
    expect(actions).toContain('mcp.create');
    expect(actions).toContain('mcp.delete');
  });

  it('audits calls id/tool only — never args or results', async () => {
    const { manager, serverFile, audit } = makeHarness();
    const created = manager.create({ name: 'fake', command: NODE, args: [serverFile] });
    manager.update(created.id, { enabled: true });
    await manager.call(created.id, { tool: 'echo', args: { secret: 'sk-super-secret-value' } });
    const rows = audit.query({ limit: 10, action: 'mcp.call' });
    expect(rows.length).toBe(1);
    expect(rows[0]?.details).not.toContain('sk-super-secret-value');
    expect(rows[0]?.details).toContain('echo');
  });
});
