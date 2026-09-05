/**
 * M11 F1 chat-attachment wire contracts (PLAN-M11.md).
 *
 * Meta only — payload bytes never cross the API except through the
 * conversation-scoped /content route (also used by F12 preview).
 */
export interface AttachmentMeta {
  id: string;
  conversationId: string;
  /** Null while staged (uploaded; the next turn has not been sent). */
  messageId: string | null;
  name: string;
  mime: string;
  size: number;
  /** True when text was extracted (model context) or the type is an image. */
  extractable: boolean;
  createdAt: number;
}
