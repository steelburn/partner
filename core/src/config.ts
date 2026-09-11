/**
 * Environment configuration for the Partner core (M0 security spine).
 *
 * Mirrors the llm-self-service idiom: fail fast on invalid input, derive
 * everything derived (host allowlist, db path, keychain kind) from a tiny
 * set of knobs, and never embed secrets here.
 *
 * Demo mode is the default (DEMO_MODE unset or truthy). It relaxes secret
 * requirements: keychain is the in-memory fake and the DB defaults to
 * ':memory:' so nothing touches the OS keychain or disk.
 */
import { SCHEMA_VERSION } from '@partner/shared';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PORT = 4390;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_DB_PATH = './data/partner.db';

/** Semantic version of the core sidecar (independent of the npm package). */
export const CORE_VERSION = '0.1.6';

export type KeychainKind = 'fake' | 'native';

export interface CoreConfig {
  /** Loopback port the HTTP server binds. */
  port: number;
  /** Bind address; always loopback for the M0 sidecar. */
  host: string;
  /**
   * Demo mode: in-memory DB + fake keychain, exposes /v1/dev/pair-code.
   * Defaults to ON so a fresh checkout boots without an OS keyring daemon.
   */
  demo: boolean;
  /** SQLite location (file path or ':memory:'). */
  dbPath: string;
  /** Which Keychain implementation to wire. */
  keychain: KeychainKind;
  /** Optional built SPA directory to serve at / (packaged shell wires it). */
  staticDir?: string;
  /**
   * M15: per-boot secret the desktop shell generates and hands to the core
   * (PARTNER_DEVICE_SECRET). When set, core enables the header-guarded
   * GET /v1/pair/device channel the tray uses to mint the LIVE pairing
   * code. Absent in dev/CI/container runs — a plain live core exposes no
   * code surface (the demo seam stays demo-only).
   */
  deviceSecret?: string;
  /**
   * M15 hardening (boot identity): the per-boot nonce the desktop shell
   * minted for the sidecar it spawned (PARTNER_CORE_NONCE), echoed back at
   * GET /v1/boot so the shell can prove the listener on its port is the
   * child it started. A stray core — or any local process — already holding
   * the port would otherwise answer the shell's bare TCP probe, and the
   * desktop would render against a foreign core while the shell's own
   * sidecar never served a request (POSIX: it dies with EADDRINUSE;
   * Windows: both listeners bind and the stray wins every connection).
   * NOT a credential: a boot correlation id that unlocks nothing. Absent in
   * dev/CI/container runs, where no shell spawned this core.
   */
  bootNonce?: string;
  /** Host header allowlist (loopback only), derived from the port. */
  hostAllowlist: string[];
  codeTtlMs: number;
  maxAttempts: number;
  lockMs: number;
  sessionTtlMs: number;
  /** M8 per-core skill store (installed code): env SKILLS_DIR. */
  skillsDir: string;
  /** M8 local catalog: env SKILLS_CATALOG_DIR (default repo skills-catalog/). */
  skillsCatalogDir: string;
  /** M14 scheduler heartbeat interval (ms). 0 disables the driver. */
  schedulerTickMs: number;
  /** M14 default timezone for schedules without an explicit tz (IANA). */
  schedulerTz?: string;
  schemaVersion: number;
  version: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const THIRTY_DAYS_MS = 30 * DAY_MS;

function readBool(raw: string | undefined, fallback: boolean): boolean {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === '') return fallback;
  return !(value === '0' || value === 'false' || value === 'off' || value === 'no');
}

function readInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const value = raw?.trim();
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

/**
 * Load configuration from an environment object (defaults to process.env).
 * Passing an explicit object keeps tests hermetic.
 */
