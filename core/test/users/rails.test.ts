/**
 * M22/R1 — the per-user partition rails.
 *
 * Unit-level: a stubbed `build` proves the RAIL bookkeeping (open once, reuse,
 * LRU bound, idle sweep, close semantics) without standing up 40 stores per user.
 * The isolation itself — two users cannot see each other's rows — is proven over
 * real HTTP in `core/test/http/userPartitions.test.ts`, because that is the claim
 * that matters and a stub cannot make it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config.js';
import { createKeychainFile } from '../../src/keychain/file.js';
import { createSystemStores } from '../../src/users/store.js';
import { createUserRails, partitionConfigFor } from '../../src/users/rails.js';
import { openDatabase } from '../../src/stores/db.js';
import type { CoreBundle } from '../../src/index.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'partner-rails-'));
  dirs.push(dir);
  return dir;
}

/** A config whose partitions live in `dir` under a file keychain. */
function configFor(dir: string) {
  return {
    ...loadConfig({
      DEMO_MODE: '0',
      KEYCHAIN_KIND: 'file',
      KEYCHAIN_FILE: join(dir, 'keychain.json'),
      DB_PATH: join(dir, 'partner.db'),
      DATA_ROOT: dir,
      PORT: '0',
      SCHEDULER_TICK_MS: '0',
      AUTH_MODE: 'login',
    }),
  };
}

/**
 * A stand-in core. The rails call `scheduler.start()` when a partition opens and
 * `scheduler.stop()` whenever it closes, so both must exist — the first version
 * of this fixture omitted `start`, every open threw, and the rails correctly
 * reported `undefined` for a core it could not build.
 */
function stubBundle(label: string): CoreBundle {
  return {
    scheduler: { start: vi.fn(), stop: vi.fn() },
    app: { label },
  } as unknown as CoreBundle;
}

function makeRails(dir: string, options: { maxOpen?: number; idleMs?: number; now?: () => number }) {
  const config = configFor(dir);
  const built: string[] = [];
  const rails = createUserRails({
    config,
    system: createSystemStores(openDatabase(':memory:')),
    keychain: createKeychainFile(join(dir, 'keychain.json')),
    build: (cfg) => {
      built.push(cfg.userId ?? '?');
      return stubBundle(cfg.userId ?? '?');
    },
    ...(options.maxOpen === undefined ? {} : { maxOpen: options.maxOpen }),
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return { rails, built };
}

describe('user rails', () => {
  it('opens a user once and reuses the same core', async () => {
    const dir = tempDir();
    const { rails, built } = makeRails(dir, {});
    try {
      const first = await rails.coreFor('ama');
      const second = await rails.coreFor('ama');
      expect(first).toBe(second);
      expect(built).toEqual(['ama']);
      expect(rails.openUserIds()).toEqual(['ama']);
    } finally {
      rails.closeAll();
    }
  });

  it('gives each user their own database FILE and skills dir (the isolation unit)', () => {
    const dir = tempDir();
    const config = configFor(dir);
    const ama = partitionConfigFor(config, 'ama', {
      dbPath: join(dir, 'users', 'ama', 'partner.db'),
      skillsDir: join(dir, 'users', 'ama', 'skills'),
    });
    const bo = partitionConfigFor(config, 'bo', {
      dbPath: join(dir, 'users', 'bo', 'partner.db'),
      skillsDir: join(dir, 'users', 'bo', 'skills'),
    });
    expect(ama.dbPath).not.toBe(bo.dbPath);
    expect(ama.skillsDir).not.toBe(bo.skillsDir);
    expect(ama.userId).toBe('ama');
    // Everything else comes through unchanged (same system DB, same ports…).
    expect(ama.port).toBe(config.port);
    expect(ama.keychainFile).toBe(config.keychainFile);
  });

  it('evicts the least recently used partition past the bound', async () => {
    const dir = tempDir();
    const { rails } = makeRails(dir, { maxOpen: 2 });
    try {
      await rails.coreFor('a');
      await rails.coreFor('b');
      await rails.coreFor('a'); // a is now the most recent
      await rails.coreFor('c'); // evicts b
      expect(rails.openUserIds()).toEqual(['a', 'c']);
      expect(rails.size).toBe(2);
    } finally {
      rails.closeAll();
    }
  });

  it('sweeps partitions idle past idleMs and keeps the busy ones', async () => {
    const dir = tempDir();
    let now = 1_000;
    const { rails } = makeRails(dir, { idleMs: 60_000, now: () => now });
    try {
      await rails.coreFor('slow');
      now += 50_000;
      await rails.coreFor('quick');
      now += 20_000; // 'slow' is now 70s idle, 'quick' 20s
      expect(rails.sweep()).toEqual(['slow']);
      expect(rails.openUserIds()).toEqual(['quick']);
      // An idle sweep with nothing to do answers nothing (not an error).
      expect(rails.sweep()).toEqual([]);
    } finally {
      rails.closeAll();
    }
  });

  it('never sweeps when idleMs is 0 (the default)', async () => {
    const dir = tempDir();
    const { rails } = makeRails(dir, {});
    try {
      await rails.coreFor('ama');
      expect(rails.sweep()).toEqual([]);
      expect(rails.size).toBe(1);
    } finally {
      rails.closeAll();
    }
  });

  it('close() stops the user’s scheduler and drops the rail', async () => {
    const dir = tempDir();
    const { rails } = makeRails(dir, {});
    try {
      const core = await rails.coreFor('ama');
      expect(rails.close('ama')).toBe(true);
      expect((core?.scheduler.stop as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);
      expect(rails.size).toBe(0);
      expect(rails.close('ama')).toBe(false); // idempotent
    } finally {
      rails.closeAll();
    }
  });
});
