/**
 * M11 F10 assets manager (PLAN-M11.md).
 *
 * Typed saved artifacts per conversation. Bodies are owner content (never
 * audit). Promote turns an asset into a Note (M5) with a provenance header
 * linking back to the conversation, so assets are the chat -> notes bridge
 * the Notes-first architecture (F6) depends on.
 */
import { randomUUID } from 'node:crypto';
import type { Asset, AssetInput, AssetKind, AssetMeta, NoteInput } from '@partner/shared';
import { isAssetKind } from '@partner/shared';
import type { NoteManager } from '../notes/index.js';
import type { AuditService } from '../services/redaction.js';
import type { AssetRow, AssetStore } from '../stores/types.js';
import { AssetError, assetError } from './errors.js';

export const MAX_ASSET_BODY_CHARS = 200_000;
export const MAX_ASSET_TITLE_CHARS = 200;

export interface AssetManagerOptions {
  store: AssetStore;
  /** Optional note manager — promotes to notes (F6 handshake). */
  notes?: NoteManager;
  audit: AuditService;
  now?: () => number;
}

export interface AssetManager {
  create(conversationId: string, input: AssetInput): AssetMeta;
  /** List with bodies (local single-user store; bodies stay small-capped). */
  list(conversationId: string): Asset[];
  remove(conversationId: string, id: string): void;
  /** Create a Note from the asset body with a provenance header. */
  promote(conversationId: string, id: string): { noteId: string };
}

function toMeta(row: AssetRow): AssetMeta {
  return {
    id: row.id,
    conversationId: row.conversationId,
    messageId: row.messageId,
    kind: row.kind as AssetKind,
    title: row.title,
    tags: row.tags === null ? [] : (JSON.parse(row.tags) as string[]),
    createdAt: row.createdAt,
  };
}

function toAsset(row: AssetRow): Asset {
  return { ...toMeta(row), body: row.body };
}

export function createAssetManager(options: AssetManagerOptions): AssetManager {
  const { store, audit } = options;
  const notes = options.notes;
  const now = options.now ?? Date.now;

  function create(conversationId: string, input: AssetInput): AssetMeta {
    const body = (input ?? {}) as AssetInput;
    const kind: AssetKind = isAssetKind(body.kind) ? body.kind : 'custom';
    const title =
      typeof body.title === 'string' ? body.title.trim().slice(0, MAX_ASSET_TITLE_CHARS) : '';
    const content = typeof body.body === 'string' ? body.body : '';
    if (title === '') throw assetError('invalid_input', 'asset title is required');
    if (content === '') throw assetError('invalid_input', 'asset body is required');
    if (content.length > MAX_ASSET_BODY_CHARS) {
      throw assetError(
        'too_large',
        `asset bodies are capped at ${MAX_ASSET_BODY_CHARS} characters`,
      );
    }
    const tags = Array.isArray(body.tags)
      ? body.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 20)
      : [];
    const messageId =
      body.messageId !== undefined && body.messageId !== null ? body.messageId : null;
    const at = now();
    const id = randomUUID();
    const row: AssetRow = {
      id,
      conversationId,
      messageId,
      kind,
      title,
      body: content,
      tags: tags.length > 0 ? JSON.stringify(tags) : null,
      createdAt: at,
    };
    store.insert(row);
    audit.log('web', 'asset.create', id, {
      conversationId,
      kind,
      titleLength: title.length,
      bodyLength: content.length,
      messageId,
    });
    return toMeta(row);
  }

  function list(conversationId: string): Asset[] {
    return store.listByConversation(conversationId).map(toAsset);
  }

  function remove(conversationId: string, id: string): void {
    const row = store.findById(id);
    if (!row || row.conversationId !== conversationId) {
      throw assetError('not_found', 'asset not found');
    }
    store.remove(id);
    audit.log('web', 'asset.delete', id, { conversationId });
  }

  function promote(conversationId: string, id: string): { noteId: string } {
    const row = store.findById(id);
    if (!row || row.conversationId !== conversationId) {
      throw assetError('not_found', 'asset not found');
    }
    if (!notes) {
      throw assetError('not_found', 'note promotion is unavailable (notes not wired)');
    }
    const provenance = [
      '> Saved from a Partner conversation (asset "' + row.title + '").',
      '> Source: conversation ' +
        conversationId +
        (row.messageId !== null ? ', message ' + row.messageId : ''),
      '',
    ].join('\n');
    const input: NoteInput = {
      title: row.title,
      content: `${provenance}${row.body}\n`,
      tags: toMeta(row).tags,
    };
    const note = notes.create(input, 'promote');
    audit.log('web', 'asset.promote', row.id, { noteId: note.id, conversationId });
    return { noteId: note.id };
  }

  return { create, list, remove, promote };
}
