/**
 * RSA-OAEP password envelope for the llm-self-service import (S0 recipe,
 * PLAN-S0.md "Client recipe"; mirrors llm-self-service's portal login.ts):
 *
 *   importKey('spki', der, { name: 'RSA-OAEP', hash: 'SHA-256' }, false,
 *             ['encrypt'])
 *     -> encrypt({ name: 'RSA-OAEP' }, key, plaintext)
 *     -> base64 ciphertext
 *
 * This module runs in the BROWSER only — it needs WebCrypto
 * (globalThis.crypto.subtle). The plaintext password exists only inside the
 * `password` argument for the duration of the encrypt call; nothing here
 * logs, stores, or transmits it.
 *
 * Why unit tests inject a fake instead of running real WebCrypto: the test
 * suite runs under vitest's plain 'node' environment (no DOM, no jsdom), and
 * this module deliberately targets the browser's SubtleCrypto. Exercising a
 * real RSA-OAEP keypair in node adds no signal — it would test the platform,
 * not our code. The pure, deterministic parts (PEM -> DER, ArrayBuffer ->
 * base64, the exact importKey/encrypt argument recipe) are tested with a
 * recorded fake; byte-for-byte envelope parity against the S0 server is the
 * core lane's integration test, which runs Node's own crypto.subtle against
 * the fake llm-self-service double (PLAN-M1.md test 16).
 */

/** The RSA-OAEP subset of SubtleCrypto this module needs (browser impl). */
export interface EnvelopeSubtle {
  importKey(
    format: 'spki',
    keyData: BufferSource,
    algorithm: { name: 'RSA-OAEP'; hash: 'SHA-256' },
    extractable: boolean,
    keyUsages: Array<'encrypt'>,
  ): Promise<CryptoKey>;
  encrypt(
    algorithm: { name: 'RSA-OAEP' },
    key: CryptoKey,
    data: BufferSource,
  ): Promise<ArrayBuffer>;
}

/**
 * Browser WebCrypto, resolved lazily at call time. Throws a clear error when
 * crypto is unavailable (never a raw TypeError) — the import card surfaces
 * that message to the user.
 */
function defaultEnvelopeSubtle(): EnvelopeSubtle {
  const cryptoLike = globalThis as { crypto?: { subtle?: unknown } };
  const subtle = cryptoLike.crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'WebCrypto is not available in this browser, so the password cannot be encrypted locally.',
    );
  }
  // Browser SubtleCrypto implements the RSA-OAEP/SHA-256 subset we call.
  return subtle as EnvelopeSubtle;
}

/** Strip PEM armor and decode the base64 body to DER bytes (SPKI key data). */
export function pemToDer(pem: string): ArrayBuffer {
  const body = pem
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\s+/g, '');
  if (body.length === 0) throw new Error('The public key is empty.');
  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

/** Encode an ArrayBuffer as base64 (chunked to avoid call-stack limits). */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK_SIZE = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + CHUNK_SIZE));
  }
  return btoa(binary);
}

/**
 * Encrypt `password` with the PEM public key from the self-service
 * `/api/login-key` endpoint (S0). Returns the base64 ciphertext that the core
 * forwards to `POST {endpoint}/api/session` — never the plaintext.
 *
 * `subtle` is injectable for tests; in the browser it defaults to
 * `globalThis.crypto.subtle`.
 */
export async function encryptPasswordWithPublicKey(
  pem: string,
  password: string,
  subtle: EnvelopeSubtle = defaultEnvelopeSubtle(),
): Promise<string> {
  const der = pemToDer(pem);
  const key = await subtle.importKey(
    'spki',
    der,
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt'],
  );
  const ciphertext = await subtle.encrypt(
    { name: 'RSA-OAEP' },
    key,
    new TextEncoder().encode(password),
  );
  return arrayBufferToBase64(ciphertext);
}
