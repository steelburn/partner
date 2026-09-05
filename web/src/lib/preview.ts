/**
 * M11 F12 code preview builder (PLAN-M11.md).
 *
 * Pure, DOM-free: takes untrusted HTML and returns a hardened `srcdoc`
 * string plus a report of blocked external references. Scripts are removed
 * unless `allowScripts`; a CSP meta forbids network; external http(s) refs
 * are stripped and reported; data: images survive.
 */
export interface PreviewBuildOptions {
  allowScripts?: boolean;
}

export interface PreviewReport {
  /** External resource references that were blocked/stripped. */
  blocked: string[];
}

const CSP_META =
  '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; media-src data:">';

/** Strip <script> blocks (whole tags, any case, single-line or spanning). */
function stripScripts(html: string): string {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<script\b[^>]*\/>/gi, '');
}

/** Rewrite external http(s) URLs out of src/href/style-attr contexts. */
function stripExternalRefs(html: string): { html: string; blocked: string[] } {
  const blocked: string[] = [];
  const urlRe = /\b(?:src|href)\s*=\s*(["'])(https?:\/\/[^"']+)\1/gi;
  let cleaned = html.replace(urlRe, (_all, _quote, url: string) => {
    blocked.push(url);
    return '';
  });
  // <link rel=stylesheet href=...> handled above via href; @import inside
  // <style> is rare in chat-scale HTML — strip it too.
  cleaned = cleaned.replace(/@import\s+(?:url\()?["']?https?:\/\/[^;]+;?/gi, '');
  return { html: cleaned, blocked };
}

/** Cap the doc size so a huge paste cannot freeze the renderer. */
const MAX_PREVIEW_CHARS = 1_000_000;

export function buildPreviewDoc(
  rawHtml: string,
  options: PreviewBuildOptions = {},
): { doc: string; report: PreviewReport } {
  const html = rawHtml.length > MAX_PREVIEW_CHARS ? rawHtml.slice(0, MAX_PREVIEW_CHARS) : rawHtml;
  const scriptless = options.allowScripts === true ? html : stripScripts(html);
  const { html: safeRefs, blocked } = stripExternalRefs(scriptless);

  if (/<!doctype|<html/i.test(safeRefs)) {
    // Full document: inject the CSP meta into its head when one exists.
    const doc = safeRefs.includes('<head')
      ? safeRefs.replace(/<head([^>]*)>/i, `<head$1>\n${CSP_META}`)
      : safeRefs;
    return { doc, report: { blocked } };
  }

  // Fragment: build a minimal standalone document around it.
  const doc = `<!DOCTYPE html>\n<html><head>\n${CSP_META}\n<style>html,body{margin:0;padding:0;min-height:100%}</style>\n</head><body>${safeRefs}</body></html>`;
  return { doc, report: { blocked } };
}

/** Human line for the preview footer ("3 external resources blocked"). */
export function blockedSummary(report: PreviewReport): string {
  if (report.blocked.length === 0) return 'No external resources — fully sandboxed.';
  return `${report.blocked.length} external resource${report.blocked.length === 1 ? '' : 's'} blocked by the preview sandbox.`;
}
