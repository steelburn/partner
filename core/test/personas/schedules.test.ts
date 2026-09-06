/**
 * M14 persona schedule round-trip (PLAN-M14.md S2) — the persona manager
 * stores independence.schedules in the flattened personas.schedules JSON
 * column; create/update/list/get/row all carry it; content never crosses
 * audit (counts only).
 */
import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { Persona, PersonaSchedule } from '@partner/shared';
import {
  createAuditStore,
  createPersonaStore,
  openDatabase,
} from '../../src/stores/db.js';
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

const brief = (id: string): PersonaSchedule => ({
  id,
  label: 'Morning brief',
  when: { kind: 'daily', hour: 8, minute: 0 },
  prompt: 'Summarise yesterday and plan today.',
  enabled: true,
});

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

describe('M14 persona schedules round-trip', () => {
  it('stores schedules on create and reads them back on get/list', () => {
    const { manager } = makeManager();
    const persona = manager.create({
      name: 'Night owl',
      independence: { level: 'autonomous', schedules: [brief('s-1')] },
    });
    expect(persona.independence.schedules).toEqual([brief('s-1')]);

    const again = manager.get(persona.id);
    expect(again?.independence.schedules).toEqual([brief('s-1')]);
    const listed = manager.list().find((p) => p.id === persona.id);
    expect(listed?.independence.schedules).toEqual([brief('s-1')]);
  });

  it('patch merges: absent schedules keep the current set; [] clears', () => {
    const { manager } = makeManager();
    const persona = manager.create({
      name: 'Night owl',
      independence: { level: 'auto', schedules: [brief('s-1')] },
    });

    // Patch touching only level must NOT wipe schedules.
    const leveled = manager.update(persona.id, { independence: { level: 'autonomous' } });
    expect(leveled.independence.schedules).toEqual([brief('s-1')]);
    expect(leveled.independence.level).toBe('autonomous');

    // Replace wholesale.
    const second = brief('s-2');
    const replaced = manager.update(persona.id, {
      independence: { schedules: [second] },
    });
    expect(replaced.independence.schedules).toEqual([second]);

    // Explicit empty array clears.
    const cleared = manager.update(persona.id, { independence: { schedules: [] } });
    expect(cleared.independence.schedules).toBeUndefined();
    expect(manager.get(persona.id)?.independence.schedules).toBeUndefined();
  });

  it('validates schedules on write with typed invalid_input', () => {
    const { manager } = makeManager();
    const persona = manager.create({ name: 'Strict' });
    expectPersonaError(
      () =>
        manager.update(persona.id, {
          independence: { schedules: [{ ...brief('s-1'), when: { kind: 'cron' } } as unknown as PersonaSchedule] },
        }),
      'invalid_input',
    );
    // Duplicate ids rejected.
    expectPersonaError(
      () =>
        manager.update(persona.id, {
          independence: { schedules: [brief('s-1'), { ...brief('s-1'), label: 'x' }] },
        }),
      'invalid_input',
    );
  });

  it('persists the JSON column on the row and tolerates corrupt stored JSON', () => {
    const db = openDatabase(':memory:');
    const store = createPersonaStore(db);
    const audit = auditLog({ store: createAuditStore(db) });
    const manager = createPersonaManager({ store, audit });
    const persona = manager.create({
      name: 'Round-trip',
      independence: { level: 'auto', schedules: [brief('s-1')] },
    });
    expect(store.findById(persona.id)?.schedules).toContain('Morning brief');
    // corrupt the column behind the manager's back — reads must not crash
    db.prepare('UPDATE personas SET schedules = ? WHERE id = ?').run('{not json', persona.id);
    const reread = manager.get(persona.id);
    expect(reread).not.toBeNull();
    expect(reread?.independence.schedules).toBeUndefined();
  });

  it('audits schedule counts only — never label or prompt content', () => {
    const { manager, audit } = makeManager();
    manager.create({
      name: 'Audited',
      independence: { level: 'auto', schedules: [brief('s-1')] },
    });
    const rows = audit.list(50);
    const createRow = rows.find((r) => r.action === 'persona.create');
    expect(createRow).toBeDefined();
    const details = JSON.parse(createRow?.details ?? '{}');
    expect(details.scheduleCount).toBe(1);
    const serialized = JSON.stringify(rows);
    expect(serialized).not.toContain('Morning brief');
    expect(serialized).not.toContain('Summarise yesterday');
  });

  it('seeded starter personas carry no schedules', () => {
    const { manager } = makeManager();
    manager.seedIfEmpty();
    for (const persona of manager.list()) {
      expect(persona.independence.schedules).toBeUndefined();
    }
  });

  it('round-trips a full persona JSON bundle through update', () => {
    const { manager } = makeManager();
    const created = manager.create({
      name: 'Full',
      independence: {
        level: 'autonomous',
        schedules: [
          { ...brief('s-a'), saveNote: true, maxRounds: 3, tz: 'America/New_York' },
          {
            id: randomUUID().slice(0, 8),
            label: 'Weekly digest',
            when: { kind: 'weekly', weekday: 6, hour: 9, minute: 15 },
            prompt: 'Weekly review.',
          },
        ],
      },
    });
    const snapshot = JSON.parse(JSON.stringify(created)) as Persona;
    const restored = manager.update(created.id, {
      independence: { schedules: snapshot.independence.schedules },
    });
    expect(restored.independence.schedules).toEqual(snapshot.independence.schedules);
  });
});
