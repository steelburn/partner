/**
 * M5 note manager tests (PLAN-M5.md §"Tests"): CRUD + tags, wiki-link parse
 * (self, case-insensitive resolve, dangling, backlinks, deletes clean links),
 * FTS search + the upsert-replaces-old-text cross-cutting case, daily-note
 * idempotency, capture title/body split, the summarize placeholder path
 * (append + replace) and the provider path, export bundle shape, and audit
 * rows that carry ids/lengths but NEVER note content/titles/tags.
 */
import { describe, expect, it } from 'vitest';
import {
  NoteError,
  parseWikiLinks,
  stripDailySummarySection,
} from '../../src/notes/index.js';
import { fakeProvider, fixedClock, makeNotesEnv, sequentialClock } from './notesEnv.js';

/** Mutable clock for day-advance cases. */
function mutableClock(): { now: () => number; advance: (ms: number) => void } {
  let at = Date.UTC(2025, 1, 3, 12, 0, 0);
  return { now: () => at, advance: (ms: number) => { at += ms; } };
}

describe('note manager — create/update/list/get/remove', () => {
  it('create trims the title, normalizes tags and stores content', () => {
    const env = makeNotesEnv({ now: sequentialClock() });
    try {
      const note = env.notes.create({
        title: '  Groceries  ',
        content: 'buy milk\nand eggs',
        tags: [' home ', 'home', 'Errands', ''],
      });
      expect(note).toMatchObject({
        title: 'Groceries',
        content: 'buy milk\nand eggs',
        tags: ['home', 'Errands'],
        isDaily: false,
      });
      expect(typeof note.id).toBe('string');
      expect(note.createdAt).toBe(note.updatedAt);

      // Stored tags are the JSON array; the row title is trimmed.
      const row = env.stores.notes.findById(note.id);
      expect(row?.tags).toBe(JSON.stringify(['home', 'Errands']));

      const fetched = env.notes.get(note.id);
      expect(fetched?.content).toBe('buy milk\nand eggs');
      expect(env.notes.get('missing')).toBeNull();
    } finally {
      env.close();
    }
  });

  it('validates input: empty/missing title, bad content/tags/isDaily -> invalid_input', () => {
    const env = makeNotesEnv();
    try {
      const cases: Array<[string, unknown]> = [
        ['missing title', { content: 'x' }],
        ['blank title', { title: '   ' }],
        ['non-string title', { title: 42 }],
        ['non-string content', { title: 't', content: 42 }],
        ['non-array tags', { title: 't', tags: 'home' }],
        ['non-string tag', { title: 't', tags: [1] }],
        ['non-boolean isDaily', { title: 't', isDaily: 'yes' }],
        ['non-object body', 'note'],
      ];
      for (const [label, input] of cases) {
        try {
          env.notes.create(input as never);
          expect.unreachable(`should throw for ${label}`);
        } catch (err) {
          expect(err, label).toBeInstanceOf(NoteError);
          expect((err as NoteError).code, label).toBe('invalid_input');
        }
      }
      expect(env.notes.list()).toHaveLength(0);
    } finally {
      env.close();
    }
  });

  it('list() returns newest-updated summaries first; update/remove round-trip', () => {
    const env = makeNotesEnv({ now: sequentialClock() });
    try {
      const first = env.notes.create({ title: 'First', content: 'a' });
      const second = env.notes.create({ title: 'Second', content: 'b' });
      // Newest updated first (the sequential clock disambiguates timestamps).
      expect(env.notes.list().map((n) => n.title)).toEqual(['Second', 'First']);
      expect(env.notes.list()[0]).not.toHaveProperty('content');

      const updated = env.notes.update(second.id, { title: 'Second v2', tags: ['focus'] });
      expect(updated).toMatchObject({ title: 'Second v2', tags: ['focus'] });
      expect(updated.updatedAt).toBeGreaterThanOrEqual(second.updatedAt);
      expect(env.notes.list().map((n) => n.title)).toEqual(['Second v2', 'First']);

      env.notes.remove(first.id);
      expect(env.notes.get(first.id)).toBeNull();
      expect(env.notes.list().map((n) => n.id)).toEqual([second.id]);

      // Partial update leaves untouched fields alone.
      const untouched = env.notes.update(second.id, { content: 'only content' });
      expect(untouched).toMatchObject({
        title: 'Second v2',
        tags: ['focus'],
        content: 'only content',
      });
    } finally {
      env.close();
    }
  });

  it('update/remove on an unknown id -> typed not_found; update validates the patch', () => {
    const env = makeNotesEnv();
    try {
      const created = env.notes.create({ title: 'Keep', content: 'x' });
      for (const [label, call] of [
        ['update', () => env.notes.update('missing', { title: 'z' })],
        ['remove', () => env.notes.remove('missing')],
      ] as Array<[string, () => unknown]>) {
        try {
          call();
          expect.unreachable(`should throw for ${label}`);
        } catch (err) {
          expect(err).toBeInstanceOf(NoteError);
          expect((err as NoteError).code).toBe('not_found');
        }
      }
      // Invalid patch values are typed invalid_input, even on existing notes.
      try {
        env.notes.update(created.id, { tags: 'nope' } as never);
        expect.unreachable('should throw');
      } catch (err) {
        expect((err as NoteError).code).toBe('invalid_input');
      }
    } finally {
      env.close();
    }
  });

  it('listTags() counts tags across notes, count desc then tag asc', () => {
    const env = makeNotesEnv();
    try {
      env.notes.create({ title: 'a', content: '', tags: ['home', 'home', 'work'] });
      env.notes.create({ title: 'b', content: '', tags: ['work'] });
      env.notes.create({ title: 'c', content: '' });
      expect(env.notes.listTags()).toEqual([
        { tag: 'work', count: 2 },
        { tag: 'home', count: 1 },
      ]);
    } finally {
      env.close();
    }
  });
});

