import { describe, it, expect } from 'vitest';
import { redactString, redactValue, redactJson } from '../src/redact.js';

describe('redactString', () => {
  it('scrubs sk- API key tokens', () => {
    const out = redactString('used key sk-abcdef1234567890 to call the model');
    expect(out).not.toContain('sk-abcdef1234567890');
    expect(out).toContain('sk-***[redacted]');
  });

  it('scrubs bearer tokens', () => {
    const out = redactString('Authorization: Bearer abc.def-ghi_123+/xyz=');
    expect(out).not.toContain('abc.def-ghi_123+/xyz=');
    expect(out).toContain('Bearer ***[redacted]');
  });

  it('scrubs api key assignments', () => {
    const out = redactString('config api_key: sk-live-ABCDEFGH12345678 end');
    expect(out).not.toContain('sk-live-ABCDEFGH12345678');
  });
});

describe('redactValue / redactJson', () => {
  it('deep-scrubs sensitive keys in nested records', () => {
    const input = {
      user: 'alice',
      apiKey: 'sk-1234567890abcdef',
      nested: { passwordCipher: 'ciphertext', ok: true },
      notes: 'no secret',
    };
    const out = redactValue(input) as Record<string, unknown>;
    expect(out.apiKey).toBe('***[redacted]');
    expect((out.nested as Record<string, unknown>).passwordCipher).toBe('***[redacted]');
    expect(out.user).toBe('alice');
  });

  it('redacts key material inside arbitrary strings in a record', () => {
    const out = redactJson({ message: 'my key is sk-1234567890abcdef!!' });
    expect(out).not.toContain('sk-1234567890abcdef');
    expect(JSON.parse(out).message).toContain('[redacted]');
  });

  it('leaves plain values and null alone', () => {
    expect(redactValue(null)).toBeNull();
    expect(redactValue(42)).toBe(42);
    expect(redactValue(true)).toBe(true);
  });
});
