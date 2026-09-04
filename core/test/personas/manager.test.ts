/**
 * Persona manager tests (PLAN-M3.md): seed-on-first-run idempotent, CRUD with
 * validation + temperature clamp, the single-isDefault invariant (setting a
 * default moves the flag), last-default deletion refused (409 conflict), and
 * pause/resume semantics.
 */
import { describe, expect, it } from 'vitest';
import type { Persona } from '@partner/shared';
import { createPersonaStore, openDatabase, createAuditStore } from '../../src/stores/db.js';
import { auditLog } from '../../src/services/redaction.js';
import { createPersonaManager } from '../../src/personas/manager.js';
import type { PersonaManager } from '../../src/personas/manager.js';
import { PersonaError } from '../../src/personas/errors.js';

function makeManager(): { manager: PersonaManager; audit: ReturnType<typeof auditLog> } {
  const db = openDatabase(':memory:');
  const audit = auditLog({ store: createAuditStore(db) });
  const manager = createPersonaManager({ store: createPersonaStore(db), audit });
  return { manager, audit };
}

function defaultsOf(manager: PersonaManager): Persona[] {
  return manager.list().filter((p) => p.isDefault);
}

/** Run fn, expecting a PersonaError with the given code; returns nothing. */
function expectPersonaError(fn: () => void, code: string): void {
  let thrown: unknown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(PersonaError);
  expect((thrown as PersonaError).code).toBe(code);
}

describe('seedIfEmpty', () => {
  it('seeds the EIGHT starter personas on an empty table, idempotently', () => {
    const { manager } = makeManager();
    expect(manager.list()).toHaveLength(0);
    expect(manager.seedIfEmpty()).toBe(8);
    const once = manager.list();
    expect(once).toHaveLength(8);
    expect(once.map((p) => p.name)).toEqual([
      'Researcher',
      'Builder',
      'Studio',
      'Scribe',
      'Presenter',
      'Analyst',
      'Note-taker',
      'Default partner',
    ]);
    // Idempotent: a second seed run inserts nothing.
    expect(manager.seedIfEmpty()).toBe(0);
    expect(manager.list()).toHaveLength(8);
  });

  it('gives exactly one default — the Default partner — and the planned levels', () => {
    const { manager } = makeManager();
    manager.seedIfEmpty();
    const defaults = defaultsOf(manager);
    expect(defaults).toHaveLength(1);
    expect(defaults[0]?.name).toBe('Default partner');
    expect(defaults[0]?.paused).toBe(false);
    const byName = new Map(manager.list().map((p) => [p.name, p]));
    expect(byName.get('Researcher')?.independence.level).toBe('suggest');
    expect(byName.get('Builder')?.independence.level).toBe('auto');
    expect(byName.get('Studio')?.independence.level).toBe('assist');
  });
});

describe('persona CRUD', () => {
  it('creates with defaults, reads back, updates partial fields', () => {
    const { manager } = makeManager();
    const created = manager.create({
      name: 'Alma',
      tagline: 'sharp & warm',
      character: { voice: 'warm-professional', temperature: 0.5 },
      independence: { level: 'auto', autoScopes: ['files:read'] },
    });
    expect(created.id).toBeTruthy();
    expect(created).toMatchObject({
      name: 'Alma',
      tagline: 'sharp & warm',
      isDefault: false,
      paused: false,
    });
    // Filled defaults.
    expect(created.character.language).toBe('en');
    expect(created.character.systemPrompt).toBe('');
    expect(created.character.temperature).toBe(0.5);
    expect(created.independence.requireHumanFor).toEqual(['high']);
    expect(created.independence.autoScopes).toEqual(['files:read']);
    expect(created.memory).toEqual({ userProfile: 'none', episodes: 'none' });

    const got = manager.get(created.id);
    expect(got).toEqual(created);

    const updated = manager.update(created.id, {
      tagline: 'warmer',
      independence: { level: 'suggest' },
      memory: { userProfile: 'read' },
    });
    expect(updated.tagline).toBe('warmer');
    expect(updated.independence.level).toBe('suggest');
    expect(updated.memory.userProfile).toBe('read');
    expect(updated.character.temperature).toBe(0.5); // untouched
    expect(manager.get('nope')).toBeNull();
  });

  it('removes a non-default persona (row only — conversations keep ids)', () => {
    const { manager } = makeManager();
    manager.seedIfEmpty();
    const target = manager.create({ name: 'Temp' });
    expect(manager.list()).toHaveLength(9);
    manager.remove(target.id);
    expect(manager.get(target.id)).toBeNull();
    expect(manager.list()).toHaveLength(8);
    // Unknown remove -> typed not_found.
    expectPersonaError(() => manager.remove('nope'), 'not_found');
  });
});

