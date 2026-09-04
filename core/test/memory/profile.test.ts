/**
 * M4 profile manager tests (PLAN-M4.md §"Tests"): status defaults by source
 * (partner_suggestion -> suggested, user -> confirmed), status transitions
 * (rejected -> confirmed allowed), validation (empty value / bad kind), list
 * filters rejected out unless asked, persona scoping, and audit rows that
 * carry ids/kind/lengths but NEVER content.
 */
import { describe, expect, it } from 'vitest';
import type { ProfileEntry } from '@partner/shared';
import { MemoryError } from '../../src/memory/index.js';
import { makeMemoryEnv } from './memEnv.js';
import type { MemoryTestEnv } from './memEnv.js';

describe('profile manager — add + status defaults', () => {
  it('user entries default to confirmed; partner suggestions default to suggested', () => {
    const env = makeMemoryEnv();
    try {
      const mine = env.profile.add({ kind: 'preference', value: 'tldr first, detail on request' });
      expect(mine.status).toBe('confirmed');
      expect(mine.source).toBe('user');

      const suggested = env.profile.add({
        kind: 'style',
        value: 'you write short bullets',
        source: 'partner_suggestion',
        evidence: 'observed in 3 asks',
      });
      expect(suggested.status).toBe('suggested');
      expect(suggested.source).toBe('partner_suggestion');
      expect(suggested.evidence).toBe('observed in 3 asks');

      const both = env.profile.list();
      expect(both.map((e) => e.id)).toEqual([mine.id, suggested.id]);
    } finally {
      env.close();
    }
  });

  it('explicit status/kind/key/personaScope are honored and normalized', () => {
    const env = makeMemoryEnv();
    try {
      const entry = env.profile.add({
        kind: 'rule',
        key: 'language',
        value: '  Always reply in German  ',
        status: 'suggested',
        personaScope: 'p-scribe',
      });
      expect(entry).toMatchObject({
        kind: 'rule',
        key: 'language',
        value: 'Always reply in German',
        status: 'suggested',
        personaScope: 'p-scribe',
      });
      expect(entry.personaScope).toBe('p-scribe');
    } finally {
      env.close();
    }
  });

  it('validation: bad kind, empty value, bad status, bad source -> invalid_input', () => {
    const env = makeMemoryEnv();
    try {
      const cases: Array<[string, unknown]> = [
        ['bad kind', { kind: 'fact', value: 'x' }],
        ['missing kind', { value: 'x' }],
        ['empty value', { kind: 'rule', value: '   ' }],
        ['non-string value', { kind: 'rule', value: 42 }],
        ['bad status', { kind: 'rule', value: 'x', status: 'maybe' }],
        ['bad source', { kind: 'rule', value: 'x', source: 'bot' }],
      ];
      for (const [label, input] of cases) {
        try {
          env.profile.add(input as never);
          expect.unreachable(`should throw for ${label}`);
        } catch (err) {
          expect(err, label).toBeInstanceOf(MemoryError);
          expect((err as MemoryError).code, label).toBe('invalid_input');
        }
      }
      expect(env.profile.list()).toHaveLength(0);
    } finally {
      env.close();
    }
  });
});

