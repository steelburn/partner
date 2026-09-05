import { describe, expect, it } from 'vitest';
import {
  auditLog,
  redactJson,
  redactString,
  redactValue,
} from '../src/services/redaction.js';
import type { AuditService } from '../src/services/redaction.js';
import { openDatabase } from '../src/stores/db.js';
import { createAuditStore } from '../src/stores/db.js';

describe('redaction helpers', () => {
  it('scrub sk- tokens, bearer headers and key assignments from strings', () => {
    const out = redactString(
      'token sk-live-ABCDEFGHIJ12345678 and Authorization: Bearer abc.def_123+/xyz= plus api_key=sk-proj-999988887777',
    );
    expect(out).not.toContain('sk-live-ABCDEFGHIJ12345678');
    expect(out).not.toContain('abc.def_123+/xyz=');
    expect(out).not.toContain('sk-proj-999988887777');
    expect(out).toContain('sk-***[redacted]');
  });

  it('scrubs PEM private-key blocks wholesale', () => {
    const pem = `-----BEGIN EC PRIVATE KEY-----\nMHQCAQEEIExampleBase64\n-----END EC PRIVATE KEY-----`;
    const out = redactString(`key material: ${pem} (end)`);
    expect(out).not.toContain('ExampleBase64');
    expect(out).not.toContain('BEGIN EC PRIVATE KEY');
    expect(out).toContain('redacted pem private key');
  });

  it('scrubs embedded JSON/header secret assignments inside strings', () => {
    const out = redactString(
      'payload {"client_secret":"aVeryLongSecretValue123","passwordCipher":"cipherBlobValue456789"} and apiKey=sk-proj-AAAABBBBCCCCDDDD',
    );
    expect(out).not.toContain('aVeryLongSecretValue123');
    expect(out).not.toContain('cipherBlobValue456789');
    expect(out).not.toContain('sk-proj-AAAABBBBCCCCDDDD');
    expect(out).toContain('client_secret'); // key name survives, value is gone
  });

  it('scrubs secret values in URL query strings but keeps benign params', () => {
    const out = redactString('https://x.dev/v1/chat?token=abc12345def&q=hello');
    expect(out).not.toContain('abc12345def');
    expect(out).toContain('q=hello');
  });

  it('prose that merely contains the word key/token is NOT mangled', () => {
    const out = redactString('monkey: banana and a key: thing and token bucket');
    expect(out).toBe('monkey: banana and a key: thing and token bucket');
  });

  it('redactValue replaces values under sensitive keys wholesale', () => {
    const out = redactValue({
      token: 'raw-token',
      nested: { password: 'p', ok: 'fine' },
      privateKey: 'pem-here',
      clientSecret: 'cs',
      credential: 'cred',
      passphrase: 'pp',
      passwordCipher: 'envelope',
      runId: 'keep-me',
    });
    expect(out).toEqual({
      token: '***[redacted]',
      nested: { password: '***[redacted]', ok: 'fine' },
      privateKey: '***[redacted]',
      clientSecret: '***[redacted]',
      credential: '***[redacted]',
      passphrase: '***[redacted]',
      passwordCipher: '***[redacted]',
      runId: 'keep-me',
    });
  });

  it('redactJson output never contains a secret', () => {
    const json = redactJson({ apiKey: 'sk-abc1234567890123', text: 'Bearer eyJhbGciOi.raw' });
    expect(json).not.toContain('sk-');
    expect(json).not.toContain('eyJhbGciOi.raw');
  });

  it('seeded call-site-shaped payloads never leak (provider/playbook/skill/deploy shapes)', () => {
    const json = redactJson({
      provider: { name: 'ne1', key: 'sk-live-0000111122223333', endpoint: 'https://x/v1' },
      run: { runId: 'r-1', status: 'done', error: 'upstream said Authorization: Bearer abcdefgh12345678' },
      skill: { id: 'hello', manifest: { network: false } },
      profile: { host: '10.0.0.1', env: '{"DATABASE_URL":"postgres://u:superSecretPass123@db/x"}' },
      ok: true,
    });
    expect(json).not.toContain('sk-live-0000111122223333');
    expect(json).not.toContain('abcdefgh12345678');
    expect(json).not.toContain('superSecretPass123');
    expect(json).toContain('r-1');
    expect(json).toContain('postgres://u:');
  });
});

describe('auditLog service', () => {
  function makeAudit(): { audit: AuditService; db: ReturnType<typeof openDatabase> } {
    const db = openDatabase(':memory:');
    return { audit: auditLog({ store: createAuditStore(db) }), db };
  }

  it('persists redacted details — secrets never reach the audit table', () => {
    const { audit } = makeAudit();
    audit.log('pair', 'pair.verify', 'web', {
      ok: true,
      apiKey: 'sk-proj-AAAABBBBCCCCDDDDEEEE',
      authorization: 'Bearer tok1234567890',
      note: 'hello',
    });

    const rows = audit.list(10);
    expect(rows).toHaveLength(1);
    const details = (rows[0] as NonNullable<(typeof rows)[0]>).details;
    expect(details).not.toContain('sk-proj-AAAABBBBCCCCDDDDEEEE');
    expect(details).not.toContain('tok1234567890');
    expect(details).toContain('***[redacted]');
    expect(details).toContain('hello');
  });

  it('orders newest first and honors the limit', () => {
    const { audit } = makeAudit();
    audit.log('a', 'first', 't', { n: 1 });
    audit.log('b', 'second', 't', { n: 2 });
    const rows = audit.list(1);
    expect(rows).toHaveLength(1);
    expect((rows[0] as NonNullable<(typeof rows)[0]>).action).toBe('second');
  });
});