describe('single-default invariant', () => {
  it('create(set isDefault) clears the previous default; exactly one default at a time', () => {
    const { manager } = makeManager();
    const a = manager.create({ name: 'A', isDefault: true });
    expect(manager.get(a.id)?.isDefault).toBe(true);
    const b = manager.create({ name: 'B' });
    expect(manager.get(b.id)?.isDefault).toBe(false);
    // Now make B default -> A loses the flag.
    const b2 = manager.create({ name: 'B2', isDefault: true });
    expect(manager.get(a.id)?.isDefault).toBe(false);
    expect(manager.get(b.id)?.isDefault).toBe(false);
    expect(manager.get(b2.id)?.isDefault).toBe(true);
    expect(defaultsOf(manager)).toHaveLength(1);
  });

  it('update(set isDefault true) moves the flag off the previous default', () => {
    const { manager } = makeManager();
    manager.seedIfEmpty();
    const researcher = manager.list().find((p) => p.name === 'Researcher') as Persona;
    const moved = manager.update(researcher.id, { isDefault: true });
    expect(moved.isDefault).toBe(true);
    expect(defaultsOf(manager)).toHaveLength(1);
    expect(defaultsOf(manager)[0]?.id).toBe(researcher.id);
    expect(manager.get('p-default')?.isDefault).toBe(false);
  });
});

describe('last-default deletion guard', () => {
  it('refuses to delete the persona holding the isDefault flag (409 conflict)', () => {
    const { manager } = makeManager();
    manager.seedIfEmpty();
    const defaultPersona = defaultsOf(manager)[0] as Persona;
    expectPersonaError(() => manager.remove(defaultPersona.id), 'conflict');
    expect(manager.get(defaultPersona.id)).not.toBeNull();
  });

  it('after the default flag moves elsewhere, the old default can be removed', () => {
    const { manager } = makeManager();
    manager.seedIfEmpty();
    const analyst = manager.list().find((p) => p.name === 'Analyst') as Persona;
    manager.update(analyst.id, { isDefault: true });
    manager.remove('p-default'); // no longer the default -> allowed
    expect(manager.get('p-default')).toBeNull();
    expect(defaultsOf(manager).map((p) => p.id)).toEqual([analyst.id]);
  });
});

describe('pause / resume', () => {
  it('pause flips state and isPaused follows; resume restores; audit rows exist', () => {
    const { manager, audit } = makeManager();
    manager.seedIfEmpty();
    expect(manager.isPaused('p-studio')).toBe(false);
    const paused = manager.pause('p-studio');
    expect(paused.paused).toBe(true);
    expect(manager.isPaused('p-studio')).toBe(true);
    const resumed = manager.resume('p-studio');
    expect(resumed.paused).toBe(false);
    expect(manager.isPaused('p-studio')).toBe(false);
    // Pausing an unknown persona -> typed not_found.
    expectPersonaError(() => manager.pause('nope'), 'not_found');
    expect(manager.isPaused('nope')).toBe(false);
    const actions = audit.list(100).map((r) => r.action);
    expect(actions).toContain('persona.pause');
    expect(actions).toContain('persona.resume');
  });
});

describe('validation + normalization', () => {
  it('rejects an empty name and an unknown independence level', () => {
    const { manager } = makeManager();
    expect(() => manager.create({ name: '   ' })).toThrowError(/name/);
    expect(() => manager.create({ name: 'X', independence: { level: 'rogue' as never } })).toThrowError(
      /independence.level/,
    );
    const created = manager.create({ name: 'OK' });
    expect(created.independence.level).toBe('assist');
  });

  it('clamps temperature into 0..2 and rejects non-numbers', () => {
    const { manager } = makeManager();
    const hot = manager.create({ name: 'Hot', character: { temperature: 7 } });
    expect(hot.character.temperature).toBe(2);
    const cold = manager.create({ name: 'Cold', character: { temperature: -3 } });
    expect(cold.character.temperature).toBe(0);
    expect(() =>
      manager.create({ name: 'NaN', character: { temperature: Number.NaN } }),
    ).toThrowError(/temperature/);
  });

  it('validates memory flags and requireHumanFor tiers', () => {
    const { manager } = makeManager();
    expect(() =>
      manager.create({ name: 'X', memory: { userProfile: 'write' as never } }),
    ).toThrowError(/memory.userProfile/);
    expect(() =>
      manager.create({ name: 'X', memory: { episodes: 'read' as never } }),
    ).toThrowError(/memory.episodes/);
    expect(() =>
      manager.create({ name: 'X', independence: { requireHumanFor: ['critical' as never] } }),
    ).toThrowError(/requireHumanFor/);
  });

  it('unknown update target throws not_found', () => {
    const { manager } = makeManager();
    expectPersonaError(() => manager.update('nope', { name: 'X' }), 'not_found');
  });
});
