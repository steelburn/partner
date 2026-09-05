/**
 * M9 deploy manager tests (PLAN-M9.md + PLAN.md §6.1 Ship).
 *
 * CRUD + validation: kind is docker-ssh only (v1), host must be a non-empty
 * bare host, port defaults to 22 and is range-checked 1-65535; env_extra is
 * NOT part of the API input. package() validates the profile, then writes the
 * container-ready bundle (Dockerfile + .dockerignore + README + build.sh)
 * under outDir (temp), returns the file list + dockerfile text, and never
 * embeds host/username connection data in the Dockerfile.
 */
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/stores/db.js';
import { createAuditStore, createDeployProfileStore } from '../../src/stores/db.js';
import { auditLog } from '../../src/services/redaction.js';
import { createDeployManager } from '../../src/playbooks/deploy.js';
import type { DeployManager } from '../../src/playbooks/deploy.js';
import { makeTempRoot, removeTempRoot } from '../helpers.js';

function manager(): { deploy: DeployManager; db: ReturnType<typeof openDatabase>; audit: ReturnType<typeof auditLog> } {
  const db = openDatabase(':memory:');
  const audit = auditLog({ store: createAuditStore(db) });
  return { deploy: createDeployManager({ store: createDeployProfileStore(db), audit }), db, audit };
}

const tempDirs: string[] = [];
function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'partner-deploy-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) removeTempRoot(tempDirs.pop() as string);
});

describe('deploy-profile CRUD + validation', () => {
  it('create -> list -> find shape; defaults port to 22 and kind to docker-ssh', () => {
    const { deploy, db, audit } = manager();
    try {
      const profile = deploy.create({ name: 'prod', host: 'deploy.example.org', username: 'steel' });
      expect(profile).toMatchObject({
        name: 'prod',
        host: 'deploy.example.org',
        kind: 'docker-ssh',
        username: 'steel',
        port: 22,
        remoteBaseDir: null,
      });
      expect(typeof profile.id).toBe('string');
      expect(deploy.list()).toHaveLength(1);
      expect(deploy.list()[0]?.id).toBe(profile.id);
      expect(audit.list(10)[0]?.action).toBe('deploy-profile.create');
      expect(audit.list(10)[0]?.details).toContain('deploy.example.org');
      expect(db.prepare('SELECT COUNT(*) AS n FROM deploy_profiles').get()).toMatchObject({ n: 1 });
    } finally {
      db.close();
    }
  });

  it('validates name/host/port; rejects secret-looking or path-like hosts', () => {
    const { deploy, db } = manager();
    try {
      expect(() => deploy.create({ name: '', host: 'x' })).toThrowError('name');
      expect(() => deploy.create({ name: 'x', host: '' })).toThrowError('host');
      expect(() => deploy.create({ name: 'x', host: 'has space' })).toThrowError(/bare host/i);
      expect(() => deploy.create({ name: 'x', host: 'user@host/path' })).toThrowError(/bare host/i);
      expect(() => deploy.create({ name: 'x', host: 'ok.host', port: 0 })).toThrowError(/port/);
      expect(() => deploy.create({ name: 'x', host: 'ok.host', port: 70000 })).toThrowError(/port/);
      expect(() => deploy.create({ name: 'x', host: 'ok.host', port: 22.5 })).toThrowError(/port/);
      // env_extra is not part of the API — a stray field is ignored, not stored.
      const profile = deploy.create({
        name: 'plain',
        host: 'ok.host',
        ...({ env_extra: { SECRET: 'hunter2' } } as object),
      });
      expect(profile).not.toHaveProperty('envExtra');
    } finally {
      db.close();
    }
  });

  it('duplicate names conflict (409 semantics); remove -> not_found for unknown', () => {
    const { deploy, db, audit } = manager();
    try {
      deploy.create({ name: 'dup', host: 'a.host' });
      expect(() => deploy.create({ name: 'dup', host: 'b.host' })).toThrowError('already exists');
      const profile = deploy.list()[0] as { id: string };
      deploy.remove(profile.id);
      expect(deploy.list()).toHaveLength(0);
      expect(audit.list(10)[0]?.action).toBe('deploy-profile.remove');
      expect(() => deploy.remove('nope')).toThrowError('not found');
    } finally {
      db.close();
    }
  });
});

