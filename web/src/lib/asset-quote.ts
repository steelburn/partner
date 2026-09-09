/**
 * M16 F4 (PLAN-M16.md): the composer quote inserted when the user Discusses
 * an asset — provenance header + the asset body (bounded) so the model sees
 * the artifact when the user sends the turn. Pure; no fetch, no tokens.
 */
import type { Asset } from '@partner/shared';

/** Content cap for a quoted asset body (bigger bodies truncate + note). */
export const DISCUSS_QUOTE_CHARS = 12000;

/** Markdown blockquote for an asset's body with a provenance line. */
export function buildAssetDiscussQuote(asset: Asset): string {
  const body =
    asset.body.length > DISCUSS_QUOTE_CHARS
      ? `${asset.body.slice(0, DISCUSS_QUOTE_CHARS)}…`
      : asset.body;
  const provenance = `Discussing asset “${asset.title}” (${asset.kind}) — saved from a Partner conversation.`;
  return `${provenance}\n\n${body}`.trim();
}
