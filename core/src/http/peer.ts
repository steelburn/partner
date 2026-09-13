/**
 * Network-peer classification (M20-B S7) — PURE, no imports, no express.
 *
 * S7 splits `POST /v1/pair` in two:
 *  - the 6-digit `code` path is the LOCAL ceremony and is refused unless the
 *    request actually came from this machine;
 *  - the `secret` path (256-bit, single-use, issued for a QR/link) is for
 *    another device and may arrive from anywhere.
 *
 * The only trustworthy form of "came from this machine" is the SOCKET peer
 * address. It is deliberately NOT the `Host` header: PLAN-M20 §2.1 already
 * reclassified that as a client-supplied LOOKUP KEY, so a remote caller may
 * send `Host: 127.0.0.1:<port>` (the allowlist decides whether it is even
 * routed, and with remote access on there is no loopback entry to spoof).
 * A loopback Host header tells us nothing about where the bytes came from;
 * `socket.remoteAddress` does.
 *
 * Fail-closed: anything not recognisably loopback — missing, empty, a unix
 * socket, an IPv6 hex-mapped form, garbage — is NOT loopback. The two dead
 * ends this must never have are "accept a remote caller as local" and "throw
 * on an odd address", so every branch returns a boolean.
 *
 * What loopback does NOT mean: it is not proof of an *identity*. Any process
 * on the machine can reach the loopback listener; that is exactly the trust
 * level the 6-digit code already had, and why the code still has to be read
 * off the screen.
 */

/**
 * A dotted-quad in 127/8 with each octet range-checked (0-255). A regex
 * literal, so the `\d` classes cannot decay into `d` through a string-literal
 * escape.
 */
const LOOPBACK_V4 =
  /^127\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

/**
 * True only for an address the OS attributes to this machine's loopback
 * interface. `unknown` so an undefined `socket.remoteAddress` fails here
 * rather than at a call site.
 */
export function isLoopbackPeer(address: unknown): boolean {
  if (typeof address !== 'string') return false;
  let addr = address.trim().toLowerCase();
  if (addr === '') return false;
  // Zone index (`fe80::1%eth0`, `::1%lo0`) — strip it before comparison.
  const zone = addr.indexOf('%');
  if (zone !== -1) addr = addr.slice(0, zone);
  // Some servers report IPv6 with brackets.
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  // IPv4-mapped IPv6: node reports `::ffff:127.0.0.1` for an IPv4 peer.
  if (addr.startsWith('::ffff:')) addr = addr.slice('::ffff:'.length);
  if (addr === '::1' || addr === 'localhost') return true;
  // 127.0.0.0/8 — the whole loopback block, not just 127.0.0.1. Octets are
  // validated (0-255), so `127.0.0.256` is not "close enough" to loopback.
  return LOOPBACK_V4.test(addr);
}

/**
 * Is `address` inside one of `cidrs`? PURE, IPv4-only CIDRs plus exact IPv6.
 *
 * R4: this decides whose `CF-Connecting-IP`-style header may be believed. An
 * unparsable entry is NOT "no match that happens to work" — it is a refusal
 * (`false`), because a typo in a trusted-proxy list must fail closed. The list
 * itself is validated at boot (`config.ts`), so in practice a malformed entry
 * never reaches here.
 *
 * WHY IPv4-ONLY PREFIXES: the real deployment is a docker bridge
 * (172.16.0.0/12) talking to a loopback-bound core, so prefix matching over
 * 4-octet addresses covers it. IPv6 is accepted as an EXACT address (::1), not as
 * a prefix, rather than shipping a half-tested 128-bit mask.
 */
export function isIpInCidrs(address: unknown, cidrs: readonly string[]): boolean {
  if (typeof address !== 'string' || address.length === 0 || !Array.isArray(cidrs)) return false;
  let candidate = address.trim().toLowerCase();
  if (candidate.startsWith('::ffff:')) candidate = candidate.slice('::ffff:'.length);
  if (candidate === '') return false;

  for (const raw of cidrs) {
    if (typeof raw !== 'string') continue;
    const entry = raw.trim().toLowerCase();
    if (entry === '') continue;
    const slash = entry.indexOf('/');
    if (slash === -1) {
      // Exact address (IPv4 or IPv6). `::1` covers IPv4 loopback via the mapping above.
      if (entry === candidate) return true;
      if (entry === '::1' && candidate.startsWith('127.')) return true;
      continue;
    }
    const base = entry.slice(0, slash);
    const bits = Number.parseInt(entry.slice(slash + 1), 10);
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    const toInt = (value: string): number | null => {
      const parts = value.split('.');
      if (parts.length !== 4) return null;
      let out = 0;
      for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const octet = Number.parseInt(part, 10);
        if (octet > 255) return null;
        out = (out << 8) | octet;
      }
      return out >>> 0;
    };
    const net = toInt(base);
    const ip = toInt(candidate);
    if (net === null || ip === null) continue;
    // A /0 prefix must match everything, so guard the shift.
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((net & mask) === (ip & mask)) return true;
  }
  return false;
}

/**
 * The bucket key for a request's rate limit (R4).
 *
 * The SOCKET PEER is the default and the fallback. A trusted proxy may report the
 * real client in a header, and the header is believed ONLY when the socket peer
 * is inside `trustedCidrs` — otherwise any caller could mint unlimited buckets by
 * inventing header values, which is worse than one shared bucket. An empty or
 * malformed header value also falls back to the peer.
 */
export function rateLimitKeyFor(input: {
  peer: string | undefined;
  headerValue: unknown;
  trustedCidrs: readonly string[];
}): string {
  const peer = typeof input.peer === 'string' ? input.peer : '';
  const header =
    typeof input.headerValue === 'string' && input.headerValue.trim() !== ''
      ? input.headerValue.trim().toLowerCase()
      : '';
  if (header !== '' && isIpInCidrs(peer, input.trustedCidrs)) return header;
  return peer;
}
