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

  it('redactValue replaces values under sensitive keys wholesale', () => {
    const out = redactValue({ token: 'raw-token', nested: { password: 'p', ok: 'fine' } });
    expect(out).toEqual({ token: '***[redacted]', nested: { password: '***[redacted]', ok: 'fine' } });
  });

  it('redactJson output never contains a secret', () => {
    const json = redactJson({ apiKey: 'sk-abc1234567890123', text: 'Bearer eyJhbGciOi.raw' });
    expect(json).not.toContain('sk-');
    expect(json).not.toContain('eyJhbGciOi.raw');
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
