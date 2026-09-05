/**
 * M9 playbook registry + manager tests (PLAN-M9.md).
 *
 * Registry: the eight PLAN playbooks with area/description/allowedTools/
 * defaultIndependence/inputs metadata; vibe-code + ship are persona tool
 * loops (file-tool envelopes + a projectId input) while the text playbooks
 * declare no tools. Manager: a text playbook run against the demo provider
 * completes deterministically; inputs.saveNote writes a note via the notes
 * manager (title from the playbook name); a conversationId persists the
 * run into the transcript; playbook_runs rows are stamped; noteId loads the
 * note content into the run prompt.
 */
import { describe, expect, it } from 'vitest';
import { demoHarness } from '../helpers.js';
import type { Harness } from '../helpers.js';
import { PLAYBOOKS, listPlaybooks, playbookById } from '../../src/playbooks/registry.js';
import type { PbEvent, PbRunOutcome, PreparedPlaybookRun } from '../../src/playbooks/manager.js';

async function runAll(
  h: Harness,
  prepared: PreparedPlaybookRun,
): Promise<{ events: PbEvent[]; outcome: PbRunOutcome }> {
  const events: PbEvent[] = [];
  const iterator = prepared.events[Symbol.asyncIterator]();
  for (;;) {
    const step = await iterator.next();
    if (step.done) return { events, outcome: step.value as PbRunOutcome };
    events.push(step.value as PbEvent);
  }
}