describe('wiki-links — parse, resolve, dangling, backlinks, cleanup', () => {
  it('parseWikiLinks extracts trimmed, de-duplicated titles; empty brackets ignored', () => {
    expect(parseWikiLinks('see [[Alpha]] and [[ Beta ]] again [[Alpha]] [[alpha]]')).toEqual([
      'Alpha',
      'Beta',
    ]);
    expect(parseWikiLinks('no links here')).toEqual([]);
    expect(parseWikiLinks('[[ ]] [[  ]] x')).toEqual([]);
  });

  it('create resolves [[Title]] case-insensitively; dangling links store to_note null', () => {
    const env = makeNotesEnv();
    try {
      const target = env.notes.create({ title: 'Alpha', content: 'exists' });
      const source = env.notes.create({ title: 'Source', content: 'see [[ALPHA]] and [[Beta]]' });
      const links = env.notes.links(source.id);
      expect(links).toEqual([
        { toNoteId: target.id, toTitle: 'ALPHA' },
        { toNoteId: null, toTitle: 'Beta' },
      ]);
      const rows = env.stores.links.listFrom(source.id);
      expect(rows.find((r) => r.toTitle === 'ALPHA')?.toNote).toBe(target.id);
      expect(rows.find((r) => r.toTitle === 'Beta')?.toNote).toBeNull();
    } finally {
      env.close();
    }
  });

  it('self-links resolve to the note itself but never appear as its own backlink', () => {
    const env = makeNotesEnv();
    try {
      const self = env.notes.create({ title: 'Solo', content: 'I am [[Solo]]' });
      expect(env.notes.links(self.id)).toEqual([{ toNoteId: self.id, toTitle: 'Solo' }]);
      expect(env.notes.backlinks(self.id)).toEqual([]);
    } finally {
      env.close();
    }
  });

  it('backlinks() finds resolved + dangling-by-title linkers, newest first', () => {
    const clock = mutableClock();
    const env = makeNotesEnv({ now: clock.now });
    try {
      // Bee links [[alpha]] BEFORE Alpha exists -> dangling edge.
      const bee = env.notes.create({ title: 'Bee', content: 'points at [[alpha]]' });
      clock.advance(1000);
      const target = env.notes.create({ title: 'Alpha', content: 'hi' });
      clock.advance(1000);
      const cee = env.notes.create({ title: 'Cee', content: 'see [[Alpha]]' });
      clock.advance(1000);
      const dee = env.notes.create({ title: 'Dee', content: 'see [[Alpha]]' });

      // Newest updated first.
      expect(env.notes.backlinks(target.id).map((n) => n.id)).toEqual([dee.id, cee.id, bee.id]);

      // Touching Bee makes it the newest backlink.
      clock.advance(1000);
      env.notes.update(bee.id, { content: 'points at [[alpha]] again' });
      expect(env.notes.backlinks(target.id).map((n) => n.id)).toEqual([bee.id, dee.id, cee.id]);

      // Deleting a linker removes it from backlinks and cleans its own edges.
      env.notes.remove(dee.id);
      expect(env.notes.backlinks(target.id).map((n) => n.id)).toEqual([bee.id, cee.id]);
    } finally {
      env.close();
    }
  });

  it('backlinks/links on an unknown note are typed not_found', () => {
    const env = makeNotesEnv();
    try {
      for (const call of [() => env.notes.backlinks('missing'), () => env.notes.links('missing')]) {
        try {
          call();
          expect.unreachable('should throw');
        } catch (err) {
          expect(err).toBeInstanceOf(NoteError);
          expect((err as NoteError).code).toBe('not_found');
        }
      }
    } finally {
      env.close();
    }
  });

  it('update replaces the outgoing link set; remove cleans links + FTS', () => {
    const env = makeNotesEnv();
    try {
      const target = env.notes.create({ title: 'Omega', content: 'target' });
      const source = env.notes.create({ title: 'Source', content: 'see [[Omega]] and [[Old]]' });
      expect(env.notes.links(source.id)).toHaveLength(2);

      const updated = env.notes.update(source.id, { content: 'now only [[BrandNew]]' });
      expect(updated.content).toBe('now only [[BrandNew]]');
      expect(env.notes.links(source.id)).toEqual([{ toNoteId: null, toTitle: 'BrandNew' }]);
      // Omega is no longer linked FROM source -> no backlink remains.
      expect(env.notes.backlinks(target.id)).toEqual([]);

      env.notes.remove(source.id);
      expect(env.stores.links.listFrom(source.id)).toEqual([]);
      expect(env.stores.notes.findById(source.id)).toBeUndefined();
    } finally {
      env.close();
    }
  });
});

