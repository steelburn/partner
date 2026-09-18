/**
 * Conversation manager tests (PLAN-M3.md): create (with persona binding
 * validation), append (ordering, counts, updated_at bump), list with
 * messageCount (recent first), get {summary, messages}, remove cascade, and
 * typed not_found errors for unknown conversations.
 */
import { describe, expect, it } from 'vitest';
import {
  createAssetStore,
  createAuditStore,
  createConversationStore,
  createMessageStore,
  createPersonaStore,
  openDatabase,
} from '../../src/stores/db.js';
import type { AssetStore } from '../../src/stores/types.js';
import { auditLog } from '../../src/services/redaction.js';
import { createConversationManager } from '../../src/conversations/manager.js';
import type { ConversationManager } from '../../src/conversations/manager.js';
import { createPersonaManager } from '../../src/personas/manager.js';
import type { PersonaManager } from '../../src/personas/manager.js';
import { ConversationError } from '../../src/conversations/errors.js';

function makeWorld(now?: () => number): {
  conversations: ConversationManager;
  personas: PersonaManager;
  audit: ReturnType<typeof auditLog>;
} {
  const db = openDatabase(':memory:');
  const audit = auditLog({ store: createAuditStore(db) });
  const personaStore = createPersonaStore(db);
  const personas = createPersonaManager({ store: personaStore, audit });
  personas.seedIfEmpty();
  const conversations = createConversationManager({
    personaStore,
    stores: { conversations: createConversationStore(db), messages: createMessageStore(db) },
    audit,
    now,
  });
  return { conversations, personas, audit };
}

/** The same world with an asset store wired (M35 assetCount). */
function makeAssetWorld(): { conversations: ConversationManager; assets: AssetStore } {
  const db = openDatabase(':memory:');
  const audit = auditLog({ store: createAuditStore(db) });
  const assets = createAssetStore(db);
  const conversations = createConversationManager({
    assetStore: assets,
    stores: { conversations: createConversationStore(db), messages: createMessageStore(db) },
    audit,
  });
  return { conversations, assets };
}

function assetRow(id: string, conversationId: string): Parameters<AssetStore['insert']>[0] {
  return {
    id,
    conversationId,
    messageId: null,
    kind: 'document',
    title: `Asset ${id}`,
    body: 'body',
    tags: null,
    createdAt: 1,
  };
}

function expectConversationError(fn: () => unknown, code: string): void {
  let thrown: unknown = null;
  try {
    fn();
  } catch (err) {
    thrown = err;
  }
  expect(thrown).toBeInstanceOf(ConversationError);
  expect((thrown as ConversationError).code).toBe(code);
}

describe('conversation create', () => {
  it('creates an unbound conversation with title + count 0 and lists it', () => {
    const { conversations } = makeWorld();
    const summary = conversations.create({ title: 'First chat' });
    expect(summary).toMatchObject({
      id: expect.any(String),
      personaId: null,
      title: 'First chat',
      messageCount: 0,
    });
    expect(typeof summary.createdAt).toBe('number');
    expect(conversations.list()).toHaveLength(1);
    expect(conversations.list()[0]).toEqual(summary);
  });

  it('binds an existing persona; refuses an unknown one (not_found)', () => {
    const { conversations } = makeWorld();
    const bound = conversations.create({ personaId: 'p-researcher' });
    expect(bound.personaId).toBe('p-researcher');
    expectConversationError(() => conversations.create({ personaId: 'p-nope' }), 'not_found');
    expectConversationError(() => conversations.create({ personaId: '' }), 'invalid_input');
  });

  it('creating under a PAUSED persona is fine (creating is allowed)', () => {
    const { conversations, personas } = makeWorld();
    personas.pause('p-scribe');
    const summary = conversations.create({ personaId: 'p-scribe', title: 'later' });
    expect(summary.personaId).toBe('p-scribe');
  });
});

