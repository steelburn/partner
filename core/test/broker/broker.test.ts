/**
 * Broker resolution tests (M2, PLAN-M2 "Tests red -> green"): deny by
 * default; low/medium/high all surface needs_approval without a grant;
 * approve(remember) persists the grant and a re-exec executes; an explicit
 * user grant executes directly; bad params / unknown tool / unknown project
 * are typed denials; read-only roots refuse writers; audit rows never carry
 * file content or secret material.
 */
import { mkdirSync, realpathSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ToolExecResponse } from '@partner/shared/tools.js';
import { openDatabase } from '../../src/stores/db.js';
import {
  createAuditStore,
  createFileProposalStore,
  createGrantStore,
  createPendingToolStore,
  createProjectRootStore,
} from '../../src/stores/db.js';
import { auditLog } from '../../src/services/redaction.js';
import { createToolBroker } from '../../src/broker/broker.js';
import { createGrantManager } from '../../src/broker/grants.js';
import { createPendingManager } from '../../src/broker/pending.js';
import { createProjectRootManager } from '../../src/broker/roots.js';
import { createFileTools } from '../../src/files/tools.js';
import { createProposalManager } from '../../src/files/proposals.js';
import type { ProjectRoot } from '@partner/shared/tools.js';
import { makeTempRoot, removeTempRoot } from '../helpers.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) removeTempRoot(dir);
});

interface BrokerHarness {
  broker: ReturnType<typeof createToolBroker>;
  db: ReturnType<typeof openDatabase>;
  root: ProjectRoot;
  rootPath: string;
  /** all audit rows (newest first) */
  auditRows: () => Array<{ action: string; target: string; details: string }>;
  write(rel: string, content: string): void;
}