describe('playbook registry', () => {
  it('lists the eight PLAN playbooks with full metadata', () => {
    expect(PLAYBOOKS).toHaveLength(8);
    expect(listPlaybooks()).toEqual(PLAYBOOKS);
    const ids = PLAYBOOKS.map((p) => p.id).sort();
    expect(ids).toEqual(
      ['analysis', 'design-prototype', 'docgen', 'email', 'presentation', 'research', 'ship', 'vibe-code'].sort(),
    );
    for (const p of PLAYBOOKS) {
      expect(p.area).toBe(p.id);
      expect(p.description.length).toBeGreaterThan(10);
      expect(p.name.length).toBeGreaterThan(0);
      expect(['assist', 'suggest', 'auto', 'autonomous']).toContain(p.defaultIndependence);
      expect(Array.isArray(p.inputs)).toBe(true);
      for (const input of p.inputs) {
        expect(typeof input.name).toBe('string');
        expect(typeof input.hint).toBe('string');
      }
      // Playbook ids round-trip through the registry lookup.
      expect(playbookById(p.id)?.id).toBe(p.id);
    }
    expect(playbookById('nope')).toBeNull();
  });

  it('vibe-code and ship are tool loops; the text playbooks declare no tools', () => {
    const vibe = playbookById('vibe-code');
    expect(vibe?.defaultIndependence).toBe('auto');
    expect(vibe?.allowedTools).toContain('files.read');
    expect(vibe?.allowedTools).toContain('files.edit');
    expect(vibe?.inputs.some((i) => i.name === 'projectId' && i.optional !== true)).toBe(true);

    const ship = playbookById('ship');
    expect(ship?.allowedTools).toContain('files.apply');

    for (const id of ['research', 'docgen', 'email', 'presentation', 'analysis', 'design-prototype']) {
      expect(playbookById(id)?.allowedTools).toEqual([]);
    }
  });

  it('text playbook run against the demo provider completes; saveNote writes via the notes manager', async () => {
    const h = demoHarness();
    try {
      const pb = h.playbooks as NonNullable<Harness['playbooks']>;
      const prepared = await pb.prepare({
        playbookId: 'docgen',
        personaId: 'p-scribe',
        inputs: { prompt: 'Draft a short release-notes doc', saveNote: true },
      });
      const { events, outcome } = await runAll(h, prepared);

      expect(outcome.status).toBe('done');
      expect(outcome.text).toMatch(/^demo: received \d+ characters$/);
      expect(outcome.playbookId).toBe('docgen');
      // Note created with the playbook name as title.
      const notes = (h.notes as NonNullable<Harness['notes']>).list();
      const created = notes.find((n) => n.title === 'Docgen');
      expect(created).toBeDefined();
      expect((h.notes as NonNullable<Harness['notes']>).get(created?.id ?? '')?.content).toBe(outcome.text);

      // Run row persisted + audited with ids/counts only.
      const run = h.playbookRunStore.findById(outcome.runId);
      expect(run?.status).toBe('done');
      expect(run?.personaId).toBe('p-scribe');
      const audit = h.audit.list(100).find((row) => row.action === 'playbook.run');
      expect(audit?.details).toContain('"status":"done"');
      expect(audit?.details).not.toContain('demo:');

      const starts = events.map((e) => e.type);
      expect(starts[0]).toBe('run_start');
      expect(starts[starts.length - 1]).toBe('run_end');
      expect(events.some((e) => e.type === 'delta')).toBe(true);
      expect(events.some((e) => e.type === 'loop_step')).toBe(true);
    } finally {
      h.close();
    }
  });

  it('conversationId persists the run transcript (user + assistant turns)', async () => {
    const h = demoHarness();
    try {
      const pb = h.playbooks as NonNullable<Harness['playbooks']>;
      const convo = (h.conversations as Harness['conversations']).create({ personaId: 'p-scribe' });
      const prepared = await pb.prepare({
        playbookId: 'research',
        conversationId: convo.id,
        inputs: { topic: 'Sqlite FTS5' },
      });
      const { outcome } = await runAll(h, prepared);
      expect(outcome.status).toBe('done');
      const messages = h.messageStore.listByConversation(convo.id);
      expect(messages).toHaveLength(2);
      expect(messages[0]?.role).toBe('user');
      expect(messages[1]?.role).toBe('assistant');
      expect(messages[1]?.content).toMatch(/^demo: received \d+ characters$/);
      expect(outcome.messageId).toBe(messages[1]?.id);
    } finally {
      h.close();
    }
  });

  it('a noteId input loads the note content into the run prompt', async () => {
    const h = demoHarness();
    try {
      const note = (h.notes as NonNullable<Harness['notes']>).create({
        title: 'Source pack',
        content: 'Seed material for the analysis.',
      });
      const pb = h.playbooks as NonNullable<Harness['playbooks']>;
      const prepared = await pb.prepare({
        playbookId: 'analysis',
        personaId: 'p-analyst',
        inputs: { noteId: note.id, question: 'Summarize it' },
      });
      const { outcome } = await runAll(h, prepared);
      expect(outcome.status).toBe('done');
      // The demo reply echoes the length of the last user message — the
      // loaded note content is part of that message.
      expect(outcome.text).toMatch(/^demo: received \d+ characters$/);
      expect(outcome.text).toContain('characters');
    } finally {
      h.close();
    }
  });

  it('unknown playbook / unknown persona / paused persona are typed errors', async () => {
    const h = demoHarness();
    try {
      const pb = h.playbooks as NonNullable<Harness['playbooks']>;
      await expect(pb.prepare({ playbookId: 'nope', inputs: {} })).rejects.toMatchObject({
        code: 'not_found',
      });
      await expect(pb.prepare({ playbookId: 'docgen', personaId: 'p-nope', inputs: {} })).rejects.toMatchObject({
        code: 'not_found',
      });
      (h.personas as Harness['personas']).pause('p-scribe');
      await expect(
        pb.prepare({ playbookId: 'docgen', personaId: 'p-scribe', inputs: {} }),
      ).rejects.toMatchObject({ code: 'persona_paused' });
      await expect(pb.prepare({ playbookId: 'docgen', inputs: 'nope' as unknown as Record<string, unknown> })).rejects.toMatchObject({
        code: 'invalid_input',
      });
    } finally {
      h.close();
    }
  });

  it('no_provider when nothing usable is configured (non-demo harness)', async () => {
    const h = demoHarness({ demo: false });
    try {
      const pb = h.playbooks as NonNullable<Harness['playbooks']>;
      await expect(
        pb.prepare({ playbookId: 'docgen', personaId: 'p-scribe', inputs: {} }),
      ).rejects.toMatchObject({ code: 'no_provider' });
    } finally {
      h.close();
    }
  });
});
