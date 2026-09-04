import { describe, expect, it } from 'vitest';
import {
  SENSITIVE_REFUSAL,
  needsSensitiveRefusal,
} from '../src/lib/act.js';

describe('needsSensitiveRefusal (content.ts mirrors inline)', () => {
  it('refuses fill/click while a password field is active and not opted in', () => {
    expect(needsSensitiveRefusal({ hasActivePasswordField: true })).toBe(SENSITIVE_REFUSAL);
    expect(needsSensitiveRefusal({ hasActivePasswordField: true, allowSensitive: false })).toBe(
      SENSITIVE_REFUSAL,
    );
  });

  it('allows when allowSensitive is explicitly true', () => {
    expect(needsSensitiveRefusal({ hasActivePasswordField: true, allowSensitive: true })).toBeNull();
  });

  it('allows on pages without a password field', () => {
    expect(needsSensitiveRefusal({ hasActivePasswordField: false })).toBeNull();
    expect(needsSensitiveRefusal({ hasActivePasswordField: false, allowSensitive: false })).toBeNull();
  });

  it('treats undefined allowSensitive as false (default flows never set it)', () => {
    expect(needsSensitiveRefusal({ hasActivePasswordField: true, allowSensitive: undefined })).toBe(
      SENSITIVE_REFUSAL,
    );
  });

  it('reason is a stable, documented token', () => {
    expect(SENSITIVE_REFUSAL).toBe('sensitive_page');
  });
});
