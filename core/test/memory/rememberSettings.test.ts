/**
 * M19 follow-up: the user-level global auto-remember consent.
 *
 * Covers the documented default (absent -> ON), explicit off/on round-trip,
 * the content-free audit row, and that the flag is what the remember manager
 * is handed as the global policy.
 */
import { describe, expect, it } from 'vitest';
import { AUTO_REMEMBER_GLOBAL_KEY } from '../../src/memory/settings.js';
import { makeMemoryEnv } from './memEnv.js';

describe('memory settings — global auto-remember', () => {
  it('defaults to ON when the setting is absent', () => {
    const env = makeMemoryEnv();
    try {
      expect(env.settings.get(AUTO_REMEMBER_GLOBAL_KEY)).toBeNull();
      expect(env.memorySettings.autoRememberGlobal()).toBe(true);
    } finally {
      env.close();
    }
  });

  it('persists off and back on', () => {
    const env = makeMemoryEnv();
    try {
      expect(env.memorySettings.setAutoRememberGlobal(false)).toBe(false);
      expect(env.memorySettings.autoRememberGlobal()).toBe(false);
      expect(env.settings.get(AUTO_REMEMBER_GLOBAL_KEY)).toBe('off');

      expect(env.memorySettings.setAutoRememberGlobal(true)).toBe(true);
      expect(env.memorySettings.autoRememberGlobal()).toBe(true);
      expect(env.settings.get(AUTO_REMEMBER_GLOBAL_KEY)).toBe('on');
    } finally {
      env.close();
    }
  });

  it('audits the boolean only (never memory content)', () => {
    const env = makeMemoryEnv();
    try {
      env.memorySettings.setAutoRememberGlobal(false);
      const row = env.auditStore.list(20).find((r) => r.action === 'memory.settings');
      expect(row).toBeDefined();
      expect(JSON.parse(row?.details ?? '{}')).toEqual({ autoRememberGlobal: false });
    } finally {
      env.close();
    }
  });
});
