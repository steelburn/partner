/**
 * M16 F1/F3 note manager tests (PLAN-M16.md): version snapshots at the
 * mutation choke point (create/update/capture/summarize/restore — restore is
 * undoable), retention pruning, the relationship graph (direction, mutual
 * refs collapse to one bidirectional edge, positions ride through), and
 * position persistence validation.
 */
import { describe, expect, it } from 'vitest';
import { makeNotesEnv, sequentialClock } from './notesEnv.js';

describe('M16 F3 note versions', () => {
  it('snapshots create + every update with ascending seq, newest first', () => {
    const env = makeNotesEnv({ m16: true, now: sequentialClock() });
    try {
      const note = env.notes.create({ title: 'V1 title', content: 'line one' });
      env.notes.update(note.id, { content: 'line one\nline two' });
      env.notes.update(note.id, { title: 'V2 title' });

      const versions = env.notes.versions(note.id);
      expect(versions).toHaveLength(3);
      expect(versions.map((v) => v.seq)).toEqual([3, 2, 1]);
      // Newest version changed the title vs the previous one.
      expect(versions[0]).toMatchObject({ writer: 'user', titleChanged: true });
      expect(versions[1]).toMatchObject({ writer: 'user', titleChanged: false });

      // Snapshots are the state after each write.
      const first = env.notes.version(note.id, versions[2]!.id);
      expect(first).toMatchObject({ title: 'V1 title', content: 'line one', tags: [] });
      const second = env.notes.version(note.id, versions[1]!.id);
      expect(second).toMatchObject({ title: 'V1 title', content: 'line one\nline two' });
      const last = env.notes.version(note.id, versions[0]!.id);
      expect(last.title).toBe('V2 title');
      expect(last.content).toBe('line one\nline two');
    } finally {
      env.close();
    }
  });

  it('captures snapshot with the capture writer and seq 1', () => {
    const env = makeNotesEnv({ m16: true, now: sequentialClock() });
    try {
      const captured = env.notes.capture('Quick idea\nBody text');
      const versions = env.notes.versions(captured.id);
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({ seq: 1, writer: 'capture' });
    } finally {
      env.close();
    }
  });

  it('promote/playbook-style creates snapshot with their writer tag', () => {
    const env = makeNotesEnv({ m16: true, now: sequentialClock() });
    try {
      const note = env.notes.create({ title: 'From chat', content: 'body' }, 'promote');
      const versions = env.notes.versions(note.id);
      expect(versions[0]).toMatchObject({ writer: 'promote' });
    } finally {
      env.close();
    }
  });

  it('restore is undoable: snapshots current state then applies the target', () => {
    const env = makeNotesEnv({ m16: true, now: sequentialClock() });
    try {
      const note = env.notes.create({ title: 'Original', content: 'alpha' });
      env.notes.update(note.id, { content: 'beta' });
      const target = env.notes.versions(note.id).find((v) => v.seq === 1)!;

      const restored = env.notes.restore(note.id, target.id);
      expect(restored.content).toBe('alpha');

      // The restore itself is versioned (writer 'restore') so it can be
      // undone back to 'beta'.
      const versions = env.notes.versions(note.id);
      expect(versions[0]).toMatchObject({ seq: 3, writer: 'restore' });
      const preRestore = env.notes.version(note.id, versions[1]!.id);
      expect(preRestore.content).toBe('beta');

      const undo = env.notes.restore(note.id, versions[1]!.id);
      expect(undo.content).toBe('beta');
    } finally {
      env.close();
    }
  });

  it('prunes oldest versions beyond the retention cap', () => {
    const env = makeNotesEnv({ m16: true, now: sequentialClock() });
    try {
      const note = env.notes.create({ title: 'Long-lived', content: '0' });
      for (let i = 1; i < 105; i += 1) {
        env.notes.update(note.id, { content: String(i) });
      }
      const versions = env.notes.versions(note.id);
      expect(versions).toHaveLength(100);
      expect(versions[0]!.seq).toBe(105);
      expect(versions[99]!.seq).toBe(6);
    } finally {
      env.close();
    }
  });

  it('versions/version/restore validate note + version existence', () => {
    const env = makeNotesEnv({ m16: true });
    try {
      const note = env.notes.create({ title: 'A', content: 'x' });
      expect(() => env.notes.versions('nope')).toThrowError(/not found/);
      expect(() => env.notes.version(note.id, 'nope')).toThrowError(/not found/);
      expect(() => env.notes.restore(note.id, 'nope')).toThrowError(/not found/);
    } finally {
      env.close();
    }
  });
});

