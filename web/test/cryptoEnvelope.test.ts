import { describe, expect, it, vi } from 'vitest';
import {
  arrayBufferToBase64,
  encryptPasswordWithPublicKey,
  pemToDer,
  type EnvelopeSubtle,
} from '../src/lib/cryptoEnvelope.js';

/**
 * Why the real WebCrypto path is not exercised here: the test suite runs in
 * vitest's plain 'node' environment and cryptoEnvelope targets the browser's
 * SubtleCrypto (globalThis.crypto.subtle). Real RSA-OAEP encryption in node
 * would test the platform, not this module — so the deterministic pieces and
 * the exact argument recipe are asserted against a recorded fake. Byte-for-
 * byte envelope parity against the S0 server belongs to the core lane's
 * integration tests (PLAN-M1.md test 16).
 */

/** A small fake key so the fake subtle can hand back a non-null CryptoKey. */
const FAKE_KEY = {} as CryptoKey;

function bytesOf(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function fakeSubtle(): {
  subtle: EnvelopeSubtle;
  importKeyCalls: Array<Record<string, unknown>>;
  encryptCalls: Array<{ algorithm: unknown; data: Uint8Array }>;
  ciphertext: Uint8Array;
} {
  const ciphertext = bytesOf(1, 2, 3, 4, 5);
  const importKeyCalls: Array<Record<string, unknown>> = [];
  const encryptCalls: Array<{ algorithm: unknown; data: Uint8Array }> = [];
  const subtle: EnvelopeSubtle = {
    importKey: async (format, keyData, algorithm, extractable, keyUsages) => {
      importKeyCalls.push({ format, keyData, algorithm, extractable, keyUsages });
      return FAKE_KEY;
    },
    encrypt: async (algorithm, key, data) => {
      encryptCalls.push({ algorithm, data: new Uint8Array(data as ArrayBuffer) });
      expect(key).toBe(FAKE_KEY);
      return ciphertext.buffer.slice(0) as ArrayBuffer;
    },
  };
  return { subtle, importKeyCalls, encryptCalls, ciphertext };
}

function pemWithBody(bodyBase64: string): string {
  return `-----BEGIN PUBLIC KEY-----\n${bodyBase64}\n-----END PUBLIC KEY-----`;
}

describe('pemToDer', () => {
  it('strips PEM armor and decodes the base64 body to DER bytes', () => {
    const body = Uint8Array.from({ length: 48 }, (_, index) => index);
    let binary = '';
    for (const value of body) binary += String.fromCharCode(value);
    const pem = pemWithBody(btoa(binary));
    const der = new Uint8Array(pemToDer(pem));
    expect(Array.from(der)).toEqual(Array.from(body));
  });

  it('tolerates newlines anywhere in the armor', () => {
    const body = Uint8Array.from({ length: 48 }, (_, index) => index);
    let binary = '';
    for (const value of body) binary += String.fromCharCode(value);
    const wrapped = btoa(binary).replace(/(.{16})/g, '$1\n');
    const pem = `-----BEGIN PUBLIC KEY-----\n\n${wrapped}\n-----END PUBLIC KEY-----`;
    const der = new Uint8Array(pemToDer(pem));
    expect(Array.from(der)).toEqual(Array.from(body));
  });

  it('throws a clear error on an empty PEM', () => {
    expect(() => pemToDer('   ')).toThrow('The public key is empty.');
  });
});

describe('arrayBufferToBase64', () => {
  it('encodes known byte sequences', () => {
    expect(arrayBufferToBase64(bytesOf(1, 2, 3).buffer as ArrayBuffer)).toBe('AQID');
    expect(arrayBufferToBase64(bytesOf(0xff, 0x00).buffer as ArrayBuffer)).toBe('/wA=');
    expect(arrayBufferToBase64(bytesOf(104, 105).buffer as ArrayBuffer)).toBe('aGk=');
    expect(arrayBufferToBase64(new ArrayBuffer(0))).toBe('');
  });

  it('round-trips larger buffers (chunked encoding path)', () => {
    const input = new Uint8Array(70_000);
    for (let index = 0; index < input.length; index += 1) input[index] = index % 251;
    const encoded = arrayBufferToBase64(input.buffer as ArrayBuffer);
    // Decode back and compare.
    const binary = atob(encoded);
    const decoded = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      decoded[index] = binary.charCodeAt(index);
    }
    expect(Array.from(decoded)).toEqual(Array.from(input));
  });
});

describe('encryptPasswordWithPublicKey', () => {
  it('imports the SPKI key with RSA-OAEP/SHA-256 and encrypts with the exact recipe', async () => {
    const body = Uint8Array.from({ length: 48 }, (_, index) => index);
    let binary = '';
    for (const value of body) binary += String.fromCharCode(value);
    const pem = pemWithBody(btoa(binary));
    const { subtle, importKeyCalls, encryptCalls, ciphertext } = fakeSubtle();

    const result = await encryptPasswordWithPublicKey(pem, 's3cret', subtle);

    expect(importKeyCalls).toHaveLength(1);
    const call = importKeyCalls[0];
    expect(call?.format).toBe('spki');
    expect(Array.from(new Uint8Array(call?.keyData as ArrayBuffer))).toEqual(Array.from(body));
    expect(call?.algorithm).toEqual({ name: 'RSA-OAEP', hash: 'SHA-256' });
    expect(call?.extractable).toBe(false);
    expect(call?.keyUsages).toEqual(['encrypt']);

    expect(encryptCalls).toHaveLength(1);
    expect(encryptCalls[0]?.algorithm).toEqual({ name: 'RSA-OAEP' });
    expect(Array.from(encryptCalls[0]?.data ?? [])).toEqual(Array.from(new TextEncoder().encode('s3cret')));

    expect(result).toBe(arrayBufferToBase64(ciphertext.buffer as ArrayBuffer));
  });

  it('propagates a failing importKey without touching the password', async () => {
    const subtle: EnvelopeSubtle = {
      importKey: async () => {
        throw new Error('bad key data');
      },
      encrypt: async () => {
        throw new Error('must not be called');
      },
    };
    await expect(
      encryptPasswordWithPublicKey('-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----', 'pw', subtle),
    ).rejects.toThrow('bad key data');
  });

  it('never logs or returns the plaintext (result is base64 ciphertext only)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const body = Uint8Array.from({ length: 48 }, (_, index) => index);
      let binary = '';
      for (const value of body) binary += String.fromCharCode(value);
      const { subtle, ciphertext } = fakeSubtle();
      const result = await encryptPasswordWithPublicKey(
        pemWithBody(btoa(binary)),
        'super-secret-password',
        subtle,
      );
      expect(result).not.toContain('super-secret-password');
      expect(result).toBe(arrayBufferToBase64(ciphertext.buffer as ArrayBuffer));
    } finally {
      logSpy.mockRestore();
    }
  });
});
