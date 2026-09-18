/**
 * M19 follow-up: user-level consent for GLOBAL automatic remember.
 *
 * Global facts (M33: an EMPTY `personaScopes` array) tailor EVERY persona, so noticing them
 * is a user-level choice, not a per-persona one. This setting answers only
 * "may the partner propose global facts?". Persona-scoped detection stays
 * gated on that persona's `memory.personaMemory` flag (M19).
 *
 * Storage: the shared `settings` key-value table — no schema change. An
 * absent value reads as ON: findings only ever arrive as visible,
 * confirmable `suggested` entries, and nothing tailors a reply until the
 * user confirms it. Turning it OFF stops global extraction entirely.
 *
 * Audit rows carry the boolean only — never memory content.
 */
import type { AuditService } from '../services/redaction.js';
import type { SettingsStore } from '../stores/types.js';

/** Settings key holding 'on' | 'off' (absent = on). */
export const AUTO_REMEMBER_GLOBAL_KEY = 'memory.autoRemember.global';

export interface MemorySettings {
  /** True unless explicitly turned off (the documented default). */
  autoRememberGlobal(): boolean;
  /** Persist the choice; returns the stored value. */
  setAutoRememberGlobal(on: boolean): boolean;
}

export interface MemorySettingsOptions {
  settings: SettingsStore;
  audit: AuditService;
  /** Injectable clock (epoch ms). */
  now?: () => number;
}

export function createMemorySettings(options: MemorySettingsOptions): MemorySettings {
  const { settings, audit } = options;
  const now = options.now ?? Date.now;

  function autoRememberGlobal(): boolean {
    return settings.get(AUTO_REMEMBER_GLOBAL_KEY) !== 'off';
  }

  function setAutoRememberGlobal(on: boolean): boolean {
    settings.set(AUTO_REMEMBER_GLOBAL_KEY, on ? 'on' : 'off', now());
    audit.log('web', 'memory.settings', AUTO_REMEMBER_GLOBAL_KEY, {
      autoRememberGlobal: on,
    });
    return on;
  }

  return { autoRememberGlobal, setAutoRememberGlobal };
}
