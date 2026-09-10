/**
 * M11 F12 asset-code helpers (PLAN-M11.md) — how a `:::partner.asset
 * kind=code` container body renders inside the transcript.
 *
 * Pure + deterministic. The C3 guidance asks the model to emit the artifact
 * as clean markdown, so an HTML/CSS/JS artifact usually arrives as exactly
 * one fenced block. These helpers strip that fence for display (the code
 * must be readable inline, never hidden behind a tag) and expose a
 * previewable source — html/css only — for the F12 sandboxed viewer.
 */

export interface FencedCodeBody {
  /** Fence language tag when the body is one fenced block, else null. */
  lang: string | null;
  /** Code text without the fence markers. */
  code: string;
}

/** A fence-open line: ```lang / ~~~lang, optionally with extra info text
 *  (```js title="a"). Info strings never contain the fence character. */
const FENCE_OPEN = /^(`{3,}|~{3,})[ \t]*([A-Za-z0-9_+.#-]*)(?:[ \t]+[^`~]*)?$/;

/**
 * Inner code when the whole body is exactly one fenced block: a first line
 * ```lang (or ~~~lang), a closing fence of the same character and at least
 * the same length, and no fence line in between (so multiple blocks or a
 * trailing prose paragraph never match). Else null.
 */
export function singleFencedCode(body: string): FencedCodeBody | null {
  const lines = body.trim().split(/\r?\n/);
  if (lines.length < 3) return null;
  const open = FENCE_OPEN.exec(lines[0]?.trim() ?? '');
  if (open === null) return null;
  const marker = open[1] ?? '';
  const fenceChar = marker[0] ?? '`';
  const close = lines[lines.length - 1]?.trim() ?? '';
  const closeRe = new RegExp(`^\\${fenceChar}{${marker.length},}$`);
  if (!closeRe.test(close)) return null;
  const innerRe = new RegExp(`^\\s*\\${fenceChar}{3,}`);
  const inner = lines.slice(1, -1);
  if (inner.some((line) => innerRe.test(line))) return null;
  const lang = (open[2] ?? '').trim().toLowerCase();
  return { code: inner.join('\n').trim(), lang: lang === '' ? null : lang };
}

/** What to display for a code asset body (fence stripped when it is one). */
export function codeAssetBody(body: string): FencedCodeBody {
  return singleFencedCode(body) ?? { code: body.trim(), lang: null };
}

const PREVIEW_LANGS: ReadonlySet<string> = new Set(['html', 'css']);

/** Body looks like an unfenced HTML document/fragment (no fences at all). */
const RAW_HTML_START =
  /^<(?:!doctype|html|head|body|style|div|main|section|article|aside|header|footer|nav|h[1-6]|p|ul|ol|table|form|button|a|span|script|template)\b/i;

export interface CodePreviewSource {
  source: string;
  lang: 'html' | 'css';
}

/**
 * A previewable source when the code asset is HTML/CSS — a fenced block
 * tagged html/css, or an unfenced body that reads as an HTML fragment.
 * Everything else (js/py/sql/…) renders inline without a preview.
 */
export function codeAssetPreview(body: string): CodePreviewSource | null {
  const fenced = singleFencedCode(body);
  if (fenced !== null && fenced.lang !== null && PREVIEW_LANGS.has(fenced.lang)) {
    return { source: fenced.code, lang: fenced.lang as 'html' | 'css' };
  }
  const trimmed = body.trim();
  const raw =
    trimmed !== '' &&
    !trimmed.includes('```') &&
    !trimmed.includes('~~~') &&
    RAW_HTML_START.test(trimmed);
  if (raw) return { source: trimmed, lang: 'html' };
  return null;
}