describe('append + get ordering', () => {
  it('appends user+assistant, returns the stored message, and get() orders ASC', () => {
    const { conversations } = makeWorld();
    const conv = conversations.create({ personaId: 'p-researcher', title: 'Q&A' });
    const userMsg = conversations.append(conv.id, 'user', { content: 'Hi there' });
    expect(userMsg).toMatchObject({
      conversationId: conv.id,
      role: 'user',
      personaId: 'p-researcher',
      content: 'Hi there',
      model: null,
      latencyMs: null,
    });
    const assistantMsg = conversations.append(conv.id, 'assistant', {
      content: 'Hello!',
      model: 'demo',
      latencyMs: 12,
    });
    expect(assistantMsg.model).toBe('demo');
    expect(assistantMsg.latencyMs).toBe(12);

    const detail = conversations.get(conv.id);
    expect(detail.summary.messageCount).toBe(2);
    expect(detail.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(detail.messages.map((m) => m.id)).toEqual([userMsg.id, assistantMsg.id]);
    expect(detail.summary.updatedAt).toBe(assistantMsg.createdAt);
  });

  it('bumps updated_at on append so list() is recent-first', () => {
    // Monotonic clock so no two writes share a millisecond.
    let t = 0;
    const { conversations } = makeWorld(() => ++t);
    const older = conversations.create({ title: 'older' });
    const newer = conversations.create({ title: 'newer' });
    // Touching `older` moves it to the front of list().
    conversations.append(older.id, 'user', { content: 'ping' });
    expect(conversations.list().map((c) => c.id)).toEqual([older.id, newer.id]);
    expect(conversations.list()[0]?.messageCount).toBe(1);
    expect(conversations.list()[1]?.messageCount).toBe(0);
  });
});

describe('guards', () => {
  it('append/get/remove on an unknown conversation -> typed not_found', () => {
    const { conversations } = makeWorld();
    expectConversationError(() => conversations.append('nope', 'user', { content: 'x' }), 'not_found');
    expectConversationError(() => conversations.get('nope'), 'not_found');
    expectConversationError(() => conversations.remove('nope'), 'not_found');
  });

  it('rejects roles outside system|user|assistant', () => {
    const { conversations } = makeWorld();
    const conv = conversations.create({});
    expectConversationError(
      () => conversations.append(conv.id, 'elvis' as never, { content: 'x' }),
      'invalid_input',
    );
    expectConversationError(
      () => conversations.append(conv.id, 'user', { content: 42 as never }),
      'invalid_input',
    );
  });
});

describe('remove cascade', () => {
  it('deletes the conversation AND its messages', () => {
    const { conversations } = makeWorld();
    const conv = conversations.create({ title: 'gone soon' });
    conversations.append(conv.id, 'user', { content: 'one' });
    conversations.append(conv.id, 'assistant', { content: 'two' });
    conversations.remove(conv.id);
    expectConversationError(() => conversations.get(conv.id), 'not_found');
    expect(conversations.list()).toHaveLength(0);
  });
});

describe('assetCount (M35 — the Folders Assets column)', () => {
  it('counts the assets saved for each chat, in list() and in get()', () => {
    const { conversations, assets } = makeAssetWorld();
    const withAssets = conversations.create({ title: 'has assets' });
    const empty = conversations.create({ title: 'none' });
    assets.insert(assetRow('a1', withAssets.id));
    assets.insert(assetRow('a2', withAssets.id));
    assets.insert(assetRow('a3', empty.id));
    assets.remove('a3');

    // Order-independent: `list()` is recent-first and both rows share a
    // timestamp here, so only the counts are the claim.
    const counts = new Map(conversations.list().map((row) => [row.id, row.assetCount]));
    expect(counts.size).toBe(2);
    expect(counts.get(withAssets.id)).toBe(2);
    expect(counts.get(empty.id)).toBe(0);
    expect(conversations.get(withAssets.id).summary.assetCount).toBe(2);
    expect(conversations.get(empty.id).summary.assetCount).toBe(0);
  });

  it('reports 0 — not a crash or a stale number — with no asset store wired', () => {
    const { conversations } = makeWorld();
    const conv = conversations.create({ title: 'no assets table' });
    expect(conv.assetCount).toBe(0);
    expect(conversations.list()[0]?.assetCount).toBe(0);
    expect(conversations.get(conv.id).summary.assetCount).toBe(0);
  });

  it('carries the count through a rename/folder move, which returns a summary', () => {
    const { conversations, assets } = makeAssetWorld();
    const conv = conversations.create({ title: 'moves around' });
    assets.insert(assetRow('a1', conv.id));
    expect(conversations.update(conv.id, { folderId: 'f1' }).assetCount).toBe(1);
    expect(conversations.update(conv.id, {}).assetCount).toBe(1);
  });

  it('never leaks asset BODIES or titles into audit while counting', () => {
    const { conversations, assets } = makeAssetWorld();
    const conv = conversations.create({ title: 'audit' });
    assets.insert({ ...assetRow('a1', conv.id), title: 'Secret title', body: 'secret-body-xyz' });
    conversations.list();
    conversations.get(conv.id);
    expect(assets.countsByConversation()).toEqual([{ conversationId: conv.id, count: 1 }]);
  });
});

describe('audit rows (ids + lengths, never content)', () => {
  it('conversation.create and message.append carry ids/lengths only', () => {
    const { conversations, audit } = makeWorld();
    const secretContent = 'super-secret-chat-content-abc123';
    const replyContent = 'demo: received characters';
    const conv = conversations.create({ personaId: 'p-analyst', title: 'Numbers' });
    conversations.append(conv.id, 'user', { content: secretContent });
    conversations.append(conv.id, 'assistant', { content: replyContent });

    const rows = audit.list(100);
    const creates = rows.filter((r) => r.action === 'conversation.create');
    const appends = rows.filter((r) => r.action === 'message.append');
    expect(creates.length).toBeGreaterThanOrEqual(1);
    expect(appends.length).toBe(2);

    const blob = rows.map((r) => JSON.stringify(r)).join('\n');
    expect(blob).not.toContain(secretContent);
    expect(blob).not.toContain(replyContent);
    // Ids and lengths ARE present (audit list is newest-first, so the first
    // append row is the assistant message).
    expect(appends[0]?.target).toMatch(/^[0-9a-f-]{36}$/);
    const newest = JSON.parse(appends[0]?.details ?? '{}') as Record<string, unknown>;
    const oldest = JSON.parse(appends[1]?.details ?? '{}') as Record<string, unknown>;
    expect(newest.contentLength).toBe(replyContent.length);
    expect(oldest.contentLength).toBe(secretContent.length);
    expect(oldest.role).toBe('user');
    expect(JSON.parse(creates[0]?.details ?? '{}')).toMatchObject({ personaId: 'p-analyst' });
  });
});
