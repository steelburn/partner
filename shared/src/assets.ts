/**
 * M11 F10 asset wire contracts (PLAN-M11.md).
 *
 * Assets are typed, saved artifacts extracted from a conversation message
 * (document/table/code/reference list/image/deduction…) or declared by the
 * model via :::partner.asset containers (C3). Bodies are markdown; payload
 * bytes for images/code previews stay with the source attachment (F1). Owner
 * content — never audit (ids/kinds/lengths only).
 */
export type AssetKind =
  | 'document'
  | 'table'
  | 'code'
  | 'reference-list'
  | 'image'
  | 'deduction'
  | 'decision'
  | 'action'
  | 'definition'
  | 'draft'
  | 'chart'
  | 'quote'
  | 'custom';

export interface AssetMeta {
  id: string;
  conversationId: string;
  /** Source message when extracted from a turn (null = manual). */
  messageId: string | null;
  kind: AssetKind;
  title: string;
  tags: string[];
  createdAt: number;
}

export interface Asset extends AssetMeta {
  body: string;
}

export interface AssetInput {
  kind: AssetKind;
  title: string;
  body: string;
  /** Optional source message id (provenance). */
  messageId?: string;
  tags?: string[];
}

export const ASSET_KINDS: readonly AssetKind[] = [
  'document',
  'table',
  'code',
  'reference-list',
  'image',
  'deduction',
  'decision',
  'action',
  'definition',
  'draft',
  'chart',
  'quote',
  'custom',
] as const;

export function isAssetKind(value: unknown): value is AssetKind {
  return typeof value === 'string' && (ASSET_KINDS as readonly string[]).includes(value);
}

/** M16 F4 (PLAN-M16.md): how a Discuss action relates to the asset's origin
 *  conversation. 'continue' = open the same discussion (origin conversation)
 *  with the asset in the composer; 'fork' = a new conversation that is a
 *  child thread of the origin (when it still exists) carrying the asset. */
export type AssetDiscussMode = 'continue' | 'fork';

export interface AssetDiscussResult {
  conversationId: string;
  /** Which mode actually applied (continue degrades to fork when the origin
   *  conversation no longer exists). */
  mode: AssetDiscussMode;
  assetId: string;
  /** Origin conversation id when known (may equal conversationId). */
  originConversationId: string | null;
}
