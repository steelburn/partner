/**
 * M14 assets-lane export helpers (pure; unit-tested).
 *
 * Export turns a saved asset back into a standalone `.md` file: a short
 * provenance blockquote (kind + save time) followed by the body verbatim —
 * the body is owner text and is never rewritten or truncated here. The
 * filename comes from the title with path/control characters dropped.
 */
import type { Asset } from '@partner/shared';
import { downloadTextFile } from './download.js';

/** Illegal filename characters (Windows + control chars) -> '-'. */
const ILLEGAL = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Slug used for download filenames — empty titles fall back to "asset". */
export function assetExportFileName(title: string): string {
  const cleaned = title
    .replace(ILLEGAL, '-')
    .replace(/-+/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[-\s]+|[-\s]+$/g, '');
  return `${cleaned === '' ? 'asset' : cleaned}.md`;
}

/**
 * A standalone markdown document: provenance blockquote then the raw body.
 * A blank body still produces a clean file (header only).
 */
export function buildAssetExportMarkdown(asset: Asset): string {
  const when = new Date(asset.createdAt).toISOString();
  const body = asset.body.trim();
  const head = `> Saved as a **${asset.kind}** asset on ${when} from this conversation.\n`;
  return body === '' ? `${head}\n` : `${head}\n${body}\n`;
}

/** Download the asset as `<title>.md` (browser only). */
export function exportAssetFile(asset: Asset): void {
  downloadTextFile(
    assetExportFileName(asset.title),
    buildAssetExportMarkdown(asset),
    'text/markdown',
  );
}