describe('M16 F1 note relationship graph', () => {
  it('nodes cover every note; edges follow who references whom', () => {
    const env = makeNotesEnv({ m16: true, now: sequentialClock() });
    try {
      // Target notes exist before the referencer so links resolve at save.
      const b = env.notes.create({ title: 'Beta', content: 'plain' });
      const a = env.notes.create({ title: 'Alpha', content: 'see [[Beta]]' });
      const c = env.notes.create({ title: 'Gamma', content: 'look at [[Alpha]]' });

      const graph = env.notes.graph();
      expect(graph.nodes.map((n) => n.id).sort()).toEqual([a.id, b.id, c.id].sort());
      const edges = graph.edges;
      const alphaBeta = edges.find((e) => e.source === a.id && e.target === b.id);
      const gammaAlpha = edges.find((e) => e.source === c.id && e.target === a.id);
      expect(alphaBeta).toMatchObject({ bidirectional: false });
      expect(gammaAlpha).toMatchObject({ bidirectional: false });
      expect(edges.filter((e) => e.bidirectional)).toHaveLength(0);
    } finally {
      env.close();
    }
  });

  it('mutual references collapse to ONE bidirectional edge', () => {
    const env = makeNotesEnv({ m16: true, now: sequentialClock() });
    try {
      const b = env.notes.create({ title: 'Beta', content: 'plain' });
      const a = env.notes.create({ title: 'Alpha', content: 'see [[Beta]]' });
      env.notes.update(b.id, { content: 'back at [[Alpha]]' });

      const graph = env.notes.graph();
      const bidirectional = graph.edges.filter((e) => e.bidirectional);
      expect(bidirectional).toHaveLength(1);
      const edge = bidirectional[0]!;
      expect([edge.source, edge.target].sort()).toEqual([a.id, b.id].sort());
    } finally {
      env.close();
    }
  });

  it('keeps an isolated node for dangling-link-only notes', () => {
    const env = makeNotesEnv({ m16: true, now: sequentialClock() });
    try {
      const lonely = env.notes.create({ title: 'Lonely', content: 'see [[Nothing Here]]' });
      const graph = env.notes.graph();
      expect(graph.nodes).toHaveLength(1);
      expect(graph.nodes[0]!.id).toBe(lonely.id);
      expect(graph.edges).toHaveLength(0);
    } finally {
      env.close();
    }
  });

  it('persists dragged positions and reads them back on the nodes', () => {
    const env = makeNotesEnv({ m16: true, now: sequentialClock() });
    try {
      const a = env.notes.create({ title: 'Alpha', content: '' });
      env.notes.setPosition(a.id, 12.5, -40);
      const graph = env.notes.graph();
      expect(graph.nodes[0]).toMatchObject({ x: 12.5, y: -40 });
    } finally {
      env.close();
    }
  });

  it('rejects non-finite positions and unknown note ids', () => {
    const env = makeNotesEnv({ m16: true });
    try {
      const a = env.notes.create({ title: 'Alpha', content: '' });
      expect(() => env.notes.setPosition(a.id, Number.NaN, 0)).toThrowError(/finite/);
      expect(() => env.notes.setPosition(a.id, 1, Number.POSITIVE_INFINITY)).toThrowError(/finite/);
      expect(() => env.notes.setPosition('nope', 1, 1)).toThrowError(/not found/);
    } finally {
      env.close();
    }
  });

  it('removing a note clears its versions + position + edges', () => {
    const env = makeNotesEnv({ m16: true, now: sequentialClock() });
    try {
      const a = env.notes.create({ title: 'Alpha', content: 'see [[Beta]]' });
      const b = env.notes.create({ title: 'Beta', content: '' });
      env.notes.update(a.id, { content: 'again [[Beta]]' });
      env.notes.setPosition(a.id, 3, 4);
      env.notes.remove(a.id);
      expect(env.stores.versions?.listForNote(a.id) ?? []).toHaveLength(0);
      expect(env.stores.graph?.listAll() ?? []).toHaveLength(0);
      expect(env.notes.graph().nodes.map((n) => n.id)).toEqual([b.id]);
      expect(env.notes.graph().edges).toHaveLength(0);
    } finally {
      env.close();
    }
  });
});
