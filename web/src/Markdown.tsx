/**
 * M11 F7/F9 markdown -> HTML rendering (PLAN-M11.md).
 *
 * `PartnerMarkdown` renders assistant/note markdown as styled, sanitized
 * HTML (react-markdown + remark-gfm + rehype-sanitize; raw HTML never
 * renders). `:::partner.*` containers (C3) are sliced out before markdown
 * parsing and rendered by typed components — choices (F9) become clickable
 * single/multi option cards; asset containers are passed through as a
 * callout so F10 can hook extraction.
 *
 * All styling is token-driven via class names (see app.css); the component
 * itself carries no colors or sizes. Links open in a new tab; partner-file
 * links (F1) are intercepted by the consumer via onFileLink.
 */
import { memo, useMemo } from 'react';
import ReactMarkdown, { defaultUrlTransform, type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import { parseStructuredBlocks } from '@partner/shared';
import type { ChoiceMode } from '@partner/shared';
import { ChoiceCard } from './ChoiceCard.js';

export interface PartnerMarkdownProps {
  text: string;
  /** F9: the user answered a choice — text is the answer message to send. */
  onAnswer?: (message: string) => void;
  /** Chat is mid-stream: interactions stay inert until the turn ends. */
  busy?: boolean;
  /** Intercept a partner-file link (F1); absent links render as plain text. */
  onFileLink?: (href: string) => void;
}

const COMPONENTS: Components = {
  a: (props) => {
    const href = props.href ?? '';
    if (href.startsWith('partner-file://')) {
      return <span className="md-file-chip">{props.children}</span>;
    }
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {props.children}
      </a>
    );
  },
  pre: (props) => <pre className="md-pre">{props.children}</pre>,
  code: (props) => <code className="md-code">{props.children}</code>,
  table: (props) => (
    <div className="md-table-wrap">
      <table className="md-table">{props.children}</table>
    </div>
  ),
  img: (props) => <img className="md-image" alt={props.alt ?? ''} src={props.src} />,
};

/**
 * Allow the F1 partner-file: scheme through react-markdown's URL filter;
 * every other URL goes through the library default (http(s)/mailto only).
 */
function urlTransform(url: string): string {
  if (url.startsWith('partner-file:')) return url;
  return defaultUrlTransform(url);
}

/** Sanitizer schema: the default, plus the partner-file: href protocol. */
const SANITIZE_SCHEMA = {
  ...defaultSchema,
  protocols: {
    ...(defaultSchema.protocols ?? {}),
    href: [...(defaultSchema.protocols?.href ?? []), 'partner-file'],
  },
};

/**
 * Render one markdown fragment that contains NO partner containers. `code`
 * is stable so memoization is effective while a stream is appending.
 */
const MarkdownFragment = memo(function MarkdownFragment({ text }: { text: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      rehypePlugins={[[rehypeSanitize, SANITIZE_SCHEMA]]}
      urlTransform={urlTransform}
      components={COMPONENTS}
    >
      {text}
    </ReactMarkdown>
  );
});

/** True when the fragment is only whitespace. */
function isBlank(text: string): boolean {
  return text.trim() === '';
}

/**
 * M11 F2: tool directives are execution metadata, not prose — hide their
 * lines from the rendered bubble (the persisted text keeps them).
 */
export function filterToolDirectives(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('[[partner:tool'))
    .join('\n');
}

export const PartnerMarkdown = memo(function PartnerMarkdown({
  text,
  onAnswer,
  busy,
}: PartnerMarkdownProps) {
  const visibleText = useMemo(() => filterToolDirectives(text), [text]);
  const hits = useMemo(() => parseStructuredBlocks(visibleText), [visibleText]);
  if (hits.length === 0) {
    return <MarkdownFragment text={visibleText} />;
  }
  const segments: React.ReactNode[] = [];
  let cursor = 0;
  hits.forEach((hit, index) => {
    const before = visibleText.slice(cursor, hit.start);
    if (!isBlank(before)) {
      segments.push(<MarkdownFragment key={`md-${index}`} text={before} />);
    }
    const block = hit.block;
    if (block.kind === 'choice') {
      const mode: ChoiceMode = block.mode === 'multi' ? 'multi' : 'single';
      segments.push(
        <ChoiceCard
          key={`choice-${index}`}
          mode={mode}
          title={block.title}
          options={block.options}
          busy={busy === true}
          onConfirm={(labels) => {
            const message = mode === 'multi' ? labels.join('; ') : (labels[0] ?? '');
            onAnswer?.(message);
          }}
        />,
      );
    } else {
      segments.push(
        <aside key={`asset-${index}`} className="md-asset-callout">
          <span className="md-asset-kind">{block.assetKind}</span>
          <span className="md-asset-title">{block.title ?? 'Saved artifact'}</span>
        </aside>,
      );
    }
    cursor = hit.end;
  });
  const after = visibleText.slice(cursor);
  if (!isBlank(after)) {
    segments.push(<MarkdownFragment key="md-after" text={after} />);
  }
  return <div className="md-blocks">{segments}</div>;
});