describe('deploy package step', () => {
  it('writes Dockerfile + .dockerignore + README + build.sh under outDir', () => {
    const { deploy, db } = manager();
    try {
      const projectDir = tempRoot();
      writeFileSync(join(projectDir, 'package.json'), '{}', 'utf8');
      const profile = deploy.create({ name: 'eu-prod', host: '10.11.12.13', port: 2222, username: 'deploy' });
      const outDir = tempRoot();
      const result = deploy.package(profile.id, { projectDir, outDir });

      expect(result.profileId).toBe(profile.id);
      expect(result.outDir).toBe(outDir);
      expect(result.files).toHaveLength(4);
      for (const file of result.files) {
        expect(existsSync(file), file).toBe(true);
      }
      const names = result.files.map((f) => f.split(/[\\/]/).pop());
      expect(names).toEqual(expect.arrayContaining(['Dockerfile', '.dockerignore', 'README.md', 'build.sh']));

      // Dockerfile text: node:22-alpine, PORT env, CMD core-bundle.cjs — and
      // NO connection data (host/username never leak into the bundle).
      expect(result.dockerfile).toContain('node:22-alpine');
      expect(result.dockerfile).toContain('ENV PORT=4390');
      expect(result.dockerfile).toContain('CMD ["node", "core-bundle.cjs"]');
      expect(result.dockerfile).not.toContain('10.11.12.13');
      expect(result.dockerfile).not.toContain('deploy');
      expect(readFileSync(join(outDir, 'Dockerfile'), 'utf8')).toBe(result.dockerfile);

      // build.sh is executable (POSIX hosts only — Windows has no exec bit)
      // and references the project dir for the caller.
      if (process.platform !== 'win32') {
        const mode = statSync(join(outDir, 'build.sh')).mode;
        expect(mode & 0o111).not.toBe(0);
      }
      expect(readFileSync(join(outDir, 'build.sh'), 'utf8')).toContain(projectDir);

      // README documents the environment gate (no live push in M9).
      const readme = readFileSync(join(outDir, 'README.md'), 'utf8');
      expect(readme).toContain(profile.name);
      expect(readme.toLowerCase()).toContain('docker build');
    } finally {
      db.close();
    }
  });

  it('package validates the profile and the directories', () => {
    const { deploy, db } = manager();
    try {
      const projectDir = tempRoot();
      const outDir = tempRoot();
      expect(() => deploy.package('nope', { projectDir, outDir })).toThrowError('not found');
      const profile = deploy.create({ name: 'p', host: 'h.example.org' });
      expect(() => deploy.package(profile.id, { projectDir: 'relative', outDir })).toThrowError(/absolute/);
      expect(() => deploy.package(profile.id, { projectDir: join(outDir, 'missing'), outDir })).toThrowError(
        /existing directory/,
      );
      expect(() => deploy.package(profile.id, { projectDir, outDir: 'relative' })).toThrowError(/absolute/);
    } finally {
      db.close();
    }
  });

  it('audits the package with counts only (no connection material)', () => {
    const { deploy, db, audit } = manager();
    try {
      const projectDir = tempRoot();
      const outDir = tempRoot();
      const profile = deploy.create({ name: 'sec', host: '172.16.0.9' });
      deploy.package(profile.id, { projectDir, outDir });
      const row = audit.list(20).find((r) => r.action === 'deploy-profile.package');
      expect(row?.details).toContain('"files":4');
      expect(row?.details).not.toContain('172.16.0.9');
    } finally {
      db.close();
    }
  });
});