describe('FTS search', () => {
  it('searches note title + content; no plan text leaks into note hits', () => {
    const env = makeNotesEnv();
    try {
      env.notes.create({ title: 'Groceries', content: 'buy milk and eggs' });
      env.notes.create({ title: 'Research', content: 'sqlite fts5 ranking notes' });
      env.plans.create({ title: 'Migrate schema', description: 'contains the word groceries too' });

      expect(env.notes.search('milk').map((h) => h.title)).toEqual(['Groceries']);
      expect(env.notes.search('research').map((h) => h.title)).toEqual(['Research']);
      // The plan mentions 'groceries' but note search only returns notes.
      expect(env.notes.search('groceries').map((h) => h.title)).toEqual(['Groceries']);
    } finally {
      env.close();
    }
  });

  it('returns full notes with content; empty/bad queries are typed invalid_input', () => {
    const env = makeNotesEnv();
    try {
      const created = env.notes.create({ title: 'Catchphrase', content: 'unique phrase sunburst' });
      const [hit] = env.notes.search('sunburst');
      expect(hit).toMatchObject({ id: created.id, content: 'unique phrase sunburst' });
      expect(env.notes.search('no-such-word-xyz')).toEqual([]);
      // FTS metacharacters cannot crash or hijack the query (quoted terms).
      expect(() => env.notes.search('sunburst - OR (')).not.toThrow();
      expect(env.notes.search('sunburst').map((h) => h.id)).toEqual([created.id]);
      for (const bad of ['', '   ']) {
        try {
          env.notes.search(bad);
          expect.unreachable('should throw');
        } catch (err) {
          expect((err as NoteError).code).toBe('invalid_input');
        }
      }
    } finally {
      env.close();
    }
  });

  it('cross-cutting: FTS upsert REPLACES old note text after an update', () => {
    const env = makeNotesEnv();
    try {
      const note = env.notes.create({ title: 'Log', content: 'the old secret phrase mango-42' });
      expect(env.notes.search('mango-42').map((h) => h.id)).toEqual([note.id]);

      env.notes.update(note.id, { content: 'completely new text papaya-99' });
      // Removed phrase no longer matches (no stale FTS row)…
      expect(env.notes.search('mango-42')).toEqual([]);
      // …and the new phrase does.
      expect(env.notes.search('papaya-99').map((h) => h.id)).toEqual([note.id]);

      env.notes.remove(note.id);
      expect(env.notes.search('papaya-99')).toEqual([]);
    } finally {
      env.close();
    }
  });
});

