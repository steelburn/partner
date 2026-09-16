/**
 * M11 F7/F12 follow-up: a fenced code block, with an INLINE rendered preview
 * when the fence is HTML.
 *
 * A reader asked to compare a code block with what it renders without leaving
 * the message, so a ```html block in any markdown surface (chat transcript,
 * saved-asset read view, note preview) renders a hardened sandboxed iframe of
 * its result. Follow-up: source and render share ONE tabbed viewer
 * (`Code` | `Preview`) instead of stacking, so the block does not double in
 * height and the reader chooses what to look at. The pill is the app's
 * segmented control (`.seg-tabs`, the same one on Notes/Plans/Skills), and
 * both panels stay mounted — flipping tabs never rebuilds the sandboxed
 * iframe. The preview reuses `lib/preview` (scripts OFF with a per-block
 * opt-in, no network, never same-origin) — the same policy as the F12 overlay,
 * which stays for attachments and `kind=code` containers.
 *
 * Every non-HTML block renders exactly as before: a plain `<pre class="md-pre">`.
 */
import { useMemo, useState } from 'react';
import type { Element, RootContent } from 'hast';
import { blockedSummary, buildPreviewDoc } from './lib/preview.js';
import { codeBlockPreview } from './lib/code-assets.js';

export interface CodeBlockProps extends React.ComponentPropsWithoutRef<'pre'> {
  /** The hast `<pre>` element react-markdown hands to custom components. */
  node?: Element;
}

/** Which panel of the tabbed viewer the reader is looking at. */
type CodeTab = 'code' | 'preview';

/** Concatenated text of a hast subtree (code bodies are plain text nodes). */
function textOf(node: RootContent): string {
  if (node.type === 'text') return node.value;
  if (node.type === 'element') return node.children.map(textOf).join('');
  return '';
}

/**
 * Language tag + inner text of the `<code>` child of a `<pre>` hast node.
 * The language comes from the GFM `language-<tag>` class react-markdown adds
 * to a fenced block; `null` for an untagged fence or a plain indented block.
 */
export function codeFenceInfo(node: Element | undefined): { lang: string | null; code: string } {
  const code = node?.children.find(
    (child): child is Element => child.type === 'element' && child.tagName === 'code',
  );
  const raw = code?.properties?.className;
  const classes = Array.isArray(raw)
    ? raw.map(String)
    : raw === undefined || raw === null
      ? []
      : [String(raw)];
  const langClass = classes.find((name) => name.startsWith('language-'));
  const lang = langClass === undefined ? null : langClass.slice('language-'.length).toLowerCase();
  return {
    lang: lang === '' ? null : lang,
    code: code === undefined ? '' : code.children.map(textOf).join(''),
  };
}

export function CodeBlock({ node, children }: CodeBlockProps) {
  const { lang, code } = useMemo(() => codeFenceInfo(node), [node]);
  const preview = useMemo(() => codeBlockPreview(lang, code), [lang, code]);
  const [scripts, setScripts] = useState(false);
  const [tab, setTab] = useState<CodeTab>('code');
  const built = useMemo(
    () => (preview === null ? null : buildPreviewDoc(preview.source, { allowScripts: scripts })),
    [preview, scripts],
  );

  // Non-HTML (or no previewable source): identical to the old renderer.
  if (preview === null || built === null) {
    return <pre className="md-pre">{children}</pre>;
  }

  const label = lang ?? 'html';
  return (
    <div className="md-code-block">
      <div className="md-code-block-head">
        <span className="md-code-lang">{label}</span>
        <div className="seg-tabs md-code-tabs" role="group" aria-label={`${label} block view`}>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-pressed={tab === 'code'}
            onClick={() => setTab('code')}
          >
            Code
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-pressed={tab === 'preview'}
            onClick={() => setTab('preview')}
          >
            Preview
          </button>
        </div>
      </div>
      <div className="md-code-panel md-code-source" hidden={tab !== 'code'}>
        <pre className="md-pre">{children}</pre>
      </div>
      <div className="md-code-panel md-code-preview" hidden={tab !== 'preview'}>
        <iframe
          className="md-code-preview-frame"
          title={`Sandboxed preview of the ${label} block`}
          sandbox={scripts ? 'allow-scripts' : ''}
          srcDoc={built.doc}
        />
        <div className="md-code-preview-foot">
          <p className="md-code-preview-note">{blockedSummary(built.report)}</p>
          <button
            type="button"
            className="btn-link md-code-block-toggle"
            aria-pressed={scripts}
            onClick={() => setScripts((value) => !value)}
          >
            {scripts ? 'Scripts on' : 'Scripts off'}
          </button>
        </div>
      </div>
    </div>
  );
}