describe('profile manager — update/status lifecycle + scoping', () => {
  it('rejected -> confirmed transition and value edits round-trip', () => {
    const env = makeMemoryEnv();
    try {
      const entry = env.profile.add({
        kind: 'style',
        value: 'terse replies',
        source: 'partner_suggestion',
      });
      const rejected = env.profile.update(entry.id, { status: 'rejected' });
      expect(rejected.status).toBe('rejected');

      // rejected -> confirmed (user overrides the partner).
      const confirmed = env.profile.update(entry.id, { status: 'confirmed', value: 'warm but terse replies' });
      expect(confirmed.status).toBe('confirmed');
      expect(confirmed.value).toBe('warm but terse replies');
      expect(confirmed.kind).toBe('style');
    } finally {
      env.close();
    }
  });

  it('update unknown id -> not_found', () => {
    const env = makeMemoryEnv();
    try {
      try {
        env.profile.update('ghost', { status: 'confirmed' });
        expect.unreachable('should throw');
      } catch (err) {
        expect((err as MemoryError).code).toBe('not_found');
      }
      try {
        env.profile.remove('ghost');
        expect.unreachable('should throw');
      } catch (err) {
        expect((err as MemoryError).code).toBe('not_found');
      }
    } finally {
      env.close();
    }
  });

  it('list hides rejected unless includeRejected, and scopes by persona', () => {
    const env = makeMemoryEnv();
    try {
      const global = env.profile.add({ kind: 'preference', value: 'global fact' });
      const scribe = env.profile.add({ kind: 'identity', value: 'scribe fact', personaScope: 'p-scribe' });
      const builder = env.profile.add({ kind: 'identity', value: 'builder fact', personaScope: 'p-builder' });
      const rejected = env.profile.add({
        kind: 'rule',
        value: 'dead rule',
        source: 'partner_suggestion',
        status: 'rejected',
      });

      // Default list: confirmed+suggested only, all scopes.
      expect(env.profile.list().map((e) => e.id).sort()).toEqual(
        [global.id, scribe.id, builder.id].sort(),
      );
      // includeRejected surfaces the rejected entry.
      expect(env.profile.list({ includeRejected: true }).map((e) => e.id)).toContain(rejected.id);
      // Persona scope = global + that persona's entries.
      expect(env.profile.list({ personaScope: 'p-scribe' }).map((e) => e.id).sort()).toEqual(
        [global.id, scribe.id].sort(),
      );
      expect(env.profile.list({ personaScope: 'p-builder' }).map((e) => e.id).sort()).toEqual(
        [global.id, builder.id].sort(),
      );
    } finally {
      env.close();
    }
  });

  it('remove deletes the row and un-indexes it from FTS', () => {
    const env = makeMemoryEnv();
    try {
      const entry = env.profile.add({ kind: 'preference', value: 'unique-snowflake-fact' });
      expect(env.search.query('snowflake')).toHaveLength(1);
      env.profile.remove(entry.id);
      expect(env.profile.get(entry.id)).toBeNull();
      expect(env.search.query('snowflake')).toHaveLength(0);
    } finally {
      env.close();
    }
  });

  it('a rejected entry is not searchable but reappears after confirming', () => {
    const env = makeMemoryEnv();
    try {
      const entry = env.profile.add({
        kind: 'preference',
        value: 'searchable-after-confirm',
        source: 'partner_suggestion',
      });
      env.profile.update(entry.id, { status: 'rejected' });
      expect(env.search.query('searchable-after-confirm')).toHaveLength(0);
      env.profile.update(entry.id, { status: 'confirmed' });
      expect(env.search.query('searchable-after-confirm').map((h) => h.refId)).toEqual([entry.id]);
    } finally {
      env.close();
    }
  });
});

describe('profile manager — audit rows never carry content', () => {
  it('profile.add/update/delete carry ids, kinds, lengths — NOT value/evidence', () => {
    const env = makeMemoryEnv();
    try {
      const secret = 'needle-profile-content-never-audited-xyz';
      const entry = env.profile.add({
        kind: 'identity',
        value: secret,
        evidence: 'evidence-with-secret',
        source: 'partner_suggestion',
      });
      env.profile.update(entry.id, { status: 'confirmed', value: `${secret}-edited` });
      env.profile.remove(entry.id);

      const rows = env.audit.list(100);
      const actions = rows.map((r) => r.action);
      expect(actions).toContain('profile.add');
      expect(actions).toContain('profile.update');
      expect(actions).toContain('profile.delete');
      const blob = rows.map((r) => JSON.stringify(r)).join('\n');
      expect(blob).not.toContain(secret);
      expect(blob).not.toContain('evidence-with-secret');
      // Lengths are present.
      const addRow = rows.find((r) => r.action === 'profile.add');
      expect(JSON.parse(addRow?.details ?? '{}')).toMatchObject({
        kind: 'identity',
        status: 'suggested',
        source: 'partner_suggestion',
        valueLength: secret.length,
      });
    } finally {
      env.close();
    }
  });

  it('get() returns the wire shape for an existing entry', () => {
    const env = makeMemoryEnv();
    try {
      const added = env.profile.add({ kind: 'preference', value: 'shape check' });
      const entry: ProfileEntry | null = env.profile.get(added.id);
      expect(entry).toMatchObject({
        id: added.id,
        kind: 'preference',
        value: 'shape check',
        key: null,
        evidence: null,
        personaScope: null,
      });
      expect(typeof entry?.createdAt).toBe('number');
      expect(typeof entry?.updatedAt).toBe('number');
    } finally {
      env.close();
    }
  });
});
