/**
 * M35 — the Folders page as an Explorer (PLAN-M35.md).
 *
 * The request: "Make Folders view somewhat similar to Windows Explorer view. We
 * should be able to have subfolders too, with this kind of organization."
 *
 * Subfolders have been in the data model since M11 (`folders.parentId`), so the
 * feature is a VIEW change, and the claims are pinned the two ways this repo
 * pins view changes:
 *   - the PURE parts (tree assembly, per-folder contents, the breadcrumb path,
 *     the Items label) are unit-tested against fixtures;
 *   - the STRUCTURE (which pane owns what, which control is shared, the tier
 *     geometry) is asserted against the real sources and stylesheet, the way
 *     `one-left-panel.test.ts` / `session-title.test.ts` do — because the
 *     regression this view guards is a wiring one: a second folder tree, or a
 *     second hand-written copy of a control the rail already owns.
 */
import { describe, expect, it } from 'vitest';
import {
  buildFolderTree,
  folderChats,
  folderPath,
  folderSubtreeIds,
  folderTreeRows,
  assetCountOf,
} from '../src/lib/folder-tree.js';
import { folderTreeRows as reExportedRows } from '../src/lib/note-helpers.js';
import {
  assetCountLabel,
  itemCountLabel,
  messageCountLabel,
} from '../src/FolderContents.js';
import { itemsLabel } from '../src/FoldersView.js';
import { source, atRuleBlocks, declarations, topLevelRules } from './helpers/css.js';
import type { ConversationSummary, Folder } from '@partner/shared';

const APP = source('src/App.tsx');
const VIEW = source('src/FoldersView.tsx');
const CONTENTS = source('src/FolderContents.tsx');
const RAIL = source('src/ConversationRail.tsx');
const FOLDER_ACTIONS = source('src/FolderActions.tsx');
const CHAT_ACTIONS = source('src/ChatActions.tsx');
const CSS = source('src/app.css');
const BLOCKS = atRuleBlocks(CSS);

/** Base (non-media) declarations for `selector`. */
function base(selector: string): string {
  return topLevelRules(CSS)
    .filter(([list]) => list.split(',').map((part) => part.trim()).includes(selector))
    .map(([, body]) => body)
    .join('\n');
}

/** Declarations for `selector` in every block with this at-rule prelude. */
function tier(prelude: string, selector: string): string {
  return BLOCKS.filter((block) => block.prelude === prelude)
    .map((block) => declarations(block.body, selector))
    .join('\n');
}

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

