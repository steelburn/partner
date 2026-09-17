/**
 * Environment configuration for the Partner core (M0 security spine).
 *
 * Fail-fast configuration: reject invalid input, derive everything derivable
 * (host allowlist, db path, keychain kind) from a tiny set of knobs, and never
 * embed secrets here.
 *
 * Demo mode is the default (DEMO_MODE unset or truthy). It relaxes secret
 * requirements: keychain is the in-memory fake and the DB defaults to
 * ':memory:' so nothing touches the OS keychain or disk.
 */
import { SCHEMA_VERSION } from '@partner/shared';
import { CLIENT_CLASSES } from './http/capabilities.js';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTls, transportRefusal, uncoveredHosts } from './net/tls.js';
import { systemDbPath as deriveSystemDbPath } from './system/db.js';
import { assertValidUserId, userDbPath, usersRoot } from './users/paths.js';

export const DEFAULT_PORT = 4390;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_DB_PATH = './data/partner.db';

/** Semantic version of the core sidecar (independent of the npm package). */
export const CORE_VERSION = '0.1.18';

/**
 * Where secrets live. `native` = the OS keychain (the default, and the only
 * kind that isolates secrets from the data volume). `fake` = in-memory, DEMO
 * ONLY. `file` = a JSON file at `KEYCHAIN_FILE`, for containers and headless
 * hosts that have no keyring daemon (M21) — see keychain/file.ts for what it
 * does and does not protect.
 */
export type KeychainKind = 'fake' | 'native' | 'file';

/**
 * How a client becomes a session (M22).
 *
 *  - `pairing` (default): the M0/M15/M20-B ceremony — a 6-digit code read off
 *    the machine, or a single-use secret issued on it. It identifies a DEVICE by
 *    proximity, which is right for the desktop app and wrong for a hosted core:
 *    "is this on my LAN?" says nothing about who is asking.
 *  - `login`: a per-user passphrase (`users/credentials.ts`, scrypt) mints a
 *    session that NAMES ITS USER, so authorization has an identity to work with.
 */
export type AuthMode = 'pairing' | 'login';

/**
 * M22 sign-up: whether a person may create their own account (env SIGNUP_MODE).
 * `off` (default) keeps creation an operator act; `invite` is gated on a
 * single-use code the operator mints on the machine. See {@link CoreConfig}.
 */
export type SignupMode = 'off' | 'invite';

/** Loaded TLS material: what index.ts serves and what SAN coverage validated. */
export interface CoreTlsConfig {
  /** PEM certificate (chain or leaf) that is served. */
  certFile: string;
  /** PEM private key matching `certFile`. */
  keyFile: string;
  /** trust.ts fingerprint (base64url sha256 of the DER) — the pinned value. */
  fingerprint: string;
  /** Hosts the certificate's subjectAltName covers. */
  sanHosts: readonly string[];
}