describe('daily note + capture', () => {
  it('daily() creates today\u2019s note (title = UTC date) and is idempotent', () => {
    const clock = fixedClock();
    const env = makeNotesEnv({ now: clock });
    try {
      const first = env.notes.daily();
      expect(first.isDaily).toBe(true);
      expect(first.title).toBe('2025-02-03');
      const second = env.notes.daily();
      expect(second.id).toBe(first.id); // idempotent
      expect(env.notes.list()).toHaveLength(1);
    } finally {
      env.close();
    }
  });

  it('daily() keys on the UTC date — a new day creates a new note', () => {
    const clock = mutableClock();
    const env = makeNotesEnv({ now: clock.now });
    try {
      const day1 = env.notes.daily();
      expect(day1.title).toBe('2025-02-03');
      clock.advance(86_400_000); // next UTC day
      const day2 = env.notes.daily();
      expect(day2.id).not.toBe(day1.id);
      expect(day2.title).toBe('2025-02-04');
      expect(env.notes.list()).toHaveLength(2);
    } finally {
      env.close();
    }
  });

  it('capture splits first non-empty line -> title (<=120), rest -> body', () => {
    const env = makeNotesEnv();
    try {
      const note = env.notes.capture('Quick win\n- fixed the bug\n- shipped');
      expect(note).toMatchObject({ title: 'Quick win', content: '- fixed the bug\n- shipped' });
      expect(note.isDaily).toBe(false);

      const single = env.notes.capture('  just a title  ');
      expect(single).toMatchObject({ title: 'just a title', content: '' });

      const longTitle = 'x'.repeat(200);
      const capped = env.notes.capture(`${longTitle}\nbody`);
      expect(capped.title).toHaveLength(120);
      expect(capped.title).toBe(longTitle.slice(0, 120));
      expect(capped.content).toBe('body');

      for (const bad of ['', '   \n  ', 42, null, undefined]) {
        try {
          env.notes.capture(bad as never);
          expect.unreachable(`should throw for ${String(bad)}`);
        } catch (err) {
          expect((err as NoteError).code).toBe('invalid_input');
        }
      }
    } finally {
      env.close();
    }
  });

  it('audit: capture rows carry note.capture; daily() audits note.daily once', () => {
    const env = makeNotesEnv();
    try {
      env.notes.capture('Title here\nbody');
      env.notes.daily();
      env.notes.daily();
      const actions = env.auditStore.list(50).map((row) => row.action);
      expect(actions).toContain('note.capture');
      expect(actions.filter((a) => a === 'note.daily')).toHaveLength(1);
    } finally {
      env.close();
    }
  });
});