export function loadConfig(env: Record<string, string | undefined> = process.env): CoreConfig {
  const port = readInt(env.PORT, DEFAULT_PORT, 1, 65535);
  const demo = readBool(env.DEMO_MODE, true);
  const host = env.HOST?.trim() || DEFAULT_HOST;
  // Loopback-only BY CONSTRUCTION for the sidecar in LIVE mode: allowlisting
  // loopback Host headers is meaningless if the socket can bind outward, and
  // a live core holds keys + file roots. DEMO mode may bind outward (e.g. a
  // demo webapp container behind a published port) — it has an in-memory DB,
  // a fake keychain, a fake provider and no secrets, so exposure is bounded
  // to the demo surface (the /v1/dev/pair-code auto-pair stays demo-only).
  const loopbackHosts = ['127.0.0.1', '::1', 'localhost'];
  if (!loopbackHosts.includes(host) && !demo) {
    throw new Error(
      `HOST must be a loopback address (127.0.0.1 / ::1 / localhost) in live mode; ` +
        `got "${host}". Non-loopback binding is demo-mode only (container/dev).`,
    );
  }
  // Demo mode defaults to an in-memory DB; an explicit DB_PATH always wins.
  const dbPath = env.DB_PATH?.trim() || (demo ? ':memory:' : DEFAULT_DB_PATH);
  // Demo mode short-circuits to the in-memory fake keychain (spec); an
  // explicit KEYCHAIN_KIND override only applies in live mode.
  const keychain: KeychainKind = demo ? 'fake' : env.KEYCHAIN_KIND === 'fake' ? 'fake' : 'native';
  // M10 W1: a live-mode FILE database is whole-file encrypted with a key held
  // in the OS keychain — the in-memory fake keychain cannot protect a file
  // (the key would vanish on restart), so refuse the combination loudly.
  if (!demo && keychain === 'fake' && dbPath !== ':memory:') {
    throw new Error(
      'live mode with the fake keychain cannot protect a file database — ' +
        'use the OS keychain, or DB_PATH=:memory: for a non-persistent session',
    );
  }

  return {
    port,
    host,
    demo,
    dbPath,
    keychain,
    staticDir: env.STATIC_DIR?.trim() || undefined,
    // M15: trim so a stray empty value behaves like unset (route hidden).
    deviceSecret: env.PARTNER_DEVICE_SECRET?.trim() || undefined,
    // M15 hardening: same trimming rule — an empty nonce reads as "no shell
    // spawned this core", and /v1/boot then reports null, not an empty string.
    bootNonce: env.PARTNER_CORE_NONCE?.trim() || undefined,
    hostAllowlist: [`127.0.0.1:${port}`, `localhost:${port}`],
    codeTtlMs: readInt(env.PAIR_CODE_TTL_MS, 120_000, 1, Number.MAX_SAFE_INTEGER),
    maxAttempts: readInt(env.PAIR_MAX_ATTEMPTS, 3, 1, 100),
    lockMs: readInt(env.PAIR_LOCK_MS, 300_000, 1, Number.MAX_SAFE_INTEGER),
    sessionTtlMs: readInt(env.SESSION_TTL_MS, THIRTY_DAYS_MS, 1, Number.MAX_SAFE_INTEGER),
    // M8: installed skill code lives per-core. LIVE: next to this core's
    // SQLite under <db dir>/skills/. DEMO: under the OS temp dir so skills
    // can never walk up into the repo tree / repo node_modules, and the
    // worker additionally runs with cwd inside its own store dir (review
    // finding 2). Packaged shells override SKILLS_DIR explicitly.
    skillsDir:
      env.SKILLS_DIR?.trim() ||
      (dbPath === ':memory:'
        ? join(tmpdir(), 'partner-demo-skills')
        : join(dirname(dbPath), 'skills')),
    // The checked-in local catalog (no remote gallery in M8). Resolved from
    // this source file so tsx/vitest runs work from any working directory.
    // Bundled artifacts (import.meta.url empty) fall back to cwd-relative so
    // boot never throws; SKILLS_CATALOG_DIR overrides in packaged runs.
    skillsCatalogDir:
      env.SKILLS_CATALOG_DIR?.trim() ||
      (metaUrlOfBundle()
        ? fileURLToPath(new URL('../../skills-catalog/', (import.meta as { url?: string }).url as string))
        : join(process.cwd(), 'skills-catalog')),
    // M14: the scheduler wakes on this cadence to fire due schedules.
    schedulerTickMs: readInt(env.SCHEDULER_TICK_MS, 30_000, 0, 3_600_000),
    schedulerTz: env.SCHEDULER_TZ?.trim() || undefined,
    schemaVersion: SCHEMA_VERSION,
    version: CORE_VERSION,
  };
}

/** True when import.meta.url is a real URL (dev/tsx); false in bundled CJS
 *  artifacts where esbuild emits an empty object. */
export function metaUrlOfBundle(): boolean {
  const url = (import.meta as { url?: string }).url;
  return typeof url === 'string' && url !== '';
}
