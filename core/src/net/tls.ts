/**
 * TLS material loading, SAN coverage and the remote-without-TLS refusal
 * (PLAN-M20-B S6) — node:fs/node:crypto only, no other core module.
 * (`X509Certificate` comes from node:crypto: node:tls does not re-export it on
 * every supported Node — on 25.5.0 `tls.X509Certificate` is undefined, and the
 * SAN check needs the class, not the module it was once documented under.)
 *
 * Two separable jobs, deliberately kept apart so config wiring (another lane)
 * composes them instead of re-implementing them:
 *  1. `loadTls` / `parseTlsMaterial` — real material or a NAMED refusal.
 *     A missing file, an unreadable file, unparsable PEM and a key that does
 *     not match the certificate are four different reasons; none of them is a
 *     warning. Both files are read BEFORE anything is parsed, so a missing
 *     path is never misreported as malformed material.
 *  2. `sanCovers` / `uncoveredHosts` — does the certificate actually cover
 *     every host we are going to advertise? An explicit host allowlist is only
 *     usable if the cert's SANs cover it; `Host`/`origin` matching is a lookup
 *     key, not a network control (S6/§2.1).
 *
 * `transportRefusal` holds the S6 rule itself: a remote bind without TLS is
 * REFUSED, not warned about. Only an explicit `remote: false` proves
 * local-only, and only an explicit `tls: true` counts as TLS — an absent or
 * malformed flag never authorizes a non-loopback bind.
 *
 * Out of scope here (config.ts / index.ts own it): choosing the bind address,
 * deriving or validating the host allowlist, and constructing the https server.
 */
import { readFileSync } from 'node:fs';
import { createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { certFingerprint } from './trust.js';

export interface TlsFileInput {
  /** Absolute or relative path to the PEM certificate (chain or leaf). */
  certFile: string;
  /** Path to the PEM private key matching `certFile`. */
  keyFile: string;
}

export interface TlsMaterial {
  /** trust.ts fingerprint of the certificate DER (the pinned value). */
  fingerprint: string;
  /** Host entries from the certificate's subjectAltName, normalized. */
  sanHosts: readonly string[];
}

export type TlsMaterialRefusalReason = 'cert_invalid' | 'key_invalid' | 'key_mismatch';
export type TlsLoadRefusalReason =
  | 'cert_missing'
  | 'key_missing'
  | 'cert_unreadable'
  | 'key_unreadable'
  | TlsMaterialRefusalReason;

export type TlsMaterialResult =
  | ({ ok: true } & TlsMaterial)
  | { ok: false; reason: TlsMaterialRefusalReason; detail?: string };

export type TlsLoadResult =
  | ({ ok: true; certFile: string; keyFile: string } & TlsMaterial)
  | { ok: false; reason: TlsLoadRefusalReason; detail?: string };

/**
 * `readFile` is injectable so the read → parse → fingerprint path is provable
 * without writing certificate files to disk. Production leaves it defaulted.
 */
export interface TlsLoadDeps {
  readFile?: (path: string) => string;
}

const detailOf = (err: unknown): string =>
  err instanceof Error ? err.message : 'unknown error'; // messages only; never key material

const isMissing = (err: unknown): boolean =>
  (err as NodeJS.ErrnoException | null)?.code === 'ENOENT';

export function loadTls(input: TlsFileInput, deps: TlsLoadDeps = {}): TlsLoadResult {
  const read = deps.readFile ?? ((path: string): string => readFileSync(path, 'utf8'));

  let certPem: string;
  try {
    certPem = read(input.certFile);
  } catch (err) {
    return { ok: false, reason: isMissing(err) ? 'cert_missing' : 'cert_unreadable' };
  }

  let keyPem: string;
  try {
    keyPem = read(input.keyFile);
  } catch (err) {
    return { ok: false, reason: isMissing(err) ? 'key_missing' : 'key_unreadable' };
  }

  const parsed = parseTlsMaterial({ certPem, keyPem });
  if (!parsed.ok) return parsed;
  return { certFile: input.certFile, keyFile: input.keyFile, ...parsed };
}

/** Parse already-read PEM material. Never returns material it cannot verify. */
export function parseTlsMaterial(input: { certPem: string; keyPem: string }): TlsMaterialResult {
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(input.certPem);
  } catch (err) {
    return { ok: false, reason: 'cert_invalid', detail: detailOf(err) };
  }

  let key: ReturnType<typeof createPrivateKey>;
  try {
    key = createPrivateKey(input.keyPem);
  } catch (err) {
    return { ok: false, reason: 'key_invalid', detail: detailOf(err) };
  }

  // The private key must belong to this certificate, or TLS would serve a
  // handshake that cannot complete (and the pinned fingerprint would describe
  // a certificate the key does not match).
  if (spki(cert.publicKey) !== spki(createPublicKey(key))) {
    return { ok: false, reason: 'key_mismatch' };
  }

  return { ok: true, fingerprint: certFingerprint(cert.raw), sanHosts: sanHostsOf(cert) };
}

