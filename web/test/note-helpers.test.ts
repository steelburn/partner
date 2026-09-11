import { describe, expect, it } from 'vitest';
import type { Folder, Note, NoteSummary, NotesExportBundle, Plan, PlanSummary } from '@partner/shared';
import {
  extractWikiLinks,
  flattenPlanTasks,
  folderSubtreeIds,
  folderTreeRows,
  linkTitleToSearch,
  noteFolderNames,
  noteListSort,
  notesBundleToFile,
  notesInScope,
  parseTags,
  planBundleToFile,
  planProgress,
  planToExportFileName,
  scopeLabel,
  validateNotesExportBundle,
  validateTaskStatusInput,
} from '../src/lib/note-helpers.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function summary(id: string, overrides: Partial<NoteSummary> = {}): NoteSummary {
  return {
    id,
    title: `Note ${id}`,
    tags: [],
    isDaily: false,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

function note(id: string, overrides: Partial<Note> = {}): Note {
  return { ...summary(id), content: '# Body', ...overrides };
}

function fullPlan(overrides: Partial<Plan> = {}): Plan {
  return {
    id: 'plan-1',
    title: 'Launch',
    description: 'Ship the thing',
    document: {
      milestones: [
        { id: 'm1', title: 'Build', tasks: [
          { id: 't1', title: 'Write api', status: 'done' },
          { id: 't2', title: 'Write ui', status: 'open' },
          { id: 't3', title: 'Deploy', status: 'blocked', ownerPersonaId: 'p-1', note: 'Waiting on review' },
        ] },
        { id: 'm2', title: 'Polish', tasks: [{ id: 't4', title: 'Audit', status: 'open' }] },
        { id: 'm3', title: 'Empty', tasks: [] },
      ],
    },
    taskCount: 4,
    doneCount: 1,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

function summaryOnly(overrides: Partial<PlanSummary> = {}): PlanSummary {
  return {
    id: 'plan-1',
    title: 'Launch',
    description: null,
    taskCount: 4,
    doneCount: 1,
    createdAt: 100,
    updatedAt: 200,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Wiki links
// ---------------------------------------------------------------------------

describe('extractWikiLinks', () => {
  it('returns distinct [[Title]] targets in order of appearance', () => {
    expect(extractWikiLinks('See [[Alpha]] and [[Beta]] plus [[Alpha]] again.')).toEqual([
      'Alpha',
      'Beta',
    ]);
  });

  it('trims whitespace and ignores empty brackets', () => {
    expect(extractWikiLinks('[[ One ]] x [[  ]] y [[]]')).toEqual(['One']);
  });

  it('deduplicates case-insensitively, keeping the first spelling', () => {
    expect(extractWikiLinks('[[Alpha]] then [[alpha]] and [[ALPHA]]')).toEqual(['Alpha']);
  });

  it('ignores single brackets and unclosed fragments', () => {
    expect(extractWikiLinks('Plain [text] and an open [[Alpha')).toEqual([]);
  });

  it('does not treat links across newlines as one title', () => {
    expect(extractWikiLinks('[[Alpha\nBeta]] still [[Gamma]]')).toEqual(['Gamma']);
  });

  it('returns nothing for empty or link-free content', () => {
    expect(extractWikiLinks('')).toEqual([]);
    expect(extractWikiLinks('no links at all')).toEqual([]);
  });
});

describe('linkTitleToSearch', () => {
  it('wraps a title in an FTS phrase query', () => {
    expect(linkTitleToSearch('Launch plan')).toBe('"Launch plan"');
  });

  it('strips interior double quotes so the phrase cannot break out', () => {
    expect(linkTitleToSearch('Say "hi" now')).toBe('"Say hi now"');
  });

  it('trims surrounding whitespace', () => {
    expect(linkTitleToSearch('  alpha  ')).toBe('"alpha"');
  });
});

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

describe('parseTags', () => {
  it('splits on commas, whitespace and semicolons, trimming each tag', () => {
    expect(parseTags('work, ideas\nm5; trip  ')).toEqual(['work', 'ideas', 'm5', 'trip']);
  });

  it('drops empty tokens', () => {
    expect(parseTags('a,,  ,b')).toEqual(['a', 'b']);
  });

  it('deduplicates case-insensitively, keeping the first spelling and order', () => {
    expect(parseTags('Work, work, WORK, ideas')).toEqual(['Work', 'ideas']);
  });

  it('returns [] for blank or whitespace-only input', () => {
    expect(parseTags('')).toEqual([]);
    expect(parseTags('   , \n ; ')).toEqual([]);
  });

  it('caps a single tag at 40 characters', () => {
    expect(parseTags('x'.repeat(60))[0]).toHaveLength(40);
  });
});

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

describe('noteListSort', () => {
  it('sorts newest-first by updatedAt', () => {
    const list = [
      summary('old', { updatedAt: 100 }),
      summary('new', { updatedAt: 300 }),
      summary('mid', { updatedAt: 200 }),
    ];
    expect(noteListSort(list).map((row) => row.id)).toEqual(['new', 'mid', 'old']);
  });

  it('breaks equal updatedAt ties by createdAt then id (both directions)', () => {
    const list = [
      summary('a', { updatedAt: 100, createdAt: 100 }),
      summary('b', { updatedAt: 100, createdAt: 300 }),
      summary('c', { updatedAt: 100, createdAt: 100 }),
    ];
    expect(noteListSort(list).map((row) => row.id)).toEqual(['b', 'a', 'c']);
  });

  it('does not mutate the input array', () => {
    const list = [summary('a', { updatedAt: 1 }), summary('b', { updatedAt: 2 })];
    const copy = [...list];
    noteListSort(list);
    expect(list).toEqual(copy);
  });
});

// ---------------------------------------------------------------------------
// Plan progress + flattening
// ---------------------------------------------------------------------------

describe('planProgress', () => {
  it('counts done/total across milestones when the document is present', () => {
    expect(planProgress(fullPlan())).toEqual({ done: 1, total: 4, pct: 25 });
  });

  it('reports 0/0 and pct 0 for a plan without tasks', () => {
    expect(
      planProgress(fullPlan({ document: { milestones: [{ id: 'm1', title: 'M', tasks: [] }] } })),
    ).toEqual({ done: 0, total: 0, pct: 0 });
  });

  it('uses summary counts when no document is present', () => {
    expect(planProgress(summaryOnly())).toEqual({ done: 1, total: 4, pct: 25 });
    expect(planProgress(summaryOnly({ taskCount: 0, doneCount: 0 }))).toEqual({
      done: 0,
      total: 0,
      pct: 0,
    });
  });

  it('rounds the percentage to a whole number', () => {
    expect(
      planProgress(
        fullPlan({
          document: {
            milestones: [
              { id: 'm1', title: 'M', tasks: [
                { id: 'a', title: 'A', status: 'done' },
                { id: 'b', title: 'B', status: 'done' },
                { id: 'c', title: 'C', status: 'open' },
              ] },
            ],
          },
        }),
      ),
    ).toEqual({ done: 2, total: 3, pct: 67 });
  });
});

describe('flattenPlanTasks', () => {
  it('flattens milestones + tasks in document order with a full path', () => {
    const rows = flattenPlanTasks(fullPlan());
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      milestoneId: 'm1',
      milestoneTitle: 'Build',
      taskId: 't1',
      taskTitle: 'Write api',
      status: 'done',
      ownerPersonaId: null,
      path: 'Build / Write api',
    });
    expect(rows[2]).toMatchObject({
      ownerPersonaId: 'p-1',
      note: 'Waiting on review',
      path: 'Build / Deploy',
    });
    expect(rows[3]?.path).toBe('Polish / Audit');
  });

  it('omits milestones that have no tasks', () => {
    const rows = flattenPlanTasks(fullPlan());
    expect(rows.some((row) => row.milestoneId === 'm3')).toBe(false);
  });

  it('returns [] for summaries without a document', () => {
    expect(flattenPlanTasks(summaryOnly())).toEqual([]);
  });
});

describe('validateTaskStatusInput', () => {
  it('accepts every valid status with an optional note', () => {
    expect(validateTaskStatusInput({ status: 'open' })).toBeNull();
    expect(validateTaskStatusInput({ status: 'done', note: '' })).toBeNull();
    expect(validateTaskStatusInput({ status: 'blocked', note: 'Waiting' })).toBeNull();
  });

  it('rejects missing/garbage status without echoing it', () => {
    expect(validateTaskStatusInput(null)).toMatch(/status/i);
    expect(validateTaskStatusInput({})).toMatch(/status/i);
    expect(validateTaskStatusInput({ status: 'maybe' })).toBe('Status must be open, done or blocked.');
  });

  it('rejects non-string notes and over-long notes', () => {
    expect(validateTaskStatusInput({ status: 'done', note: 42 })).toMatch(/text/i);
    expect(validateTaskStatusInput({ status: 'done', note: 'x'.repeat(501) })).toMatch(/too long/i);
  });
});

// ---------------------------------------------------------------------------
// Export naming + serialization + schema guard
// ---------------------------------------------------------------------------

describe('planToExportFileName', () => {
  it('slugifies a title and appends the .partner-plan.json suffix', () => {
    expect(planToExportFileName({ title: 'Launch  Plan! 2025' })).toBe(
      'launch-plan-2025.partner-plan.json',
    );
  });

  it('falls back to "plan" for empty/blank titles', () => {
    expect(planToExportFileName({ title: '  ' })).toBe('plan.partner-plan.json');
    expect(planToExportFileName({ title: '###' })).toBe('plan.partner-plan.json');
  });
});

describe('export serialization + validation', () => {
  const bundle = (overrides: Partial<NotesExportBundle> = {}): NotesExportBundle => ({
    schema: 'notes/v1',
    exportedAt: 500,
    notes: [note('n1')],
    ...overrides,
  });

  it('notesBundleToFile pretty-prints with a trailing newline', () => {
    const text = notesBundleToFile(bundle());
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toMatchObject({ schema: 'notes/v1', notes: [{ id: 'n1' }] });
  });

  it('accepts a well-formed notes/v1 bundle', () => {
    expect(validateNotesExportBundle(bundle())).toBeNull();
  });

  it('rejects wrong schema markers and missing lists', () => {
    expect(validateNotesExportBundle({ schema: 'memory/v1', exportedAt: 1, notes: [] })).toMatch(
      /notes\/v1/,
    );
    expect(validateNotesExportBundle({ schema: 'notes/v1', exportedAt: 1 })).toMatch(/no notes list/);
    expect(validateNotesExportBundle(null)).toMatch(/not a Partner notes file/);
    expect(validateNotesExportBundle({ schema: 'notes/v1', notes: [] })).toMatch(/exportedAt/);
  });

  it('names the offending row, never its content', () => {
    const error = validateNotesExportBundle(
      bundle({ notes: [note('ok'), { ...note('bad'), content: 7 } as unknown as Note] }),
    );
    expect(error).toMatch(/notes\[1\]/);
    expect(error).not.toContain('Body');
    expect(error).not.toContain('7');
  });

  it('planBundleToFile serializes the canonical export bundle', () => {
    const text = planBundleToFile({ schema: 'plan/v1', exportedAt: 9, plan: fullPlan() });
    expect(JSON.parse(text)).toMatchObject({ schema: 'plan/v1', exportedAt: 9 });
  });
});

// ---------------------------------------------------------------------------
// M17 note projects — scope resolution helpers
// ---------------------------------------------------------------------------

function folder(id: string, overrides: Partial<Folder> = {}): Folder {
  return {
    id,
    name: `Folder ${id}`,
    parentId: null,
    position: 0,
    chatCount: 0,
    noteCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function noteIn(id: string, folderIds: string[]): NoteSummary {
  return { ...summary(id), folderIds };
}

describe('M17 project scope helpers', () => {
  it('folderSubtreeIds returns the folder + descendants; unknown -> []', () => {
    const tree = [
      folder('root'),
      folder('child', { parentId: 'root' }),
      folder('grand', { parentId: 'child' }),
      folder('other'),
    ];
    expect(folderSubtreeIds(tree, 'root').sort()).toEqual(['root', 'child', 'grand'].sort());
    expect(folderSubtreeIds(tree, 'child').sort()).toEqual(['child', 'grand'].sort());
    expect(folderSubtreeIds(tree, 'ghost')).toEqual([]);
  });

  it('folderTreeRows flattens in tree order with depth', () => {
    const tree = [
      folder('b', { position: 1 }),
      folder('a', { position: 0 }),
      folder('a1', { parentId: 'a' }),
    ];
    expect(folderTreeRows(tree).map((row) => [row.folder.id, row.depth])).toEqual([
      ['a', 0],
      ['a1', 1],
      ['b', 0],
    ]);
  });

  it('notesInScope filters by subtree, Inbox, or passes all through', () => {
    const tree = [folder('p'), folder('sub', { parentId: 'p' }), folder('q')];
    const list = [
      noteIn('n-p', ['p']),
      noteIn('n-sub', ['sub']),
      noteIn('n-q', ['q']),
      noteIn('n-both', ['p', 'q']),
      noteIn('n-inbox', []),
    ];
    expect(notesInScope(list, tree, { kind: 'all' })).toHaveLength(5);
    expect(notesInScope(list, tree, { kind: 'inbox' }).map((n) => n.id)).toEqual(['n-inbox']);
    expect(
      notesInScope(list, tree, { kind: 'folder', folderId: 'p' })
        .map((n) => n.id)
        .sort(),
    ).toEqual(['n-both', 'n-p', 'n-sub'].sort());
    expect(
      notesInScope(list, tree, { kind: 'folder', folderId: 'q' }).map((n) => n.id).sort(),
    ).toEqual(['n-both', 'n-q'].sort());
  });

  it('scopeLabel names the scope and noteFolderNames lists chips in tree order', () => {
    const tree = [folder('p', { name: 'Projects', position: 0 }), folder('q', { name: 'Personal', position: 1 })];
    expect(scopeLabel({ kind: 'all' }, tree)).toBe('All notes');
    expect(scopeLabel({ kind: 'inbox' }, tree)).toBe('Inbox');
    expect(scopeLabel({ kind: 'folder', folderId: 'p' }, tree)).toBe('Projects');
    expect(scopeLabel({ kind: 'folder', folderId: 'ghost' }, tree)).toBe('Project');
    expect(noteFolderNames(noteIn('n', ['q', 'p']), tree)).toEqual(['Projects', 'Personal']);
    expect(noteFolderNames(noteIn('n', []), tree)).toEqual([]);
  });
});