function chat(id: string, folderId: string | null, overrides: Partial<ConversationSummary> = {}): ConversationSummary {
  return {
    id,
    personaId: null,
    title: `Chat ${id}`,
    folderId,
    messageCount: 2,
    assetCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// The tree: nesting, order, and the numbers the columns show
// ---------------------------------------------------------------------------

describe('buildFolderTree', () => {
  const folders = [
    folder('work', { position: 0 }),
    folder('q3', { parentId: 'work', position: 0 }),
    folder('q4', { parentId: 'work', position: 1 }),
    folder('deep', { parentId: 'q3', position: 0 }),
    folder('personal', { position: 1 }),
  ];

  it('nests subfolders under their parent in sibling order', () => {
    const tree = buildFolderTree(folders, []);
    expect(tree.roots.map((node) => node.id)).toEqual(['work', 'personal']);
    expect(tree.roots[0].children.map((node) => node.id)).toEqual(['q3', 'q4']);
    expect(tree.roots[0].children[0].children.map((node) => node.id)).toEqual(['deep']);
    // Every node is reachable by id, at any depth.
    expect(tree.byId.get('deep')?.parentId).toBe('q3');
  });

  it('counts a folder AND its subfolders, which is what an Items column means', () => {
    const tree = buildFolderTree(folders, [
      chat('a', 'work'),
      chat('b', 'q3'),
      chat('c', 'deep'),
      chat('d', 'personal'),
      chat('e', null),
    ]);
    expect(tree.byId.get('deep')?.chatTotal).toBe(1);
    expect(tree.byId.get('q3')?.chatTotal).toBe(2);
    expect(tree.byId.get('work')?.chatTotal).toBe(3);
    expect(tree.roots[0].chats.map((row) => row.id)).toEqual(['a']);
  });

  it('reads a chat whose folder is gone as unfiled, never as filed somewhere else', () => {
    const tree = buildFolderTree(
      [folder('keep')],
      [
        chat('a', 'kept-id', { updatedAt: 5 }),
        chat('b', 'deleted', { updatedAt: 9 }),
      ],
    );
    // Neither chat is rendered under `keep`: 'a' points at an id that does not
    // exist, so it reads as unfiled exactly like 'b'.
    expect(tree.byId.get('keep')?.chats).toEqual([]);
    expect(tree.inboxChats.map((row) => row.id)).toEqual(['b', 'a']);
    expect(tree.chats).toHaveLength(2);
  });

  it('sorts filed chats most-recent first, like every other list', () => {
    const tree = buildFolderTree([folder('f')], [
      chat('old', 'f', { updatedAt: 10 }),
      chat('new', 'f', { updatedAt: 30 }),
    ]);
    expect(tree.byId.get('f')?.chats.map((row) => row.id)).toEqual(['new', 'old']);
  });

  it('handles the loading state (null lists) without a crash', () => {
    const tree = buildFolderTree(null, null);
    expect(tree.roots).toEqual([]);
    expect(tree.inboxChats).toEqual([]);
    expect(tree.chats).toEqual([]);
  });
});

describe('folderPath (the breadcrumb)', () => {
  const folders = [folder('work'), folder('q3', { parentId: 'work' }), folder('deep', { parentId: 'q3' })];

  it('walks root -> folder, so the crumbs read left to right', () => {
    expect(folderPath(folders, 'deep').map((entry) => entry.id)).toEqual(['work', 'q3', 'deep']);
    expect(folderPath(folders, 'work').map((entry) => entry.id)).toEqual(['work']);
  });

  it('answers [] for the root (null) and for an unknown id', () => {
    expect(folderPath(folders, null)).toEqual([]);
    expect(folderPath(folders, 'ghost')).toEqual([]);
  });

  it('cannot hang on a corrupt parent cycle', () => {
    const cycle = [folder('a', { parentId: 'b' }), folder('b', { parentId: 'a' })];
    expect(folderPath(cycle, 'a').length).toBeLessThanOrEqual(2);
  });
});

describe('folderChats and the label helpers', () => {
  it('lists one folder at a time, newest first, Inbox included', () => {
    const folders = [folder('f')];
    const chats = [chat('a', 'f', { updatedAt: 5 }), chat('b', null, { updatedAt: 9 })];
    expect(folderChats(chats, 'f', folders).map((row) => row.id)).toEqual(['a']);
    expect(folderChats(chats, null, folders).map((row) => row.id)).toEqual(['b']);
  });

  it('labels an empty count honestly ("0 chats"), not with a blank cell', () => {
    expect(itemCountLabel(1)).toBe('1 chat');
    expect(itemCountLabel(0)).toBe('0 chats');
    expect(messageCountLabel(3)).toBe('3 msgs');
    expect(itemsLabel(1)).toBe('1 item');
    expect(itemsLabel(4)).toBe('4 items');
  });
});

// ---------------------------------------------------------------------------
// M35 follow-up — the Assets column
// ---------------------------------------------------------------------------

describe('the Assets column (M35 follow-up: "indicate number of assets")', () => {
  it('labels a chat\'s saved assets, singular and plural, including none', () => {
    expect(assetCountLabel(1)).toBe('1 asset');
    expect(assetCountLabel(0)).toBe('0 assets');
    expect(assetCountLabel(7)).toBe('7 assets');
  });

  it('reads an absent count as 0 rather than rendering undefined', () => {
    // A web bundle can meet a core that predates the field (dev mode: a core
    // started before the upgrade). Absent is "not counted", never "NaN".
    expect(assetCountOf({ assetCount: 3 })).toBe(3);
    expect(assetCountOf({})).toBe(0);
    expect(assetCountOf({ assetCount: undefined })).toBe(0);
    expect(assetCountOf({ assetCount: Number.NaN })).toBe(0);
    expect(assetCountOf({ assetCount: -2 })).toBe(0);
  });

  it('sums a folder\'s SUBTREE, so a parent cannot read 0 while a child holds some', () => {
    const tree = buildFolderTree(
      [folder('work'), folder('q3', { parentId: 'work' })],
      [
        chat('a', 'work', { assetCount: 2 }),
        chat('b', 'q3', { assetCount: 3 }),
        chat('c', 'q3', { assetCount: 0 }),
        chat('d', null, { assetCount: 9 }),
      ],
    );
    expect(tree.byId.get('q3')?.assetTotal).toBe(3);
    expect(tree.byId.get('work')?.assetTotal).toBe(5);
    expect(tree.byId.get('q3')?.chatTotal).toBe(2);
  });

  it('renders the column on both row kinds, from one cell class', () => {
    expect(CONTENTS).toContain('className="explorer-cell-assets">Assets<');
    // Folder row = subtree total; chat row = the chat's own count.
    expect(CONTENTS).toContain('assetCountLabel(sub.assetTotal)');
    expect(CONTENTS).toContain('assetCountLabel(assetCountOf(chat))');
    // The column is declared once in the grid and dropped on a phone like the
    // rest of the metadata.
    expect(base('.explorer-row')).toContain(
      'grid-template-columns: minmax(0, 1fr) 64px 76px 76px 92px minmax(0, auto)',
    );
    expect(tier('(max-width: 640px)', '.explorer-cell-assets')).toContain('display: none');
    // Numeric cells keep the tabular figures the other metadata cells use.
    expect(base('.explorer-cell-assets')).toContain('font-variant-numeric: tabular-nums');
  });
});

// ---------------------------------------------------------------------------
// One definition per control, and one tree
// ---------------------------------------------------------------------------

describe('the Explorer reuses, it does not re-implement', () => {
  it('the folder-shaped reads live in one module (note-helpers re-exports them)', () => {
    // The M17 helpers moved so the rail, the notes selectors and the Folders
    // page cannot disagree about order, depth or dangling parents.
    expect(reExportedRows).toBe(folderTreeRows);
    expect(folderTreeRows([folder('b', { position: 1 }), folder('a')]).map((row) => row.folder.id)).toEqual([
      'a',
      'b',
    ]);
    expect(folderSubtreeIds([folder('a'), folder('b', { parentId: 'a' })], 'a')).toEqual(['a', 'b']);
  });

  it('the rail renders the folder row controls from the shared component', () => {
    expect(RAIL).toContain("import FolderActions from './FolderActions.js'");
    expect(RAIL).toContain("import ChatActions from './ChatActions.js'");
    // …and no hand-written cluster is left behind in the rail.
    expect(RAIL).not.toContain('folder-action-danger');
    expect(RAIL).not.toContain('rail-item-del-visible');
  });

  it('the contents pane renders the same two control components', () => {
    expect(CONTENTS).toContain("import FolderActions from './FolderActions.js'");
    expect(CONTENTS).toContain("import ChatActions from './ChatActions.js'");
    expect(CONTENTS).not.toContain('folder-action-danger');
    // The two-step delete lives in the shared components (one arm timer each).
    expect(FOLDER_ACTIONS).toContain('FOLDER_DELETE_ARM_MS');
    expect(CHAT_ACTIONS).toContain('CHAT_DELETE_ARM_MS');
    expect(CONTENTS).not.toContain('setTimeout');
  });

  it('the page derives its panes from ONE tree, and clamps the selection', () => {
    expect(VIEW).toContain('buildFolderTree(folders, conversations)');
    // A folder deleted while it was open falls back to the root rather than
    // rendering an empty page for something that is not there.
    expect(VIEW).toContain('tree.byId.has(selectedFolderId) ? selectedFolderId : null');
    expect(APP).toContain('foldersSelection');
    expect(APP).toMatch(/const foldersSelection =/);
    // The navigation pane is the rail in its folders-only mode.
    expect(RAIL).toContain('nav?: boolean');
    expect(RAIL).toContain('{nav ? null : folder.chats.map(renderChatWithThreads)}');
    expect(RAIL).toMatch(/aria-label=\{nav \? 'Folders' : 'Conversations'\}/);
  });

  it('navigates with Up and breadcrumbs instead of a hidden parent only', () => {
    expect(VIEW).toContain('onClick={() => onSelectFolder(current?.parentId ?? null)}');
    expect(VIEW).toContain('onClick={() => onSelectFolder(null)}');
    expect(VIEW).toContain("aria-label=\"Folder path\"");
    expect(VIEW).toContain('aria-current={current?.id === crumb.id ?');
  });

  it('creates the subfolder where the user is looking, from one Create field', () => {
    // The row's “+”: enter the folder, then open the field inside it.
    expect(VIEW).toMatch(/const addSubfolder = \(folderId: string\): void => \{\s*onSelectFolder\(folderId\);\s*startCreate\(folderId\);/);
    expect(VIEW).toContain('await onCreateFolder(name, createParent)');
    // One field: the toolbar and a row both route through startCreate.
    expect(VIEW).toContain('const startCreate = (parentId: string | null): void => {');
    expect(CONTENTS).toContain('onSubmit={(event) => void submitNew(event)}');
    // The empty state names the action that fills it (DESIGN.md contract).
    expect(CONTENTS).toContain('explorer-empty-title');
    expect(CONTENTS).toContain("folder === null ? '+ New folder' : '+ New subfolder'");
  });
});

// ---------------------------------------------------------------------------
// Geometry: two panes, three tiers, one scroll container
// ---------------------------------------------------------------------------

describe('the Explorer geometry', () => {
  it('lays out a navigation pane beside the contents pane', () => {
    const body = base('.explorer-body');
    expect(body).toContain('display: grid');
    expect(body).toContain('grid-template-columns: minmax(180px, 260px) minmax(0, 1fr)');
  });

  it('keeps one scroll container: the page, with a content-height tree', () => {
    const nav = base('.explorer-nav .rail-embedded');
    expect(nav).toContain('flex: none');
    expect(nav).toContain('overflow: visible');
  });

  it('stacks the panes on a phone and drops the metadata columns first', () => {
    expect(tier('(max-width: 640px)', '.explorer-body')).toContain(
      'grid-template-columns: minmax(0, 1fr)',
    );
    expect(tier('(max-width: 640px)', '.explorer-cell-type')).toContain('display: none');
    expect(tier('(max-width: 640px)', '.explorer-cell-items')).toContain('display: none');
  });

  it('floors the new controls on touch tiers (a control may look small, never be)', () => {
    for (const selector of ['.folder-select', '.explorer-open', '.explorer-crumb']) {
      expect(tier('(max-width: 1150px)', selector)).toContain('min-height: var(--target-min)');
    }
  });

  it('declares the row/selection states without inventing a border', () => {
    expect(base('.explorer-row')).toContain('border-radius: var(--radius-md)');
    expect(base('.folder-row-current')).toContain('background: var(--surface-2)');
    expect(CSS).not.toContain('.explorer-row {\n  border:');
    // Every new control carries hover/focus-visible/disabled.
    for (const selector of [
      '.explorer-crumb:focus-visible',
      '.explorer-crumb:hover:not(:disabled)',
      '.explorer-open:focus-visible',
      '.explorer-open:disabled',
      '.folder-select:focus-visible',
      '.folder-select:disabled',
    ]) {
      expect(base(selector).length).toBeGreaterThan(0);
    }
  });
});
