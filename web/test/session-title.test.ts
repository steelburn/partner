/**
 * M34 — the Folders section and the session-title header (PLAN-M34.md).
 *
 * The request, in two parts:
 *   1. "For organization of the chats, I'd like to have dedicated Folders
 *      section. Meaning, a chat session will have Persona-based organization,
 *      and Folder-based organization."
 *   2. "write chat session title at the top. Make it editable/AI-suggestible —
 *      meaning the chat topic can be reviewed after a few back and forth."
 *
 * Node-only suite, so the claims are pinned two ways:
 *   - the PURE parts (the turn threshold, the display read, the input clamp, the
 *     honesty note, the folder stats, the client wire shape) are unit-tested;
 *   - the STRUCTURE is pinned against the real sources, the way
 *     `one-left-panel.test.ts` and `sidebar-collapse.test.ts` do, because the
 *     regression this feature guards is exactly a wiring one: a second
 *     conversation tree, a suggestion that writes without being accepted, or a
 *     title control that is unreachable on a phone.
 */
import { describe, expect, it } from 'vitest';
import { MOBILE_MORE, MOBILE_TABS, NAV_GROUPS, NAV_LABELS } from '../src/lib/nav.js';
import {
  TITLE_MAX_CHARS,
  TITLE_MIN_USER_TURNS,
  canSuggestTitle,
  countTitleUserTurns,
  normalizeTitleInput,
  suggestTitleHint,
  suggestionSourceNote,
  titleForDisplay,
} from '../src/lib/session-title.js';
import { folderStats, statsLine } from '../src/FoldersView.js';
import { suggestConversationTitle } from '../src/lib/conversations.js';
import { source } from './helpers/css.js';
import type { ConversationSummary, Folder } from '@partner/shared';

const APP = source('src/App.tsx');
const CHAT = source('src/ChatStrip.tsx');
const RAIL = source('src/ConversationRail.tsx');
const FOLDERS_VIEW = source('src/FoldersView.tsx');
const CSS = source('src/app.css');

// ---------------------------------------------------------------------------
// The turn threshold: "after a few back and forth"
// ---------------------------------------------------------------------------

describe('canSuggestTitle', () => {
  const row = (role: string, text: string): { role: string; text: string } => ({ role, text });

  it('offers a title only after a couple of user turns', () => {
    expect(canSuggestTitle([])).toBe(false);
    expect(canSuggestTitle([row('user', 'hello')])).toBe(false);
    expect(canSuggestTitle([row('user', 'hello'), row('assistant', 'hi')])).toBe(false);
    expect(canSuggestTitle([row('user', 'a'), row('assistant', 'b'), row('user', 'c')])).toBe(true);
    expect(TITLE_MIN_USER_TURNS).toBe(2);
  });

  it('does not count empty turns or the partner\'s own replies', () => {
    expect(countTitleUserTurns([row('user', '   '), row('assistant', 'a'), row('system', 's')])).toBe(
      0,
    );
    expect(canSuggestTitle([row('assistant', 'a'), row('assistant', 'b')])).toBe(false);
  });

  it('says WHY the action is unavailable, so a disabled control is not a dead end', () => {
    expect(suggestTitleHint([row('user', 'hello')])).toContain('couple of turns');
    expect(suggestTitleHint([row('user', 'a'), row('user', 'b')])).toBeUndefined();
  });
});