/** Injectable seams for hermetic tests; production leaves both defaulted. */
export interface ConfigDeps {
  /** Reads TLS material; defaults to node:fs readFileSync (utf8). */
  readFile?: (path: string) => string;
}

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
  /**
   * M22: per-peer budget for `POST /v1/auth/session` (env LOGIN_RATE_LIMIT /
   * LOGIN_RATE_WINDOW_MS). Sits ON TOP of the per-credential lockout, because
   * behind a tunnel every request shares one peer address and the lockout alone
   * would let one bad actor lock the owner out.
   */
  loginRateLimit: { limit: number; windowMs: number };
  /**
   * M22: how clients authenticate (env AUTH_MODE). `login` requires the system
   * database (users + credentials) and disables the pairing routes entirely.
   */
  authMode: AuthMode;
  /**
   * M22 sign-up: whether a person can create their OWN account from the web UI
   * (`SIGNUP_MODE`) — see {@link SignupMode}. `off` (default) is the position
   * PLAN-M20-B §6/Q2 took: creating an account is an administrative act, and
   * "who may reach this hostname" is not "who may create an account".
   */
  signupMode: SignupMode;
  /**
   * How long a minted invite stays usable (`SIGNUP_TTL_MS`, default 24h).
   *
   * Long on purpose: an invite is handed to a PERSON (a message, a note), not
   * scanned in seconds like a pairing QR. It is still single-use, only the most
   * recently minted one is live, and it dies with the process.
   */
  signupTtlMs: number;
  /**
   * M22: the client class a LOGIN session is minted with (env
   * LOGIN_SESSION_CLASS, default `desktop`). Login proves a *user*, so the
   * capability envelope's client-class narrowing becomes an explicit operator
   * choice rather than a property of how the client happened to connect.
   */
  loginSessionClass: string;
  /** SQLite location (file path or ':memory:'). */
  dbPath: string;
  /**
   * M20-B S2: the SYSTEM database — the only one that exists before a user is
   * resolved (`users`, `user_credentials`, and the `pairings`/`sessions`
   * home). Defaults to `<dataRoot>/system.db` and is ':memory:' in a demo or
   * ':memory:'-DB boot, where nothing touches disk (an unkeyed system file
   * would mean plaintext user records — `system/db.ts` refuses that outright).
   */
  systemDbPath: string;
  /** Which Keychain implementation to wire. */
  keychain: KeychainKind;
  /**
   * R7: per-attachment upload cap (env MAX_UPLOAD_BYTES, default 8 MiB) and the
   * JSON body cap (env MAX_JSON_BYTES, default 1 MiB). Uploads are the one place
   * a remote client can push bulk data at a hosted core, so an operator can
   * tighten both without a rebuild.
   */
  maxUploadBytes: number;
  maxJsonBytes: number;
  /**
   * R1: how many per-user partitions stay open (env PARTITION_MAX_OPEN, default
   * 8, matching `users/partition.ts`). Each open partition is a database handle
   * plus ~40 stores, so this is a memory/handle bound — not a user limit.
   */
  partitionMaxOpen: number;
  /**
   * R3: close a partition after this much idle time (env PARTITION_IDLE_MS,
   * default 0 = never). Closing drops the key material from memory; the next
   * request re-opens it from the keychain.
   */
  partitionIdleMs: number;
  /**
   * M21: the JSON secrets file when `keychain === 'file'` (env KEYCHAIN_FILE).
   * Required for that kind and ignored otherwise; the deployment mounts it on a
   * volume, because provider keys are written at runtime.
   */
  keychainFile?: string;
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
  /**
   * M20-B S6: remote access (env REMOTE_ACCESS) — OFF by default. It is the
   * one switch that leaves the loopback trust model, so it is refused unless
   * TLS and an EXPLICIT ALLOWED_HOSTS list are both configured (the matrix in
   * loadConfig). Demo mode keeps its permissive container bind.
   */
  remoteAccess: boolean;
  /**
   * M20-B S6: TLS material (env TLS_CERT_FILE + TLS_KEY_FILE). Present ⇒ the
   * listener is HTTPS (index.ts) and `fingerprint` is the value a pairing
   * client pins. Undefined keeps the default plain-HTTP loopback path.
   */
  tls?: CoreTlsConfig;
  /**
   * Host header allowlist. Default (remote access off): the DERIVED loopback
   * pair for `port`. Remote access on: the EXPLICIT ALLOWED_HOSTS list,
   * verbatim — no loopback fallback is appended, because a Host header is a
   * lookup key and an implicit addition would silently widen the list.
   */
  hostAllowlist: string[];
  codeTtlMs: number;
  maxAttempts: number;
  lockMs: number;
  sessionTtlMs: number;
  /**
   * M22: DEPLOYMENT-OWNED project roots (env FIXED_ROOTS, comma-separated
   * absolute paths). When non-empty the core registers exactly these roots at
   * boot and the HTTP surface REFUSES to add or remove roots — the deployment
   * (a container volume mount, say) owns them, so a client cannot change what
   * the file tools can see. Empty ⇒ today's desktop behaviour: the user
   * registers roots in the Files view.
   */
  fixedRoots: string[];
  /**
   * M22: register the deployed roots READ-ONLY (`FIXED_ROOTS_READ_ONLY=1`). The
   * file tools already refuse to write on a read-only root, so this is a
   * deployment choice with no new enforcement path to trust.
   */
  fixedRootsReadOnly: boolean;
  /**
   * M22/R4: the header a TRUSTED PROXY fills in with the real client address
   * (`CLIENT_IP_HEADER`, e.g. `cf-connecting-ip`). Used ONLY to bucket the
   * authentication rate limits — never to decide locality, which stays on the
   * socket peer (a header must never make a remote request look loopback).
   */
  clientIpHeader?: string;
  /**
   * M22/R4: the networks whose `clientIpHeader` is believed
   * (`TRUSTED_PROXY_CIDRS`, e.g. `172.16.0.0/12` for the docker bridge). Without
   * this, the header is ignored and every request shares the tunnel's bucket.
   * Only IPv4 CIDRs and exact IPv6 addresses are accepted (documented).
   */
  trustedProxyCidrs: string[];
  /**
   * M8 per-core skill store (installed code): env SKILLS_DIR. For a
   * partitioned boot this is the user's own `<partition>/skills`.
   */
  skillsDir: string;
  /**
   * M26 cut E: the core-owned temp root a DRAFT dry-run materializes into
   * (one dir per run, wiped in a finally): env SKILL_RUNS_DIR. Derived exactly
   * like {@link skillsDir} - LIVE next to this core's SQLite under
   * `<db dir>/skill-runs`, DEMO (`:memory:` boots) under the OS temp dir - so a
   * draft run never writes into the installed store and never walks up into
   * the repo tree. It is scratch space: never scanned for installable skills.
   */
  skillRunsDir: string;
  /**
   * M20-B S1: parent of the per-user tree (`<dataRoot>/users/<userId>/`).
   * Defaults to this DB's directory, so an explicit DB_PATH keeps partitions
   * next to it; env DATA_ROOT overrides.
   */
  dataRoot: string;
  /** M20-B S1: the users tree itself (`<dataRoot>/users`), derived. */
  usersRoot: string;
  /**
   * M20-B S1: the app user THIS core boots as (env USER_ID). When set on a
   * LIVE file-database boot, `dbPath`/`skillsDir` are that user's partition —
   * their own encrypted file, their own cipher key, their own skills dir.
   * Unset = today's single-user layout, byte-identical. Demo/:memory: boots
   * stay the single plaintext DB they are (partitions are a server concept).
   */
  userId?: string;
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
 * Passing an explicit object keeps tests hermetic; `deps` injects the TLS file
 * reader so the matrix is provable without writing certificate material.
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
  deps: ConfigDeps = {},
): CoreConfig {
  // The port, VALIDATED rather than clamped. `readInt` would silently fall back
  // to 4390 for anything out of range — including `PORT=0`, which a caller
  // reasonably reads as "let the OS choose" — and that produced two real
  // failures: a deployment that typo'd its port bound somewhere it did not
  // intend, and three tests asking for an ephemeral port silently got 4390, so
  // they passed only while 4390 happened to be free (a leaked dev core on that
  // port turned one of them into "Cannot read properties of null"). An
  // ephemeral port is refused EXPLICITLY because the loopback allowlist is
  // derived from this number (`127.0.0.1:0` would allowlist nothing): a caller
  // that wants one picks a free port and names it, so the allowlist agrees with
  // the listener (see `core/test/helpers.ts` `freePort()`).
  const portRaw = env.PORT?.trim() ?? '';
  let port = DEFAULT_PORT;
  if (portRaw !== '') {
    const parsed = Number.parseInt(portRaw, 10);
    if (!/^\d+$/.test(portRaw) || parsed < 1 || parsed > 65535) {
      throw new Error(
        `PORT must be an integer between 1 and 65535 (got "${portRaw}") — refused rather than ` +
          'defaulted, because the wrong port binds somewhere you did not intend (0 means "any ' +
          'free port", which the loopback allowlist cannot name)',
      );
    }
    port = parsed;
  }
  const demo = readBool(env.DEMO_MODE, true);
  const host = env.HOST?.trim() || DEFAULT_HOST;

  // ---- M20-B S6: the refusal matrix (remote access, TLS, host allowlist) ----
  //
  // PLAN-M20 §2.1: the moment a client can be remote, the `Host` header is
  // supplied BY THAT CLIENT — it is a LOOKUP KEY for session/origin binding,
  // NOT a network control (server.ts `hostGuard`). The controls are (a) TLS,
  // whose certificate fingerprint is pinned at pair time, and (b) the named
  // allowlist below. That is why every line here REFUSES rather than warns:
  // a warning still serves plaintext, and appending the loopback pair to an
  // explicit list would silently widen what the operator wrote.
  //
  // Loopback-only BY CONSTRUCTION stays the default for the sidecar in LIVE
  // mode: allowlisting loopback Host headers is meaningless if the socket can
  // bind outward, and a live core holds keys + file roots. DEMO mode may bind
  // outward (e.g. a demo webapp container behind a published port) — it has an
  // in-memory DB, a fake keychain, a fake provider and no secrets.
  //
  // BUT the exposure is NOT bounded to a demo page, and an earlier version of
  // this comment said it was: `/v1/dev/pair-code` hands an UNAUTHENTICATED remote
  // caller a desktop session, and a demo core implements /v1/roots, /v1/grants
  // and /v1/files/browse. So a published demo container exposes host filesystem
  // READ to anyone who can reach it. Publish a demo core only where that is
  // acceptable (loopback, or a throwaway machine); it is a dev surface.
  const remoteAccess = readBool(env.REMOTE_ACCESS, false);
  const certFile = env.TLS_CERT_FILE?.trim() || undefined;
  const keyFile = env.TLS_KEY_FILE?.trim() || undefined;
  const allowedHostsRaw = env.ALLOWED_HOSTS?.trim() || undefined;
  const tlsConfigured = certFile !== undefined && keyFile !== undefined;

  // 1. Remote access without TLS is refused, not warned about. `transportRefusal`
  // (net/tls.ts) owns that rule: only an explicit tls:true counts as TLS.
  const refused = transportRefusal({ remote: remoteAccess, tls: tlsConfigured });
  if (refused !== null) {
    throw new Error(
      `REMOTE_ACCESS=1 requires TLS (${refused.reason}): set TLS_CERT_FILE and ` +
        'TLS_KEY_FILE — a remote bind without TLS serves plaintext.',
    );
  }

  // 2. Half a TLS pair is a configuration error, never a silent no-TLS boot.
  if ((certFile === undefined) !== (keyFile === undefined)) {
    throw new Error(
      'TLS_CERT_FILE and TLS_KEY_FILE must be set together (tls_pair_incomplete)',
    );
  }

  // 3. Material load: missing file, unreadable file, unparsable PEM and a
  // key/cert mismatch are four different reasons, and loadTls names each one.
  let tls: CoreTlsConfig | undefined;
  if (certFile !== undefined && keyFile !== undefined) {
    const loaded = loadTls({ certFile, keyFile }, deps);
    if (!loaded.ok) {
      throw new Error(
        `TLS material refused (${loaded.reason}) for TLS_CERT_FILE="${certFile}" / ` +
          `TLS_KEY_FILE="${keyFile}"` +
          (loaded.detail !== undefined ? `: ${loaded.detail}` : ''),
      );
    }
    tls = {
      certFile: loaded.certFile,
      keyFile: loaded.keyFile,
      fingerprint: loaded.fingerprint,
      sanHosts: loaded.sanHosts,
    };
  }

  // 4. The host allowlist: explicit and verbatim when remote access is on,
  // derived from `port` otherwise. ALLOWED_HOSTS without REMOTE_ACCESS is
  // refused rather than ignored — a silently unused security knob is worse
  // than a boot error.
  let hostAllowlist: string[];
  if (remoteAccess) {
    if (allowedHostsRaw === undefined) {
      throw new Error(
        'REMOTE_ACCESS=1 requires an explicit ALLOWED_HOSTS list (allowed_hosts_required): ' +
          'comma-separated host[:port], honoured verbatim',
      );
    }
    const listed = allowedHostsRaw.split(',').map((entry) => entry.trim().toLowerCase());
    if (listed.some((entry) => entry.length === 0)) {
      throw new Error('ALLOWED_HOSTS has an empty entry (allowed_hosts_empty)');
    }
    // Unreachable (remote ⇒ TLS, step 1) — an explicit guard so a later edit
    // cannot step past the SAN check below.
    if (tls === undefined) {
      throw new Error('REMOTE_ACCESS=1 requires TLS (remote_requires_tls)');
    }
    // 5. An allowlisted host the certificate does not cover is unusable, so
    // refuse and name exactly which hosts are uncovered.
    const uncovered = uncoveredHosts(tls.sanHosts, listed);
    if (uncovered.length > 0) {
      throw new Error(
        `certificate does not cover allowlisted host(s): ${uncovered.join(', ')} ` +
          '(cert_san_uncovered)',
      );
    }
    hostAllowlist = listed;
  } else {
    if (allowedHostsRaw !== undefined) {
      throw new Error(
        'ALLOWED_HOSTS requires REMOTE_ACCESS=1 (allowed_hosts_requires_remote): the ' +
          'loopback allowlist is derived from PORT, and an explicit list here would be ignored',
      );
    }
    hostAllowlist = [`127.0.0.1:${port}`, `localhost:${port}`];
  }

  const loopbackHosts = ['127.0.0.1', '::1', 'localhost'];
  if (!loopbackHosts.includes(host) && !demo && !remoteAccess) {
    throw new Error(
      `HOST must be a loopback address (127.0.0.1 / ::1 / localhost) in live mode; ` +
        `got "${host}". Non-loopback binding is demo-mode only (container/dev), or an ` +
        'explicit REMOTE_ACCESS=1 with TLS + ALLOWED_HOSTS (PLAN-M20-B S6).',
    );
  }
  // Demo mode defaults to an in-memory DB; an explicit DB_PATH always wins.
  const legacyDbPath = env.DB_PATH?.trim() || (demo ? ':memory:' : DEFAULT_DB_PATH);
  // M20-B S1: the app-user partition this boot serves (USER_ID), and the tree
  // root those partitions live in. Both defaulted; the users tree is ALWAYS
  // derived from `dataRoot`, so the layout has exactly one spelling.
  const userId = env.USER_ID?.trim() || undefined;
  if (userId !== undefined) assertValidUserId(userId);
  const dataRoot =
    env.DATA_ROOT?.trim() ||
    (legacyDbPath === ':memory:' ? join(tmpdir(), 'partner-demo-data') : dirname(legacyDbPath));
  const usersDir = usersRoot(dataRoot);
  // Partitions apply to a LIVE file database only: demo/:memory: keeps the
  // single plaintext DB it is today (partitions are a server-mode concept).
  const dbPath =
    userId !== undefined && !demo && legacyDbPath !== ':memory:'
      ? userDbPath(dataRoot, userId)
      : legacyDbPath;
  // Which keychain backs secrets. DEMO always means the in-memory fake (spec:
  // nothing touches the OS keyring or disk). LIVE takes KEYCHAIN_KIND, and an
  // UNKNOWN value is refused rather than silently treated as `native`: a typo
  // (`KEYCHAIN_KIND=fille`) in a container would otherwise boot the OS-keychain
  // path, which every container lacks, and fail with a daemon error instead of
  // a configuration error. `file` (M21) is the container/headless kind.
  const keychainRaw = env.KEYCHAIN_KIND?.trim().toLowerCase();
  const knownKinds = ['fake', 'native', 'file'];
  if (!demo && keychainRaw !== undefined && keychainRaw !== '' && !knownKinds.includes(keychainRaw)) {
    throw new Error(
      `KEYCHAIN_KIND must be fake | native | file (got "${keychainRaw}") — ` +
        'an unknown kind is refused rather than defaulted, because the wrong ' +
        'kind stores secrets somewhere other than intended',
    );
  }
  const keychain: KeychainKind = demo
    ? 'fake'
    : keychainRaw === 'fake'
      ? 'fake'
      : keychainRaw === 'file'
        ? 'file'
        : 'native';
  // The file kind has no sensible default path: a relative path would be
  // resolved against the process CWD, so two boots could disagree about which
  // file holds the key material. Require it explicitly.
  const keychainFile = env.KEYCHAIN_FILE?.trim() || undefined;
  if (keychain === 'file' && keychainFile === undefined) {
    throw new Error(
      'KEYCHAIN_KIND=file requires KEYCHAIN_FILE (keychain_file_required): a path ' +
        'to the JSON secrets file, mounted on a volume the container can write',
    );
  }
  if (keychain !== 'file' && keychainFile !== undefined) {
    throw new Error(
      `KEYCHAIN_FILE is only meaningful with KEYCHAIN_KIND=file (got KEYCHAIN_KIND=${keychain}) ` +
        '— a silently unused secret path is worse than a boot error',
    );
  }
  // M10 W1: a live-mode FILE database is whole-file encrypted with a key held
  // in the keychain — the in-memory fake keychain cannot protect a file (the
  // key would vanish on restart), so refuse the combination loudly. The file
  // kind CAN protect a file (the key survives on its volume).
  if (!demo && keychain === 'fake' && dbPath !== ':memory:') {
    throw new Error(
      'live mode with the fake keychain cannot protect a file database — ' +
        'use the OS keychain, KEYCHAIN_KIND=file, or DB_PATH=:memory: for a ' +
        'non-persistent session',
    );
  }

  // M22: how clients authenticate. An unknown value is refused — a typo must not
  // silently leave the pairing ceremony (or the login form) in charge.
  const authModeRaw = env.AUTH_MODE?.trim().toLowerCase() || 'pairing';
  if (authModeRaw !== 'pairing' && authModeRaw !== 'login') {
    throw new Error(
      `AUTH_MODE must be pairing | login (got "${authModeRaw}") — an unknown mode is refused ` +
        'rather than defaulted, because the wrong one authenticates differently',
    );
  }
  const authMode: AuthMode = authModeRaw;

  // M22 sign-up: `off` unless the deployment asks for invite-gated
  // self-service. Like AUTH_MODE, an unknown value is refused rather than
  // defaulted — the wrong one lets strangers create accounts on a hostname that
  // the internet can reach.
  const signupModeRaw = env.SIGNUP_MODE?.trim().toLowerCase() || 'off';
  if (signupModeRaw !== 'off' && signupModeRaw !== 'invite') {
    throw new Error(
      `SIGNUP_MODE must be off | invite (got "${signupModeRaw}") — an unknown mode is refused ` +
        'rather than defaulted',
    );
  }
  const signupMode: SignupMode = signupModeRaw;
  if (signupMode !== 'off' && authMode !== 'login') {
    throw new Error(
      'SIGNUP_MODE needs AUTH_MODE=login: sign-up creates a user credential, and the ' +
        'pairing ceremony has no credential to create',
    );
  }
  const signupTtlMs = readInt(env.SIGNUP_TTL_MS, 24 * 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000);
  const loginSessionClass = env.LOGIN_SESSION_CLASS?.trim().toLowerCase() || 'desktop';
  if (authMode === 'login' && !(CLIENT_CLASSES as readonly string[]).includes(loginSessionClass)) {
    throw new Error(
      `LOGIN_SESSION_CLASS must be one of ${CLIENT_CLASSES.join(' | ')} (got "${loginSessionClass}")`,
    );
  }

  // M22: deployment-owned project roots. Absolute paths only — a relative one
  // would resolve against the process CWD, so the same config could point at
  // different directories on two boots. Existence is checked at wiring time
  // (core/src/index.ts), where a missing mount is a boot error naming the path.
  const fixedRoots = (env.FIXED_ROOTS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  for (const root of fixedRoots) {
    if (!root.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(root)) {
      throw new Error(
        `FIXED_ROOTS entries must be absolute paths (got "${root}") — a relative path ` +
          'would resolve against the process working directory',
      );
    }
  }

  const fixedRootsReadOnly = readBool(env.FIXED_ROOTS_READ_ONLY, false);
  const clientIpHeader = env.CLIENT_IP_HEADER?.trim().toLowerCase() || undefined;
  const trustedProxyCidrs = (env.TRUSTED_PROXY_CIDRS ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  for (const cidr of trustedProxyCidrs) {
    const ok =
      /^\d{1,3}(\.\d{1,3}){3}(\/\d{1,2})?$/.test(cidr) ||
      /^[0-9a-fA-F:]{2,45}$/.test(cidr);
    if (!ok) {
      throw new Error(
        `TRUSTED_PROXY_CIDRS entry "${cidr}" is not an IPv4 CIDR or an IPv6 address`,
      );
    }
  }
  if (trustedProxyCidrs.length > 0 && clientIpHeader === undefined) {
    throw new Error(
      'TRUSTED_PROXY_CIDRS requires CLIENT_IP_HEADER (which header carries the real ' +
        'client address) — a trusted network with no header to read is a configuration error',
    );
  }
  if (clientIpHeader !== undefined && trustedProxyCidrs.length === 0) {
    // Fail loudly rather than silently ignoring it: an operator who sets the
    // header expects per-client rate limiting.
    throw new Error(
      'CLIENT_IP_HEADER requires TRUSTED_PROXY_CIDRS (the networks whose header is ' +
        'believed) — refusing to trust a client-supplied header from anywhere',
    );
  }

  return {
    port,
    host,
    demo,
    dbPath,
    // M20-B S2: the system DB sits next to the legacy database in the data
    // root (dirname of DB_PATH), unless this boot has no persistent DB at all
    // — demo and ':memory:' keep it in memory for the same reason a demo DB
    // is in memory: the fake keychain cannot protect a file.
    systemDbPath:
      demo || legacyDbPath === ':memory:' ? ':memory:' : deriveSystemDbPath(dataRoot),
    keychain,
    keychainFile,
    staticDir: env.STATIC_DIR?.trim() || undefined,
    // M15: trim so a stray empty value behaves like unset (route hidden).
    deviceSecret: env.PARTNER_DEVICE_SECRET?.trim() || undefined,
    // M15 hardening: same trimming rule — an empty nonce reads as "no shell
    // spawned this core", and /v1/boot then reports null, not an empty string.
    bootNonce: env.PARTNER_CORE_NONCE?.trim() || undefined,
    remoteAccess,
    tls,
    hostAllowlist,
    codeTtlMs: readInt(env.PAIR_CODE_TTL_MS, 120_000, 1, Number.MAX_SAFE_INTEGER),
    maxAttempts: readInt(env.PAIR_MAX_ATTEMPTS, 3, 1, 100),
    lockMs: readInt(env.PAIR_LOCK_MS, 300_000, 1, Number.MAX_SAFE_INTEGER),
    sessionTtlMs: readInt(env.SESSION_TTL_MS, THIRTY_DAYS_MS, 1, Number.MAX_SAFE_INTEGER),
    // M8: installed skill code lives per-core. LIVE: next to this core's
    // SQLite under <db dir>/skills/ — for a partitioned boot that IS the
    // user's own `<partition>/skills`, derived from the same dbPath, so the
    // two can never disagree. DEMO: under the OS temp dir so skills
    // can never walk up into the repo tree / repo node_modules, and the
    // worker additionally runs with cwd inside its own store dir (review
    // finding 2). Packaged shells override SKILLS_DIR explicitly.
    skillsDir:
      env.SKILLS_DIR?.trim() ||
      (dbPath === ':memory:'
        ? join(tmpdir(), 'partner-demo-skills')
        : join(dirname(dbPath), 'skills')),
    // M26 cut E: the same rule for the dry-run scratch root (env
    // SKILL_RUNS_DIR overrides; packaged shells override it explicitly). One
    // derivation, so a draft run can never land inside the installed store.
    skillRunsDir:
      env.SKILL_RUNS_DIR?.trim() ||
      (dbPath === ':memory:'
        ? join(tmpdir(), 'partner-draft-runs')
        : join(dirname(dbPath), 'skill-runs')),
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
    fixedRoots,
    fixedRootsReadOnly,
    partitionMaxOpen: readInt(env.PARTITION_MAX_OPEN, 8, 1, 64),
    partitionIdleMs: readInt(env.PARTITION_IDLE_MS, 0, 0, 24 * 60 * 60 * 1000),
    maxUploadBytes: readInt(env.MAX_UPLOAD_BYTES, 8 * 1024 * 1024, 1024, 512 * 1024 * 1024),
    maxJsonBytes: readInt(env.MAX_JSON_BYTES, 1024 * 1024, 1024, 64 * 1024 * 1024),
    clientIpHeader,
    trustedProxyCidrs,
    authMode,
    signupMode,
    signupTtlMs,
    loginSessionClass,
    loginRateLimit: {
      limit: readInt(env.LOGIN_RATE_LIMIT, 10, 1, 10_000),
      windowMs: readInt(env.LOGIN_RATE_WINDOW_MS, 60_000, 1, 86_400_000),
    },
    dataRoot,
    usersRoot: usersDir,
    userId,
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