function setup(readOnly = false): BrokerHarness {
  const db = openDatabase(':memory:');
  const audit = auditLog({ store: createAuditStore(db) });
  const rootStore = createProjectRootStore(db);
  const grantStore = createGrantStore(db);
  const pendingStore = createPendingToolStore(db);
  const proposalStore = createFileProposalStore(db);

  const roots = createProjectRootManager({ store: rootStore });
  const grants = createGrantManager({ store: grantStore });
  const pending = createPendingManager({
    store: pendingStore,
    onCreateGrant: (row, note) => grants.add(row.toolId, row.projectId ?? '', note === undefined ? {} : { note }).id,
  });
  const broker = createToolBroker({
    roots,
    grants,
    pending,
    proposals: createProposalManager({ store: proposalStore }),
    tools: createFileTools({ proposals: proposalStore }),
    audit,
  });

  const rootPath = realpathSync(makeTempRoot());
  dirs.push(rootPath);
  const root = roots.add({ label: 'code', path: rootPath, readOnly });

  return {
    broker,
    db,
    root,
    rootPath,
    auditRows: () =>
      (audit.list(1000) as unknown as Array<{ action: string; target: string; details: string }>).reverse(),
    write(rel: string, content: string): void {
      const path = join(rootPath, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    },
  };
}

function execResult(h: BrokerHarness, tool: string, params: unknown): ToolExecResponse {
  return h.broker.exec(tool, params, { requestedBy: 'web' });
}

function outcomeOf(res: ToolExecResponse): string {
  return res.outcome;
}

describe('deny by default', () => {
  it('unknown tool -> denied unknown_tool', () => {
    const h = setup();
    const res = execResult(h, 'files.rm', { projectId: h.root.id, path: '.' });
    expect(outcomeOf(res)).toBe('denied');
    if (res.outcome === 'denied') expect(res.reason).toBe('unknown_tool');
  });

  it('missing/empty params -> denied bad_params (projectId required, path rules)', () => {
    const h = setup();
    const noPath = execResult(h, 'files.list', { projectId: h.root.id });
    expect(outcomeOf(noPath)).toBe('denied');
    if (noPath.outcome === 'denied') expect(noPath.reason).toBe('bad_params');

    const noProject = execResult(h, 'files.list', { path: '.' });
    expect(noProject.outcome).toBe('denied');
    if (noProject.outcome === 'denied') expect(noProject.reason).toBe('bad_params');

    const garbage = execResult(h, 'files.list', 'nope');
    expect(garbage.outcome).toBe('denied');
    if (garbage.outcome === 'denied') expect(garbage.reason).toBe('bad_params');
  });

  it('unknown project root -> denied unknown_project', () => {
    const h = setup();
    const res = execResult(h, 'files.list', { projectId: 'no-such-root', path: '.' });
    expect(res.outcome).toBe('denied');
    if (res.outcome === 'denied') expect(res.reason).toBe('unknown_project');
  });
});

describe('grant resolution', () => {
  it('LOW tool without a grant -> needs_approval, enqueued, nothing executes', () => {
    const h = setup();
    h.write('a.txt', 'hello');
    const res = execResult(h, 'files.list', { projectId: h.root.id, path: '.' });
    expect(outcomeOf(res)).toBe('needs_approval');
    if (res.outcome === 'needs_approval') {
      expect(h.broker.pending.list().map((p) => p.id)).toContain(res.pendingId);
    }
    // No grant exists -> still denied by default.
    expect(h.broker.grants.hasGrant('files.list', h.root.id)).toBe(false);
  });

  it('approve(remember) creates the grant; re-exec executes', () => {
    const h = setup();
    h.write('a.txt', 'hello');
    const first = execResult(h, 'files.list', { projectId: h.root.id, path: '.' });
    expect(first.outcome).toBe('needs_approval');
    if (first.outcome !== 'needs_approval') return;

    const decided = h.broker.decide(first.pendingId, { decision: 'approve', remember: true }, 'web');
    expect(decided.ok).toBe(true);
    expect(decided.grantId).toBeTruthy();
    expect(h.broker.grants.hasGrant('files.list', h.root.id)).toBe(true);

    const second = execResult(h, 'files.list', { projectId: h.root.id, path: '.' });
    expect(outcomeOf(second)).toBe('executed');
    if (second.outcome === 'executed') {
      expect((second.result as { entries: unknown[] }).entries).toBeInstanceOf(Array);
    }
  });

  it('approve WITHOUT remember runs once but does not persist a grant', () => {
    const h = setup();
    h.write('a.txt', 'hello');
    const first = execResult(h, 'files.list', { projectId: h.root.id, path: '.' });
    if (first.outcome !== 'needs_approval') throw new Error('expected needs_approval');
    h.broker.decide(first.pendingId, { decision: 'approve' }, 'web');
    expect(h.broker.grants.hasGrant('files.list', h.root.id)).toBe(false);
    // A fresh call needs approval again.
    expect(execResult(h, 'files.list', { projectId: h.root.id, path: '.' }).outcome).toBe('needs_approval');
  });

  it('deny closes the pending row and grants nothing', () => {
    const h = setup();
    const res = execResult(h, 'files.read', { projectId: h.root.id, path: 'a.txt' });
    if (res.outcome !== 'needs_approval') throw new Error('expected needs_approval');
    h.broker.decide(res.pendingId, { decision: 'deny', note: 'nope' }, 'web');
    expect(h.broker.pending.list()).toHaveLength(0);
    expect(h.broker.grants.hasGrant('files.read', h.root.id)).toBe(false);
  });

  it('MEDIUM (files.edit) and HIGH (files.apply/delete) all surface needs_approval without a grant', () => {
    const h = setup();
    h.write('m.txt', 'one');
    const edit = execResult(h, 'files.edit', { projectId: h.root.id, path: 'm.txt', proposedContent: 'two' });
    expect(edit.outcome).toBe('needs_approval');
    if (edit.outcome !== 'needs_approval') return;

    // Approve-remember for the medium tool, then exec executes.
    h.broker.decide(edit.pendingId, { decision: 'approve', remember: true }, 'web');
    const editRun = execResult(h, 'files.edit', { projectId: h.root.id, path: 'm.txt', proposedContent: 'two' });
    expect(editRun.outcome).toBe('executed');
    if (editRun.outcome !== 'executed') return;
    const proposalId = (editRun.result as { proposalId: string }).proposalId;

    // HIGH apply still asks even though the MEDIUM grant exists.
    const apply = execResult(h, 'files.apply', { projectId: h.root.id, proposalId });
    expect(apply.outcome).toBe('needs_approval');
    if (apply.outcome !== 'needs_approval') return;

    // Approve(remember) for apply -> the approval ITSELF executes the apply
    // once -> file changed on disk (no separate re-exec needed).
    const decided = h.broker.decide(apply.pendingId, { decision: 'approve', remember: true }, 'web');
    expect(decided).toMatchObject({ ok: true, executed: true });
    expect(readFileSync(join(h.rootPath, 'm.txt'), 'utf8')).toBe('two');

    // delete still needs approval after all that.
    const del = execResult(h, 'files.delete', { projectId: h.root.id, path: 'm.txt' });
    expect(del.outcome).toBe('needs_approval');
  });

  it('an EXPLICIT user grant executes directly without touching the queue', () => {
    const h = setup();
    h.write('a.txt', 'data');
    h.broker.grants.add('files.read', h.root.id);
    const res = execResult(h, 'files.read', { projectId: h.root.id, path: 'a.txt' });
    expect(outcomeOf(res)).toBe('executed');
    if (res.outcome === 'executed') {
      expect((res.result as { content: string }).content).toBe('data');
    }
    expect(h.broker.pending.list()).toHaveLength(0);
  });

  it('runtime tool errors are typed denials (read-only root, too_large, outside_root)', () => {
    const ro = setup(true);
    ro.broker.grants.add('files.edit', ro.root.id);
    const roRes = execResult(ro, 'files.edit', { projectId: ro.root.id, path: 'x.txt', proposedContent: 'y' });
    expect(roRes.outcome).toBe('denied');
    if (roRes.outcome === 'denied') expect(roRes.reason).toBe('read_only');

    const h = setup();
    h.broker.grants.add('files.read', h.root.id);
    h.write('big.txt', 'x'.repeat(2_000_000));
    const big = execResult(h, 'files.read', { projectId: h.root.id, path: 'big.txt' });
    expect(big.outcome).toBe('denied');
    if (big.outcome === 'denied') expect(big.reason).toBe('too_large');

    const esc = execResult(h, 'files.read', { projectId: h.root.id, path: '../outside' });
    expect(esc.outcome).toBe('denied');
    if (esc.outcome === 'denied') expect(esc.reason).toBe('outside_root');
  });
});

describe('audit discipline', () => {
  it('every execution writes a row; params/results never leak content or secrets', () => {
    const h = setup();
    h.write('editme.txt', 'PLANET-SECRET-ORIGINAL-LINE sk-leak-1234567890\n');
    const SECRET_PROPOSED = 'PLANET-SECRET-PROPOSED password=hunter2 sk-other-999999999\n';

    h.broker.grants.add('files.edit', h.root.id);
    const edit = execResult(h, 'files.edit', {
      projectId: h.root.id,
      path: 'editme.txt',
      proposedContent: SECRET_PROPOSED,
    });
    expect(edit.outcome).toBe('executed');
    if (edit.outcome !== 'executed') return;
    const proposalId = (edit.result as { proposalId: string }).proposalId;

    h.broker.grants.add('files.read', h.root.id);
    const read = execResult(h, 'files.read', { projectId: h.root.id, path: 'editme.txt' });
    expect(read.outcome).toBe('executed');

    const rows = h.auditRows();
    const actions = rows.map((r) => r.action);
    expect(actions).toContain('files.edit.executed');
    expect(actions).toContain('files.read.executed');

    const blob = rows.map((r) => JSON.stringify(r)).join('\n');
    expect(blob).not.toContain('PLANET-SECRET-ORIGINAL-LINE');
    expect(blob).not.toContain('PLANET-SECRET-PROPOSED');
    expect(blob).not.toContain('hunter2');
    expect(blob).not.toContain('sk-leak-1234567890');
    expect(blob).not.toContain('sk-other-999999999');
    expect(blob).not.toContain('password=hunter2');

    // Structural summary IS present (lengths, ids, paths) so audit stays useful.
    const editRow = rows.find((r) => r.action === 'files.edit.executed');
    expect(editRow?.details).toContain('result.proposedChars');
    expect(editRow?.details).toContain('result.originalChars');
    expect(editRow?.details).toContain('param.path');
    expect(editRow?.target).toBe(h.root.id);
    // Executions under a grant record WHICH grant authorized them.
    const readRow = rows.find((r) => r.action === 'files.read.executed');
    expect(readRow?.details).toContain('"grantId"');
    void proposalId;
  });

  it('a needs_approval exec is audited and the pending queue keeps only params', () => {
    const h = setup();
    h.write('editme.txt', 'orig');
    const res = execResult(h, 'files.edit', {
      projectId: h.root.id,
      path: 'editme.txt',
      proposedContent: 'secret-content-body',
    });
    expect(res.outcome).toBe('needs_approval');
    const rows = h.auditRows();
    expect(rows.some((r) => r.action === 'files.edit.needs_approval')).toBe(true);
    const blob = rows.map((r) => JSON.stringify(r)).join('\n');
    expect(blob).not.toContain('secret-content-body');
  });
});