describe('titleForDisplay / normalizeTitleInput / suggestionSourceNote', () => {
  it('reads an unnamed session as the same string the rails use', () => {
    expect(titleForDisplay(null)).toBe('New chat');
    expect(titleForDisplay(undefined)).toBe('New chat');
    expect(titleForDisplay('   ')).toBe('New chat');
    expect(titleForDisplay('  Key rotation ')).toBe('Key rotation');
  });

  it('collapses whitespace and clamps to what the core stores', () => {
    expect(normalizeTitleInput('  a \n\n b  ')).toBe('a b');
    const long = normalizeTitleInput('x'.repeat(400));
    expect(long.length).toBe(TITLE_MAX_CHARS);
  });

  it('never lets a derived suggestion read as if a model named it', () => {
    expect(suggestionSourceNote('transcript')).toContain('No model named this');
    expect(suggestionSourceNote('model')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The client wire shape
// ---------------------------------------------------------------------------

describe('suggestConversationTitle', () => {
  function reply(body: unknown, status = 200) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = async (input: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url: input, init });
      return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    };
    return { fetchImpl, calls };
  }

  it('POSTs to the suggestion route with the bearer token and no body payload', async () => {
    const { fetchImpl, calls } = reply({
      ok: true,
      title: 'Key rotation',
      model: 'fake-model',
      source: 'model',
      userTurns: 2,
      messageCount: 4,
    });
    const result = await suggestConversationTitle('tok-secret', 'c 1', { fetchImpl });
    expect(result).toEqual({
      ok: true,
      title: 'Key rotation',
      model: 'fake-model',
      source: 'model',
      userTurns: 2,
      messageCount: 4,
    });
    expect(calls[0]?.url).toBe('/v1/conversations/c%201/title-suggestion');
    expect(calls[0]?.init?.method).toBe('POST');
    expect((calls[0]?.init?.headers as Record<string, string>).authorization).toBe(
      'Bearer tok-secret',
    );
    // Nothing about the conversation is re-sent: the core reads its own store.
    expect(calls[0]?.init?.body).toBe('{}');
  });

  it('passes an unusable-reply sentence through as a 200 result, not an error', async () => {
    const { fetchImpl } = reply({
      ok: false,
      code: 'unusable_reply',
      message: 'the model returned no usable title',
    });
    await expect(suggestConversationTitle('t', 'c', { fetchImpl })).resolves.toEqual({
      ok: false,
      code: 'unusable_reply',
      message: 'the model returned no usable title',
    });
  });

  it('treats a transport failure as an error with the core\'s own message', async () => {
    const { fetchImpl } = reply(
      { error: 'not_enough_context', message: 'the session needs a few turns' },
      400,
    );
    await expect(suggestConversationTitle('t', 'c', { fetchImpl })).rejects.toThrowError(
      /needs a few turns/,
    );
  });

  it('refuses a body it cannot read as a proposal', async () => {
    const { fetchImpl } = reply({ title: 'no ok flag' });
    await expect(suggestConversationTitle('t', 'c', { fetchImpl })).rejects.toThrowError(
      /unexpected shape/,
    );
  });
});

// ---------------------------------------------------------------------------
// The Folders section
// ---------------------------------------------------------------------------

function folder(id: string, name = id): Folder {
  return {
    id,
    name,
    parentId: null,
    position: 0,
    chatCount: 0,
    noteCount: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

function chat(id: string, folderId: string | null): ConversationSummary {
  return {
    id,
    personaId: null,
    title: null,
    folderId,
    messageCount: 0,
    createdAt: 0,
    updatedAt: 0,
  };
}

describe('folderStats / statsLine', () => {
  it('counts filed vs unfiled without trusting a dangling folder id', () => {
    const stats = folderStats(
      [folder('f1'), folder('f2')],
      [chat('a', 'f1'), chat('b', null), chat('c', 'gone'), chat('d', 'f2')],
    );
    expect(stats).toEqual({ folders: 2, filed: 2, unfiled: 2, total: 4 });
  });

  it('handles the loading state (null lists) as empty, not as a crash', () => {
    expect(folderStats(null, null)).toEqual({ folders: 0, filed: 0, unfiled: 0, total: 0 });
    expect(statsLine(folderStats(null, null))).toBe('');
  });

  it('says nothing on a true first run, and says the one useful thing after that', () => {
    expect(statsLine(folderStats([folder('f1')], [chat('a', 'f1')]))).toBe(
      '1 folder · 1 chat (1 filed, 0 in Inbox)',
    );
    expect(statsLine(folderStats([folder('f1')], [chat('a', null)]))).toBe(
      '1 folder · 1 chat, none filed yet',
    );
  });
});

describe('the Folders destination', () => {
  it('sits in Workspace directly under Chat, and is reachable on a phone', () => {
    const workspace = NAV_GROUPS.find((group) => group.name === 'Workspace');
    expect(workspace?.views).toEqual(['chat', 'folders', 'notes', 'shared']);
    expect(NAV_LABELS.folders).toBe('Folders');
    // The phone reaches it from the More sheet (tabs stay at the 5-slot cap).
    expect(MOBILE_MORE).toContain('folders');
    expect(MOBILE_TABS).not.toContain('folders');
  });

  it('renders ONE folder tree — the same rail, in its navigation-pane mode', () => {
    // The M32 failure mode was a control with a single inconsistent home. M35
    // makes the SAME rail the Folders page's navigation pane (`nav: true`:
    // folders only, selectable); the page never builds a second tree.
    expect(APP).toMatch(
      /board=\{conversationRail\(true, \{\s*selectedFolderId: foldersSelection,\s*onSelectFolder: setFoldersNavId,\s*\}\)\}/,
    );
    expect(APP).toContain("view === 'folders'");
    expect(APP).toContain('nav={navPane !== null}');
    // The page header carries New chat (the rail head is suppressed in nav
    // mode), so the rail's empty state still lands on a control that is there.
    expect(APP).toContain('onNewChat={() => void handleNewChat()}');
    expect(FOLDERS_VIEW).toContain('className="page-actions"');
    // …and it is the same factory, used once per surface.
    const railCalls = APP.match(/conversationRail\((true|false)/g) ?? [];
    expect(railCalls).toEqual(['conversationRail(false', 'conversationRail(true']);
    // FoldersView owns no folder CONTROLS of its own: the folder row's
    // controls are the shared FolderActions (the rail renders it too), and the
    // page's own rows are built in FolderContents.
    expect(FOLDERS_VIEW).not.toContain('folder-action');
    expect(FOLDERS_VIEW).toContain("import FolderContents from './FolderContents.js'");
  });

  it('shows the folders you own even when no chat is filed yet', () => {
    // The rail used to render its empty note whenever the CONVERSATION list was
    // empty, which hid the folder tree on a page whose whole job is folders.
    expect(RAIL).toContain('list.length === 0 && !anyFolders ?');
  });

  it('owns its scroll and does not nest a second one in the page', () => {
    expect(CSS).toContain('.folders {');
    const page = CSS.slice(CSS.indexOf('.folders {'), CSS.indexOf('.folders-panel {'));
    expect(page).toContain('overflow-y: auto');
    // Inside the page the rail is content-height, so the page stays the only
    // scroll container.
    const nav = CSS.slice(CSS.indexOf('.explorer-nav .rail-embedded {'));
    expect(nav.slice(0, nav.indexOf('}'))).toContain('flex: none');
    expect(nav.slice(0, nav.indexOf('}'))).toContain('overflow: visible');
    // The rail's "New chat" head is suppressed in the navigation pane: a
    // full-width primary button would read as the page's primary action, and
    // the sidebar already carries that action on desktop (the phone's floating
    // rail keeps its own). M35 does it in the markup, so `hidden` has to win
    // over the head's own display rule.
    expect(RAIL).toContain('<div className="rail-head" hidden={nav}>');
    expect(CSS).toContain('.rail-head[hidden],');
    // The folder row's own actions are hover-revealed by default, so a
    // no-hover device must reveal them too — Folders reaches the phone.
    const noHover = CSS.slice(CSS.indexOf('@media (hover: none) {'));
    expect(noHover.slice(0, noHover.indexOf('.rail-item-drag'))).toContain('.folder-actions {');
  });
});

// ---------------------------------------------------------------------------
// The session title header
// ---------------------------------------------------------------------------

describe('the chat session header', () => {
  it('shows the title at the top of the chat, above the transcript', () => {
    const header = CHAT.indexOf('className="chat-session"');
    const transcript = CHAT.indexOf('className="chat-transcript"');
    expect(header).toBeGreaterThan(-1);
    expect(header).toBeLessThan(transcript);
    expect(CHAT).toContain('className="chat-session-title"');
    // It is a heading for the session, and the stored title is the shell's copy.
    expect(CHAT).toContain('<h2 className="chat-session-title"');
    expect(CHAT).toContain('sessionTitle = null');
  });

  it('is editable in place: save, cancel, Escape, and the core\'s own cap', () => {
    expect(CHAT).toContain('aria-label="Session title"');
    expect(CHAT).toContain('maxLength={TITLE_MAX_CHARS}');
    expect(CHAT).toContain('normalizeTitleInput(titleDraft)');
    expect(CHAT).toContain("event.key === 'Escape'");
    expect(CHAT).toMatch(/>\s*Save\s*</);
    expect(CHAT).toMatch(/>\s*Cancel\s*</);
    // A rename can only be started once there is something to name.
    expect(CHAT).toContain("title={conversationId === null ? 'Send a message first' : undefined}");
  });

  it('SUGGESTS without storing: the proposal is reviewed, then accepted', () => {
    expect(CHAT).toContain('suggestConversationTitle(token, conversationId)');
    // The suggestion path never writes…
    const suggest = CHAT.slice(CHAT.indexOf('const requestTitleSuggestion'));
    const suggestionBody = suggest.slice(0, suggest.indexOf('const acceptTitleSuggestion'));
    expect(suggestionBody).not.toContain('onRenameSession');
    // …the acceptance is what writes, through the one shell-held path.
    const accept = CHAT.slice(CHAT.indexOf('const acceptTitleSuggestion'));
    expect(accept.slice(0, accept.indexOf('};'))).toContain(
      'onRenameSession?.(suggestion.title)',
    );
    expect(CHAT).toMatch(/>\s*Use title\s*</);
    expect(CHAT).toMatch(/>\s*Dismiss\s*</);
  });

  it('gates the action on the turn threshold and explains the gate', () => {
    expect(CHAT).toContain('canSuggestTitle(rows)');
    expect(CHAT).toContain('suggestTitleHint(rows)');
    expect(CHAT).toContain('disabled={conversationId === null || suggesting || !canSuggest}');
  });

  it('keeps a derived suggestion honest in the UI', () => {
    expect(CHAT).toContain('suggestionSourceNote(suggestion.source)');
  });

  it('is wired by the shell to the one title write path', () => {
    expect(APP).toContain('sessionTitle={activeConversationTitle}');
    expect(APP).toContain('onRenameSession={handleRenameConversation}');
    // The shells' write is the ordinary conversation update + a list refresh,
    // so the header can never show a stale name.
    const handler = APP.slice(APP.indexOf('const handleRenameConversation'));
    const body = handler.slice(0, handler.indexOf('const handleCreateFolder'));
    expect(body).toContain('updateConversation(token, id, { title })');
    expect(body).toContain('await refreshConversations()');
  });

  it('declares its states in CSS, including reduced motion for anything that moves', () => {
    for (const selector of [
      '.chat-session-title {',
      '.chat-session-action {',
      '.chat-session-proposal {',
      '.chat-session-note {',
    ]) {
      expect(CSS).toContain(selector);
    }
    // The header itself introduces no motion; the controls it uses (`btn-link`,
    // `btn`) carry their own hover/focus-visible/disabled rules.
    expect(CSS).toMatch(/\.btn-link:focus-visible \{/);
    expect(CSS).toMatch(/\.btn-link:disabled \{/);
  });
});
