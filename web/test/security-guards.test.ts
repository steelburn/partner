/**
 * Security regression guards (PLAN-M20.md §8.1.2 — "Positives to preserve as
 * tests").
 *
 * The app has hard-won security properties that are currently TRUE but were
 * only documented in prose. Each one becomes an assertion here so a later
 * change cannot remove it silently:
 *
 *   1. the sandboxed code preview can never grant same-origin,
 *   2. markdown renderers are always sanitised and raw HTML is never enabled,
 *   3. web storage carries no user content (and the session-only API key is
 *      never persisted at all),
 *   4. attachment bytes are fetched WITH the bearer header and the content
 *      route is never referenced from `src`/`href`.
 *
 * TWO KINDS OF ASSERTION, chosen deliberately:
 *
 *  - **Behavioural** wherever a seam exists. `lib/storage.ts` injects its
 *    backend, `lib/attachments.ts` and `lib/session-chat.ts` inject their
 *    transport, so those guards exercise real code with a fake and assert on
 *    what it actually did.
 *  - **Source-level** where the property IS source: a JSX attribute
 *    (`sandbox`, `rehypePlugins`), a module-graph fact (an import that must not
 *    exist), or the set of storage keys a whole package declares. This suite
 *    runs in the `node` environment with no DOM harness (see
 *    web/vitest.config.ts), which does NOT mean the components are unrenderable
 *    here: `react-dom/server`'s `renderToStaticMarkup` renders them (see
 *    `markdown.test.ts` and `answer-group-render.test.ts`). So source
 *    assertions are used only where the property is genuinely a property of the
 *    SOURCE — the set of sandbox tokens the attribute may take, a module that
 *    must not be imported, the package-wide set of persisted keys — and every
 *    such case says so. Anything expressible against rendered markup is asserted
 *    against rendered markup instead, with comments stripped first so the source
 *    assertions are about code rather than prose.
 *
 * Each guard notes what change would break it — a test that cannot fail is
 * worse than no test.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultSchema } from 'rehype-sanitize';
import { TOKENS } from '@partner/shared';
import {
  setStorageBackend,
  type StorageLike,
} from '../src/lib/storage.js';
import { storeToken, TOKEN_STORAGE_KEY } from '../src/lib/token.js';
import { MODE_STORAGE_KEY, THEME_CACHE_KEY, cacheThemePair, persistMode } from '../src/theme/apply.js';
import {
  fetchAttachmentContent,
  uploadAttachment,
  type FetchLike,
} from '../src/lib/attachments.js';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function readSource(relative: string): string {
  return readFileSync(join(SRC, relative), 'utf8');
}

/**
 * Remove comments before source assertions.
 *
 * Block comments go entirely. Only FULL-LINE `//` comments are stripped —
 * inline `//` is left alone on purpose, so a `//` inside a string literal
 * (a URL, say) can never be mangled into something that looks like code.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

/** Every single/double-quoted string literal in a source text. */
function stringLiterals(source: string): string[] {
  const out: string[] = [];
  const re = /'([^'\\]*(?:\\.[^'\\]*)*)'|"([^"\\]*(?:\\.[^"\\]*)*)"/g;
  let match = re.exec(source);
  while (match !== null) {
    out.push(match[1] ?? match[2] ?? '');
    match = re.exec(source);
  }
  return out;
}

/** Walk every .ts/.tsx file under web/src, returning [relativePath, text]. */
function readAllSources(): Array<[string, string]> {
  const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .map((entry) => entry.replace(/\\/g, '/'))
    .filter((entry) => /\.tsx?$/.test(entry));
  return files.map((file) => [file, readFileSync(join(SRC, file), 'utf8')]);
}

/**
 * The complete set of keys this package is allowed to persist.
 *
 * If a new key is added DELIBERATELY, extend this list in the same change and
 * say why it holds no content — that conscious step is the point of the
 * guard. The rule for any addition: metadata about the UI only. Chat,
 * memories, notes, prompts, transcripts and attachment bytes are content and
 * must never be persisted (PLAN-M20.md §11: browser storage is the weakest
 * link for a sensitive-data product, including device backups).
 */
const STORAGE_ALLOWLIST = [
  TOKEN_STORAGE_KEY, // 'partner.token'   — the session credential (sanctioned)
  MODE_STORAGE_KEY, // 'partner.mode'     — light/dark preference
  THEME_CACHE_KEY, // 'partner.theme.pair' — resolved colour tokens, for a flash-free boot
  'partner.notesLane', // UI preference: notes lane open/closed
  'partner.railOpen', // UI preference: conversation rail open/closed
  'partner.railWidth', // UI preference: rail drag width
  'partner.notesWidth', // UI preference: notes lane drag width
  'partner.assetsLane', // UI preference: assets pane open/closed
  'partner.assetsWidth', // UI preference: assets pane drag width
  'partner.authMode', // M22: 'pairing' | 'login' — which gate this core uses, so
  //                   'session expired' copy names the right action. One word,
  //                   no identity and no content.
];


/**
 * Every `partner.`-prefixed string literal declared anywhere under web/src.
 *
 * Extracted at module level so the census and its non-vacuity proof read the
 * SAME data — two copies of this scan would drift apart, which is exactly the
 * failure mode the proof exists to catch.
 *
 * SCOPE: prefixed LITERALS only. A non-prefixed key, a computed/concatenated
 * key, or a key reached through a variable would not appear here; see the
 * census test for what that does and does not cover.
 */
function declaredPartnerKeys(): string[] {
  const declared = new Set<string>();
  for (const [, text] of readAllSources()) {
    for (const literal of stringLiterals(stripComments(text))) {
      if (/^partner\./.test(literal)) declared.add(literal);
    }
  }
  return [...declared].sort();
}

/**
 * String literals passed as the FIRST argument to a web-storage call.
 *
 * Closes the blind spot the census alone leaves open: `App.tsx` calls
 * `sessionStorage.setItem(key, value)` DIRECTLY rather than through
 * `lib/storage.ts`, so a key declared there need not start with `partner.` and
 * the prefixed-literal census would never see it.
 *
 * What this still does NOT cover, stated so it is not mistaken for total: a key
 * held in a VARIABLE (which is what the current call sites all pass) or one
 * built by concatenation/interpolation. Those are invisible to any source scan
 * of literals, which is why the behavioural assertions in this suite remain the
 * primary net and this is a secondary one.
 */
function storageKeyLiterals(source: string): string[] {
  const out: string[] = [];
  const re =
    /(?:setItem|getItem|removeItem|readLocal|writeLocal|removeLocal|readSession|writeSession|readIntSession)\s*\(\s*(?:'([^'\\]*)'|"([^"\\]*)")/g;
  let match = re.exec(source);
  while (match !== null) {
    out.push(match[1] ?? match[2] ?? '');
    match = re.exec(source);
  }
  return out;
}

/**
 * Every sandbox token a source text can emit. Gathered from the string literals
 * rather than from a specific line, so reformatting cannot break the guard but
 * ADDING a capability always does. Extracted at module level so the self-tests
 * below can drive it with a deliberately-insecure input.
 */
function sandboxTokens(source: string): string[] {
  return stringLiterals(source)
    .flatMap((literal) => literal.split(/\s+/))
    .filter((token) => /^allow-[a-z-]+$/.test(token));
}

/** Each `<ReactMarkdown …>…</ReactMarkdown>` element, in source order. */
/**
 * One entry per `<ReactMarkdown …>` OPENING TAG, bounded to that tag.
 *
 * Previously this was `code.split('<ReactMarkdown').slice(1)`, which returned
 * everything from each occurrence to EOF — so the LAST usage swallowed the rest
 * of the file and a `rehypeSanitize` appearing anywhere after it would satisfy
 * the guard. Bounding each entry to its own tag (tracking brace depth so an
 * attribute expression may contain `>`) makes the assertion about the element it
 * claims to check.
 */
function reactMarkdownUsages(code: string): string[] {
  const out: string[] = [];
  const marker = '<ReactMarkdown';
  let from = 0;
  for (;;) {
    const start = code.indexOf(marker, from);
    if (start < 0) break;
    let depth = 0;
    let end = -1;
    for (let i = start + marker.length; i < code.length; i += 1) {
      const ch = code[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      else if (ch === '>' && depth === 0) {
        end = i;
        break;
      }
    }
    out.push(code.slice(start, end < 0 ? code.length : end + 1));
    from = start + marker.length;
  }
  return out;
}

describe('sandboxed code preview can never grant same-origin', () => {
  // Source-level by necessity: `sandbox` is a JSX attribute whose value is
  // computed at render time, and the assertion is about the SET of tokens the
  // expression can ever produce — not about one rendered instance. (Rendered
  // markup IS available in this repo via `renderToStaticMarkup`; see
  // `markdown.test.ts` and `answer-group-render.test.ts` for the guards that use
  // it instead.)
  const code = stripComments(readSource('CodePreview.tsx'));

  it('grants `allow-scripts` at most — never any other sandbox token', () => {
    const tokens = sandboxTokens(code);
    // Would fail on: 'allow-scripts allow-same-origin' (the classic XSS
    // escape), 'allow-forms', 'allow-popups', 'allow-top-navigation',
    // 'allow-modals', 'allow-pointer-lock'.
    expect(tokens.filter((token) => token !== 'allow-scripts')).toEqual([]);
  });

  it('never mentions allow-same-origin at all, in code or as an identifier', () => {
    // Belt and braces: catches the token appearing via indirection (a constant,
    // a template fragment) rather than as a plain literal in the array above.
    expect(code).not.toContain('allow-same-origin');
  });

  it('leaves scripts OFF by default and keeps the sandbox bound to the toggle', () => {
    // `useState(false)` is the opt-in default; the sandbox prop must be an
    // expression (bound), not a hardcoded literal, so the toggle governs it.
    expect(code).toMatch(/useState\(\s*false\s*\)/);
    expect(code).toMatch(/sandbox=\{/);
  });

  it('routes the untrusted document through buildPreviewDoc so the CSP is injected', () => {
    // CodePreview must not hand the raw document straight to srcDoc: the
    // network-blocking CSP and the blocked-resource report come from
    // lib/preview (covered by test/preview.test.ts).
    expect(code).toContain('buildPreviewDoc(');
    expect(code).not.toMatch(/srcDoc=\{source\}/);
  });
});

describe('markdown is always sanitised and raw HTML is never enabled', () => {
  const raw = readSource('Markdown.tsx');
  const code = stripComments(raw);

  it('passes rehype-sanitize to EVERY ReactMarkdown usage', () => {
    // Each opening tag is inspected on its own: a new markdown renderer added
    // without the sanitiser fails this guard.
    const usages = reactMarkdownUsages(code);
    // Guards against the guard passing vacuously if the renderer is swapped.
    expect(usages.length).toBeGreaterThan(0);
    expect(code).toContain("from 'react-markdown'");
    for (const usage of usages) {
      expect(usage).toContain('rehypeSanitize');
    }
  });

  it('never enables raw HTML passthrough', () => {
    // Would fail on: importing rehype-raw, passing allowDangerousHtml, or
    // re-enabling rehypeRaw — any of which lets untrusted markup become DOM.
    expect(code).not.toMatch(/rehype-raw|rehypeRaw|allowDangerousHtml/);
  });

  it('only ever EXTENDS the default sanitize schema, never loosens it', () => {
    const start = code.indexOf('const SANITIZE_SCHEMA');
    expect(start).toBeGreaterThan(-1);
    const block = code.slice(start, code.indexOf('};', start));
    // The default schema is the basis.
    expect(block).toContain('...defaultSchema');
    // These keys OVERRIDE inherited behaviour rather than adding to it:
    // `tagNames`/`attributes` decide what survives sanitisation, while
    // `strip` (element removal) and `clobber*` (id-collision handling) replace
    // defaults too. Their absence is the invariant because any of them here
    // means the schema is no longer merely an extension of the default — not
    // because each one individually lets markup through.
    expect(block).not.toMatch(/\b(tagNames|attributes|clobber|clobberPrefix|strip)\b/);
  });

  it('inherits a default schema that refuses scripts and javascript: URLs', () => {
    // Library-level baseline for the schema above: if the inherited default
    // ever permitted these, extending it would still be unsafe.
    const tagNames = (defaultSchema.tagNames ?? []) as string[];
    expect(tagNames).not.toContain('script');
    expect(tagNames).not.toContain('style');
    expect(tagNames).not.toContain('iframe');
    expect((defaultSchema.protocols?.href ?? []) as string[]).not.toContain('javascript');

    const attributes = (defaultSchema.attributes ?? {}) as Record<
      string,
      Array<string | [string, ...unknown[]]>
    >;
    const names: string[] = [];
    for (const [tag, entries] of Object.entries(attributes)) {
      names.push(tag);
      for (const entry of entries ?? []) {
        names.push(Array.isArray(entry) ? String(entry[0]) : String(entry));
      }
    }
    // No event handlers: `onerror`/`onload` are how sanitised-looking markup
    // still executes.
    expect(names.filter((name) => name.toLowerCase().startsWith('on'))).toEqual([]);
  });
});

describe('web storage carries no user content', () => {

  /**
   * Content-shaped key names.
   *
   * Matched word-by-word after splitting camelCase and punctuation, because
   * `partner.chatDrafts` must be flagged and a naive `\bchat\b` does NOT match
   * it (the next character is a word character). Word-level matching also keeps
   * the sanctioned UI keys clean: `partner.notesLane` splits to
   * [partner, notes, lane], and `note` is deliberately NOT in this list.
   *
   * KNOWN BLIND SPOT, stated rather than hidden: dropping `note`/`asset` means a
   * key named exactly `partner.notes` would pass this detector. That is
   * acceptable because the detector is the SECOND net — the primary guard is the
   * allowlist equality below, which fails on ANY new key whatever it is called,
   * so such a key still cannot be added silently.
   */
  const FORBIDDEN_WORDS = new Set([
    'chat',
    'message',
    'transcript',
    'conversation',
    'memory',
    'episode',
    'profile',
    'attachment',
    'prompt',
    'secret',
    'blob',
    'content',
    'draft',
    'answer',
    'markdown',
    'history',
    'file',
    'body',
    'text',
  ]);

  /** Split a key into lowercase words across camelCase and punctuation. */
  function keyWords(key: string): string[] {
    return key
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[^A-Za-z0-9]+/g, ' ')
      .toLowerCase()
      .split(' ')
      .filter((word) => word !== '');
  }

  /**
   * True when a key name looks like it could hold user content. Deliberately
   * conservative: it must never fire on a reviewed metadata key, because a guard
   * that cries wolf gets deleted.
   */
  function looksLikeContentKey(key: string): boolean {
    const compact = key.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
    if (compact.includes('apikey')) return true;
    return keyWords(key).some((word) => FORBIDDEN_WORDS.has(word.replace(/s$/, '')));
  }

  function fakeStorage(): StorageLike & { keys: () => string[] } {
    const map = new Map<string, string>();
    return {
      getItem: (key) => map.get(key) ?? null,
      setItem: (key, value) => {
        map.set(key, value);
      },
      removeItem: (key) => {
        map.delete(key);
      },
      keys: () => [...map.keys()],
    };
  }

  beforeEach(() => {
    setStorageBackend(null);
  });

  afterEach(() => {
    setStorageBackend(null);
  });

  it('the public persistence APIs write only sanctioned keys', () => {
    // Behavioural, through the injected backend: whatever the app persists on a
    // normal boot/theme change is observed rather than assumed.
    const backend = fakeStorage();
    setStorageBackend(backend);

    expect(storeToken('a-session-token-value')).toBe(true);
    persistMode('dark');
    cacheThemePair(TOKENS.light, TOKENS.dark, 'dark');

    expect(backend.keys().sort()).toEqual([MODE_STORAGE_KEY, THEME_CACHE_KEY, TOKEN_STORAGE_KEY].sort());
    // The credential is stored verbatim under its own key and nowhere else.
    expect(backend.getItem(TOKEN_STORAGE_KEY)).toBe('a-session-token-value');
  });

  it('declares no persisted key outside the allowlist', () => {
    // Source census: every `partner.*` string literal in the package, so a new
    // key added anywhere (not just in the modules asserted above) is caught.
    //
    // SCOPE, stated precisely so this is not trusted beyond what it does: the
    // census matches prefixed LITERALS. A key that is not `partner.`-prefixed, a
    // key built by concatenation/interpolation, or a direct
    // `sessionStorage.setItem(...)` call with a non-prefixed literal would slip
    // past it. `web/src/App.tsx` already calls `sessionStorage` directly rather
    // than through `lib/storage.ts`, so that last route is live in this codebase.
    // The behavioural assertions above are the primary net; this census is a
    // secondary one for the package-wide question "did someone declare a new
    // persisted key?".
    const declared = declaredPartnerKeys();
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.filter((key) => !STORAGE_ALLOWLIST.includes(key))).toEqual([]);
    // …and the sanctioned keys are all still declared (a silent removal of the
    // token or theme key would be its own bug).
    expect(declared).toEqual([...STORAGE_ALLOWLIST].sort());
    // Belt and braces on the list itself: even if a content-shaped key were
    // added to the allowlist by mistake, the detector still fails the suite.
    expect(STORAGE_ALLOWLIST.filter(looksLikeContentKey)).toEqual([]);

    // The direct-call route the prefixed census cannot see: any INLINE key
    // literal handed to a storage call must also be sanctioned. A key passed as
    // a variable stays invisible here — see the helper's note.
    const inlineKeys = [...readAllSources()].flatMap(([, text]) =>
      storageKeyLiterals(stripComments(text)),
    );
    expect(inlineKeys.filter((key) => !STORAGE_ALLOWLIST.includes(key))).toEqual([]);
  });

  it('the content-key detector can actually fail (guard is not vacuous)', () => {
    // Proves the rule above bites: these are the shapes a content key would
    // take — including camelCase compositions, which is precisely the form a
    // trailing-`\b` regex misses.
    for (const key of [
      'partner.chatDrafts',
      'partner.notes.content',
      'partner.memory',
      'partner.transcript',
      'partner.apiKey',
      'partner.attachmentCache',
      'partner.answers',
      'partner.messageBody',
      'partner.episodes',
    ]) {
      expect(looksLikeContentKey(key), `${key} should look like content`).toBe(true);
    }
    // …and it must NOT fire on any key the app legitimately persists: a detector
    // that flags the sanctioned keys would be ignored rather than fixed.
    for (const key of STORAGE_ALLOWLIST) {
      expect(looksLikeContentKey(key), `${key} must not be flagged`).toBe(false);
    }
  });

  it('the session-only API key module persists nothing at all', () => {
    // Degraded mode takes a key the user pasted into a borrowed browser. The
    // module documents that it "never persists it" — this makes that structural:
    // it imports no storage helper, so persistence cannot be added by accident.
    const code = stripComments(readSource('lib/session-chat.ts'));
    expect(code).not.toMatch(/localStorage|sessionStorage/);
    expect(code).not.toMatch(/from\s+'\.\/storage\.js'|from\s+'\.\.\/lib\/storage\.js'/);
    expect(code).not.toMatch(/\bindexedDB\b|\bdocument\.cookie\b/);
  });
});

describe('the guards themselves can fail (non-vacuity proofs)', () => {
  // A test that cannot fail is worse than no test. These drive the SAME
  // extraction helpers the real guards use with a deliberately-insecure input,
  // so the guards are shown to detect the regressions they exist for. No
  // production file is involved.

  it('the sandbox token extractor detects a same-origin escape', () => {
    expect(sandboxTokens('const sandbox = scripts ? \'allow-scripts allow-same-origin\' : \'\';')).toContain(
      'allow-same-origin',
    );
    expect(sandboxTokens('const sandbox = \'\';')).toEqual([]);
    // Comment-only mentions must never trip it (comments are stripped first).
    expect(sandboxTokens(stripComments('/* never allow-same-origin */ const x = 1;'))).toEqual([]);
  });

  it('the storage-argument extractor detects an inline key (and is honest about variables)', () => {
    // Non-vacuity: the new assertion above is only meaningful if the extractor
    // actually finds literals. Both the finding AND the miss are pinned.
    expect(storageKeyLiterals("sessionStorage.setItem('partner.sneaky', 'x')")).toEqual([
      'partner.sneaky',
    ]);
    expect(storageKeyLiterals('localStorage.setItem("not-prefixed", "x")')).toEqual(['not-prefixed']);
    // A key held in a variable is invisible to a literal scan — documented
    // rather than pretended away.
    expect(storageKeyLiterals('sessionStorage.setItem(key, value)')).toEqual([]);
    expect(storageKeyLiterals('void 0')).toEqual([]);
  });

  it('the comment stripper keeps code and drops prose', () => {
    const stripped = stripComments(
      ['/* block: allow-same-origin */', 'const a = 1;', '  // line: allow-same-origin', "const b = 'keep me';", 'const u = "https://x/y";'].join('\n'),
    );
    expect(stripped).not.toContain('allow-same-origin');
    expect(stripped).toContain('const a = 1;');
    expect(stripped).toContain('keep me');
    // An inline `//` inside a URL must survive intact.
    expect(stripped).toContain('https://x/y');
  });

  it('the markdown usage splitter detects an unsanitised renderer', () => {
    const bad = [
      '<ReactMarkdown rehypePlugins={[[rehypeSanitize, S]]}>a</ReactMarkdown>',
      '<ReactMarkdown components={C}>b</ReactMarkdown>',
    ].join('\n');
    const usages = reactMarkdownUsages(bad);
    expect(usages).toHaveLength(2);
    expect(usages.filter((usage) => !usage.includes('rehypeSanitize'))).toHaveLength(1);
  });

  it('the storage census detects an added content key', () => {
    // Drives the SAME helper the census uses, against the SAME allowlist — so
    // the proof cannot drift from the guard it is proving (a second hardcoded
    // copy of the key list was the previous defect here).
    const declared = declaredPartnerKeys();
    expect(declared.length).toBeGreaterThan(0);
    expect([...declared, 'partner.chatDrafts'].filter((key) => !STORAGE_ALLOWLIST.includes(key))).toEqual([
      'partner.chatDrafts',
    ]);
    // And the real set is clean: no declared key is outside the allowlist.
    expect(declared.filter((key) => !STORAGE_ALLOWLIST.includes(key))).toEqual([]);
  });
});

describe('attachment bytes are fetched with the bearer header', () => {
  /** One recorded transport call, so the guard asserts what was actually sent. */
  interface Call {
    url: string;
    init: RequestInit | undefined;
  }

  function recordingFetch(calls: Call[], body = new Uint8Array([1, 2, 3])): FetchLike {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return new Response(body, { status: 200, headers: { 'content-type': 'image/png' } });
    }) as unknown as FetchLike;
  }

  it('sends the token as an Authorization header and never in the URL', () => {
    // Behavioural, through the fetchImpl seam. This is what makes the core's
    // `Content-Disposition` policy irrelevant to the SPA (PLAN-M20.md §8.1.1):
    // the bytes arrive via fetch, not via a navigated URL.
    const calls: Call[] = [];
    const token = 'session-token-value';
    return fetchAttachmentContent(token, 'conv 1/2', 'att-9', {
      fetchImpl: recordingFetch(calls),
    }).then((result) => {
      expect(calls).toHaveLength(1);
      const call = calls[0] as Call;
      expect(call.url).toContain('/v1/conversations/conv%201%2F2/attachments/att-9/content');
      // The credential must never ride in a URL (it would land in history,
      // referrers and logs).
      expect(call.url).not.toContain(token);
      expect(call.url).not.toContain('?');
      const headers = call.init?.headers as Record<string, string>;
      expect(headers.authorization).toBe(`Bearer ${token}`);
      expect(result.mime).toBe('image/png');
      expect(result.bytes).toHaveLength(3);
    });
  });

  it('uploads with the same bearer discipline, and the filename rides a header — never the URL', () => {
    const calls: Call[] = [];
    const token = 'another-session-token';
    const file = new Blob(['AAAA']);
    return uploadAttachment(
      token,
      'c1',
      { name: 'foto ção.png', mime: 'image/png', data: file },
      { fetchImpl: recordingFetch(calls, new Uint8Array([])) },
    )
      .catch(() => undefined)
      .then(() => {
        expect(calls).toHaveLength(1);
        const call = calls[0] as Call;
        const headers = call.init?.headers as Record<string, string>;
        expect(headers.authorization).toBe(`Bearer ${token}`);
        expect(call.url).not.toContain(token);
        // A filename is user data: it lands in history, referrers and access
        // logs if it rides the URL, so it rides a percent-encoded header.
        expect(call.url).not.toContain('?');
        expect(call.url).not.toContain('foto');
        expect(headers['x-attachment-name']).toBe(encodeURIComponent('foto ção.png'));
        // R7: the payload IS the body — its own content type, no base64
        // envelope that inflates the bytes and inherits the JSON body cap.
        expect(headers['content-type']).toBe('image/png');
        expect(call.init?.body).toBe(file);
      });
  });

  it('constructs the content route in exactly one module, and never in a component', () => {
    // Source census. One module builds the URL and it is the module that
    // attaches the header, so no component can fetch the bytes unauthenticated
    // (or bypass the fetch path by dropping the URL into `src`/`href`, where a
    // bearer header cannot be set at all).
    const hits: string[] = [];
    for (const [file, text] of readAllSources()) {
      if (stripComments(text).includes('/content')) hits.push(file);
    }
    expect(hits).toEqual(['lib/attachments.ts']);
  });
});