const spki = (key: KeyObject): string => key.export({ format: 'der', type: 'spki' }).toString('base64');

/** `DNS:` and `IP Address:` entries of subjectAltName; other kinds are not hosts. */
function sanHostsOf(cert: X509Certificate): string[] {
  const subjectAltName = cert.subjectAltName;
  if (typeof subjectAltName !== 'string' || subjectAltName.length === 0) return [];

  const hosts: string[] = [];
  for (const raw of subjectAltName.split(',')) {
    const entry = raw.trim();
    const kind = entry.slice(0, entry.indexOf(':')).toLowerCase();
    if (kind !== 'dns' && kind !== 'ip address') continue;
    const host = normalizeHost(entry.slice(entry.indexOf(':') + 1));
    if (host.length > 0) hosts.push(host);
  }
  return hosts;
}

/**
 * One spelling of "the same host": lowercase, no brackets, no port, no
 * trailing dot. A bare IPv6 literal keeps its colons (only a single colon is
 * read as a port separator).
 */
function normalizeHost(value: unknown): string {
  if (typeof value !== 'string') return '';
  let host = value.trim().toLowerCase();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end !== -1) host = host.slice(1, end);
  } else if (host.indexOf(':') !== -1 && host.indexOf(':') === host.lastIndexOf(':')) {
    host = host.slice(0, host.indexOf(':'));
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

/**
 * Does ONE SAN entry cover `host`?
 *
 * Exact (case-insensitive) match, plus RFC 6125 wildcard matching: a single
 * leading `*.` covers exactly ONE left-most label. Wildcards are REQUIRED for
 * real certificates — Let's Encrypt and most mesh CAs issue `*.example.com`, so
 * refusing them would make the TLS path unusable for the common case rather than
 * safer.
 *
 * The single-label rule is what keeps it safe, and it must be implemented as a
 * LABEL bound rather than a suffix test. `host.endsWith('.example.com')` alone
 * would match `evil-example.com` (the suffix-attack: the character before the
 * suffix is `-`, not `.`), so the label is extracted and checked for being
 * non-empty and dot-free.
 *
 * Not covered, deliberately: a bare domain (`*.example.com` does NOT cover
 * `example.com`) and a deeper name (`*.example.com` does NOT cover
 * `a.b.example.com`). Both are RFC 6125 behaviour.
 */
function sanEntryCovers(entry: string, host: string): boolean {
  const san = normalizeHost(entry);
  if (san === host) return true;
  if (!san.startsWith('*.')) return false;
  const suffix = san.slice(2);
  if (suffix === '') return false;
  if (!host.endsWith(`.${suffix}`)) return false;
  const label = host.slice(0, host.length - suffix.length - 1);
  return label.length > 0 && !label.includes('.');
}

/**
 * SAN coverage for one host.
 *
 * Unusable input covers nothing: an empty host, an empty SAN list, or a
 * non-string SAN entry all return false.
 */
export function sanCovers(sanHosts: readonly string[], host: string): boolean {
  const wanted = normalizeHost(host);
  if (wanted.length === 0 || !Array.isArray(sanHosts)) return false;
  return sanHosts.some((entry) => sanEntryCovers(entry, wanted));
}

/**
 * Every allowlisted host the certificate does NOT cover (empty ⇒ all covered).
 *
 * FAILS CLOSED: a non-array `hosts` THROWS rather than returning `[]`, because
 * `[]` reads as "everything is covered" and that would be the only permissive
 * default in this module. The caller feeds this a parsed allowlist, so a
 * non-array is a programming error about a security control.
 */
export function uncoveredHosts(sanHosts: readonly string[], hosts: readonly string[]): string[] {
  if (!Array.isArray(hosts)) {
    throw new TypeError('uncoveredHosts: hosts must be an array of allowlisted host names');
  }
  return hosts.filter((host) => !sanCovers(sanHosts, host));
}

export interface TransportFlags {
  /** True when the core will bind/serve beyond loopback. */
  remote?: boolean;
  /** True when an https server is configured (cert + key loaded). */
  tls?: boolean;
}

export interface TransportRefusal {
  reason: 'remote_requires_tls';
}

/**
 * PLAN-M20 S6: a non-loopback bind without TLS is REFUSED. Only `remote:false`
 * proves local-only, and only `tls:true` counts as TLS, so an unset or
 * malformed flag fails closed.
 */
export function transportRefusal(flags: TransportFlags): TransportRefusal | null {
  const remote = flags?.remote !== false;
  const tls = flags?.tls === true;
  return remote && !tls ? { reason: 'remote_requires_tls' } : null;
}
