import { describe, expect, it } from 'vitest';
import { isIpInCidrs, isLoopbackPeer, rateLimitKeyFor } from '../../src/http/peer.js';

describe('isLoopbackPeer', () => {
  it('accepts the forms a loopback socket actually reports', () => {
    for (const address of [
      '127.0.0.1',
      '::1',
      '::ffff:127.0.0.1', // node's IPv4-mapped form
      '127.1.2.3', // the whole 127/8 block
      'localhost',
      '  127.0.0.1  ',
      '[::1]',
      '::1%lo0',
    ]) {
      expect(isLoopbackPeer(address), address).toBe(true);
    }
  });

  it('refuses everything that is not demonstrably loopback (fail closed)', () => {
    for (const address of [
      '192.168.1.20',
      '10.0.0.5',
      '203.0.113.9',
      '0.0.0.0',
      '::',
      'fe80::1',
      '2001:db8::1',
      '::ffff:192.168.1.20',
      '127.0.0.256', // not a real octet
      '127.0.0',
      'localhost.evil.com',
      '127.0.0.1.evil.com',
      '',
      '   ',
      undefined,
      null,
      42,
      {},
    ]) {
      expect(isLoopbackPeer(address), String(address)).toBe(false);
    }
  });

  it('never throws on a hostile or odd value', () => {
    expect(() => isLoopbackPeer(new Proxy({}, { get: () => { throw new Error('nope'); } }))).not.toThrow();
  });
});

describe('isIpInCidrs (R4 — whose header may be believed)', () => {
  it('matches IPv4 CIDRs, including the docker bridge range', () => {
    expect(isIpInCidrs('172.18.0.4', ['172.16.0.0/12'])).toBe(true);
    expect(isIpInCidrs('172.31.255.1', ['172.16.0.0/12'])).toBe(true);
    expect(isIpInCidrs('172.32.0.1', ['172.16.0.0/12'])).toBe(false);
    expect(isIpInCidrs('10.0.0.5', ['10.0.0.0/8'])).toBe(true);
    expect(isIpInCidrs('192.168.1.1', ['10.0.0.0/8'])).toBe(false);
  });

  it('handles the IPv4-mapped form node reports and exact IPv6', () => {
    expect(isIpInCidrs('::ffff:172.18.0.4', ['172.16.0.0/12'])).toBe(true);
    expect(isIpInCidrs('::1', ['::1'])).toBe(true);
    expect(isIpInCidrs('127.0.0.1', ['::1'])).toBe(true);
  });

  it('treats /0 as everything and an unparsable entry as nothing', () => {
    expect(isIpInCidrs('8.8.8.8', ['0.0.0.0/0'])).toBe(true);
    expect(isIpInCidrs('8.8.8.8', ['not-a-cidr', '10.0.0.0/99'])).toBe(false);
    expect(isIpInCidrs(undefined, ['10.0.0.0/8'])).toBe(false);
  });
});

describe('rateLimitKeyFor', () => {
  it('uses the socket peer by default', () => {
    expect(rateLimitKeyFor({ peer: '172.18.0.4', headerValue: '203.0.113.9', trustedCidrs: [] })).toBe(
      '172.18.0.4',
    );
  });

  it('believes the header ONLY from a trusted proxy', () => {
    expect(
      rateLimitKeyFor({
        peer: '172.18.0.4',
        headerValue: '203.0.113.9',
        trustedCidrs: ['172.16.0.0/12'],
      }),
    ).toBe('203.0.113.9');
    // An untrusted peer cannot mint buckets by inventing a header.
    expect(
      rateLimitKeyFor({
        peer: '198.51.100.7',
        headerValue: '203.0.113.9',
        trustedCidrs: ['172.16.0.0/12'],
      }),
    ).toBe('198.51.100.7');
    // A blank header from a trusted proxy also falls back.
    expect(
      rateLimitKeyFor({ peer: '172.18.0.4', headerValue: '  ', trustedCidrs: ['172.16.0.0/12'] }),
    ).toBe('172.18.0.4');
  });
});
