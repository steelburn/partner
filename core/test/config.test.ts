import { describe, expect, it } from 'vitest';
import { CORE_VERSION, loadConfig } from '../src/config.js';
import type { CoreConfig } from '../src/config.js';

const NO_ENV: Record<string, string | undefined> = {};

describe('loadConfig', () => {
  it('defaults: demo on, loopback 4390, in-memory DB, fake keychain', () => {
    const cfg = loadConfig(NO_ENV);
    expect(cfg.port).toBe(4390);
    expect(cfg.host).toBe('127.0.0.1');
    expect(cfg.demo).toBe(true);
    expect(cfg.dbPath).toBe(':memory:');
    expect(cfg.keychain).toBe('fake');
    expect(cfg.hostAllowlist).toEqual(['127.0.0.1:4390', 'localhost:4390']);
    expect(cfg.codeTtlMs).toBe(120_000);
    expect(cfg.maxAttempts).toBe(3);
    expect(cfg.lockMs).toBe(300_000);
    expect(cfg.sessionTtlMs).toBe(30 * 24 * 60 * 60 * 1000);
    expect(cfg.version).toBe(CORE_VERSION);
  });

  it('live mode: DEMO_MODE=0 disables demo, picks native keychain + file DB', () => {
    const cfg = loadConfig({ ...NO_ENV, DEMO_MODE: '0' });
    expect(cfg.demo).toBe(false);
    expect(cfg.keychain).toBe('native');
    expect(cfg.dbPath).toBe('./data/partner.db');
  });

  it('DEMO_MODE accepts explicit truthy/falsy spellings', () => {
    expect(loadConfig({ ...NO_ENV, DEMO_MODE: 'false' }).demo).toBe(false);
    expect(loadConfig({ ...NO_ENV, DEMO_MODE: 'off' }).demo).toBe(false);
    expect(loadConfig({ ...NO_ENV, DEMO_MODE: '1' }).demo).toBe(true);
    expect(loadConfig({ ...NO_ENV, DEMO_MODE: 'yes' }).demo).toBe(true);
  });

  it('PORT drives the host allowlist; explicit DB_PATH wins in demo; KEYCHAIN_KIND is a live-mode override', () => {
    const cfg = loadConfig({
      ...NO_ENV,
      DEMO_MODE: '1',
      PORT: '4711',
      DB_PATH: '/tmp/live.db',
    });
    expect(cfg.port).toBe(4711);
    expect(cfg.hostAllowlist).toEqual(['127.0.0.1:4711', 'localhost:4711']);
    expect(cfg.dbPath).toBe('/tmp/live.db');
    // Demo always uses the fake keychain.
    expect(cfg.keychain).toBe('fake');

    const live = loadConfig({ ...NO_ENV, DEMO_MODE: '0', KEYCHAIN_KIND: 'fake' });
    expect(live.demo).toBe(false);
    expect(live.keychain).toBe('fake');
  });

  it('garbage numbers fall back to defaults instead of crashing', () => {
    const cfg = loadConfig({ ...NO_ENV, PORT: 'not-a-port', PAIR_MAX_ATTEMPTS: '-1' });
    expect(cfg.port).toBe(4390);
    expect(cfg.maxAttempts).toBe(3);
  });

  it('honors pairing/session tuning knobs', () => {
    const cfg = loadConfig({
      ...NO_ENV,
      PAIR_CODE_TTL_MS: '1000',
      PAIR_MAX_ATTEMPTS: '5',
      PAIR_LOCK_MS: '9000',
      SESSION_TTL_MS: '42',
    });
    expect(cfg).toMatchObject({
      codeTtlMs: 1000,
      maxAttempts: 5,
      lockMs: 9000,
      sessionTtlMs: 42,
    } satisfies Partial<CoreConfig>);
  });
});