describe('summarizeDaily', () => {
  it('demo placeholder appends a summary section and REPLACES the prior one', async () => {
    const env = makeNotesEnv({ now: sequentialClock(), demo: true });
    try {
      env.notes.capture('Morning note\nwalked the dog');
      env.notes.capture('Plan\nwrite the tests');
      const daily = env.notes.daily();
      expect(daily.content).toBe('');

      const summarized = await env.notes.summarizeDaily();
      expect(summarized.id).toBe(daily.id);
      expect(summarized.content).toContain('## Daily summary');
      expect(summarized.content).toContain('Demo daily summary of 2 notes...');

      // Existing daily body content is preserved ahead of the section.
      env.notes.update(daily.id, { content: 'typed directly in daily\n' });
      const again = await env.notes.summarizeDaily();
      expect(again.content).toContain('typed directly in daily');
      expect(again.content.split('## Daily summary')).toHaveLength(2); // exactly one section
      expect(again.content).toContain('Demo daily summary of 2 notes...');
    } finally {
      env.close();
    }
  });

  it('stripDailySummarySection removes only the last summary section', () => {
    expect(stripDailySummarySection('a\n\n## Daily summary\n\nold')).toBe('a');
    expect(stripDailySummarySection('a\n\n## Daily summary\n\nold\nmore')).toBe('a');
    expect(stripDailySummarySection('no section here')).toBe('no section here');
  });

  it('placeholder counts only today\u2019s non-daily notes (created same UTC day)', async () => {
    const clock = mutableClock();
    const env = makeNotesEnv({ now: clock.now, demo: true });
    try {
      env.notes.capture('yesterday note\nold content');
      clock.advance(86_400_000); // summarize on the NEXT day
      const summarized = await env.notes.summarizeDaily();
      expect(summarized.title).toBe('2025-02-04');
      expect(summarized.content).toContain('Demo daily summary of 0 notes...');
    } finally {
      env.close();
    }
  });

  it('provider path: fixed prompt + day content; first delta appended; upstream typed', async () => {
    const provider = fakeProvider();
    const env = makeNotesEnv({
      now: sequentialClock(),
      demo: false,
      providerResolver: async () => ({ client: provider.client, model: 'test-model' }),
    });
    try {
      env.notes.capture('Alpha note\nalpha body text');
      env.notes.capture('Beta note\nbeta body text');
      const daily = env.notes.daily();

      const summarized = await env.notes.summarizeDaily();
      expect(summarized.content).toContain('PROVIDER SUMMARY TEXT');
      expect(summarized.content).not.toContain('Demo daily summary');

      // The provider saw the fixed instruction, then the concatenated content.
      expect(provider.requests).toHaveLength(1);
      const req = provider.requests[0];
      if (req === undefined) throw new Error('expected one provider request');
      expect(req.model).toBe('test-model');
      expect(req.messages[0]?.role).toBe('system');
      expect(req.messages[0]?.content).toContain('summarizing the notes');
      const payload = req.messages[1]?.content ?? '';
      expect(payload).toContain('Alpha note');
      expect(payload).toContain('beta body text');

      // Second call REPLACES the previous section (one header, provider text).
      const again = await env.notes.summarizeDaily();
      expect(again.content.split('## Daily summary')).toHaveLength(2);
      expect(again.content).toContain('PROVIDER SUMMARY TEXT');
      expect(provider.requests).toHaveLength(2);

      // A failed stream surfaces the typed upstream error and keeps the body.
      provider.fail = true;
      try {
        await env.notes.summarizeDaily();
        expect.unreachable('should throw');
      } catch (err) {
        expect(err).toBeInstanceOf(NoteError);
        expect((err as NoteError).code).toBe('upstream');
      }
    } finally {
      env.close();
    }
  });

  it('resolver returning null falls back to the placeholder (no provider)', async () => {
    const env = makeNotesEnv({ now: sequentialClock(), demo: false });
    try {
      env.notes.capture('Note\ncontent here');
      const summarized = await env.notes.summarizeDaily();
      expect(summarized.content).toContain('Demo daily summary of 1 note...');
    } finally {
      env.close();
    }
  });
});

describe('export + audit privacy', () => {
  it('exportAll() returns the notes/v1 bundle with every note, chronological', () => {
    const env = makeNotesEnv({ now: sequentialClock() });
    try {
      const first = env.notes.create({ title: 'Oldest', content: 'x', tags: ['a'] });
      const second = env.notes.capture('Newest\nbody');
      const bundle = env.notes.exportAll();
      expect(bundle.schema).toBe('notes/v1');
      expect(typeof bundle.exportedAt).toBe('number');
      expect(bundle.notes.map((n) => n.id)).toEqual([first.id, second.id]);
      expect(bundle.notes[0]).toMatchObject({ title: 'Oldest', tags: ['a'], content: 'x' });
    } finally {
      env.close();
    }
  });

  it('audit rows carry ids + lengths only — never note bodies, titles or tags', async () => {
    const env = makeNotesEnv();
    try {
      const secretBody = 'walrus-mango-plum confidential paragraph';
      const secretTitle = 'clandestine-codeword title';
      const secretTag = 'black-ops-tag';
      const note = env.notes.create({ title: secretTitle, content: secretBody, tags: [secretTag] });
      env.notes.update(note.id, { content: `${secretBody} v2` });
      env.notes.capture(`capture-codename\n${secretBody}`);
      env.notes.daily();
      await env.notes.summarizeDaily();
      env.notes.remove(note.id);

      const rows = env.auditStore.list(50);
      expect(rows.some((r) => r.action === 'note.create')).toBe(true);
      const details = rows.map((r) => `${r.action}|${r.target}|${r.details}`).join('\n');
      expect(details).not.toContain(secretBody);
      expect(details).not.toContain(secretTitle);
      expect(details).not.toContain(secretTag);
      expect(details).not.toContain('capture-codename');
      // Length fields are present so the audit stays useful.
      expect(details).toContain('contentLength');
      expect(details).toContain('titleLength');
    } finally {
      env.close();
    }
  });
});
