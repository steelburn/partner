/**
 * M26 Skill Studio view tests (PLAN-M26.md cut D).
 *
 * The web suite runs in the `node` environment with no DOM (web/vitest.config.ts),
 * so components are rendered with `react-dom/server`'s `renderToStaticMarkup` —
 * the same approach `login-gate.test.ts` and `answer-group-render.test.ts` use.
 *
 * What that can and cannot assert, stated plainly:
 *
 *  - **Rendered markup** is the evidence for every state that is a PROPERTY OF
 *    A RENDER: the three segments, a badge that appears only when something is
 *    waiting, the empty/loading/error surfaces, what the install confirmation
 *    puts in front of the owner, and the two-step gate (the first step has no
 *    acknowledgement in it at all).
 *  - **A source assertion** is used where the property genuinely is a property
 *    of the SOURCE and the render cannot see it: the deep-link intent is applied
 *    by an effect, and `renderToStaticMarkup` does not run effects. The RULE that
 *    effect applies (the intent beats the local selection) is asserted against
 *    the pure `resolveSelectedDraft`; the wiring is asserted against the source
 *    with comments stripped. Each such case says so.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SkillDraft, SkillDraftSummary, SkillManifest } from '@partner/shared';
import {
  DraftEditor,
  DraftEmptyState,
  DraftRail,
  InstallConfirm,
  InstallPanel,
  RunPanel,
  ValidationPanel,
} from '../src/SkillStudio.js';
import { SkillsSegments } from '../src/SkillsView.js';
import { permissionDiffRows, resolveSelectedDraft } from '../src/lib/skill-studio-helpers.js';
import { source } from './helpers/css.js';

const MANIFEST: SkillManifest = {
  id: 'scratch-checklist',
  name: 'Scratch checklist',
  description: 'Turns scratch notes into a checklist',
  author: 'You',
  version: '0.1.0',
  entrypoint: 'entry.mjs',
  permissions: { tools: [], network: false, risk: 'low' },
  budget: { timeMs: 30_000 },
};

const SUMMARY: SkillDraftSummary = {
  id: 'scratch-checklist',
  name: 'Scratch checklist',
  description: 'Turns scratch notes into a checklist',
  status: 'draft',
  origin: 'generated',
  manifest: MANIFEST,
  validation: { ok: true, errors: [], warnings: ['cannot reach the network'], checkedAt: 1000 },
  model: 'demo',
  conversationId: null,
  personaId: null,
  pendingInstallId: null,
  createdAt: 900,
  updatedAt: 1000,
};

const DRAFT: SkillDraft = {
  ...SUMMARY,
  code: 'export function run(args = {}) { return args; }',
  prompt: 'turn my scratch notes into a checklist',
  manifestText: JSON.stringify(MANIFEST, null, 2),
  installedVersion: null,
  flow: null,
  flowSha256: null,
  flowCompiledAt: null,
  flowStale: false,
};

const noop = (): void => undefined;

function count(html: string, needle: string): number {
  return html.split(needle).length - 1;
}

describe('segment plumbing (Installed | Catalog | Build)', () => {
  it('renders the three segments with the active one pressed', () => {
    const html = renderToStaticMarkup(
      h(SkillsSegments, { segment: 'studio', readyDrafts: 0, disabled: false, onSelect: noop }),
    );
    expect(html).toContain('>Installed<');
    expect(html).toContain('>Catalog<');
    expect(html).toContain('>Build<');
    expect(count(html, 'aria-pressed="true"')).toBe(1);
    expect(count(html, 'aria-pressed="false"')).toBe(2);
    expect(count(html, 'class="btn btn-secondary seg-tab"')).toBe(3);
  });

  it('badges Build only when drafts are actually waiting', () => {
    const badged = renderToStaticMarkup(
      h(SkillsSegments, { segment: 'installed', readyDrafts: 2, disabled: false, onSelect: noop }),
    );
    expect(badged).toContain('tab-badge');
    expect(badged).toContain('>2<');
    expect(badged).toContain('aria-label="Build — 2 drafts ready"');

    const quiet = renderToStaticMarkup(
      h(SkillsSegments, { segment: 'installed', readyDrafts: 0, disabled: false, onSelect: noop }),
    );
    // A "0" would read as something waiting; the badge is simply absent.
    expect(quiet).not.toContain('tab-badge');
    expect(quiet).toContain('aria-label="Build"');
  });

  it('disables every segment while the session is locked', () => {
    const html = renderToStaticMarkup(
      h(SkillsSegments, { segment: 'installed', readyDrafts: 1, disabled: true, onSelect: noop }),
    );
    expect(count(html, 'disabled=""')).toBe(3);
  });
});

describe('draft rail states', () => {
  const base = {
    selectedId: null,
    onSelect: noop,
    disabled: false,
    loading: false,
    loadError: null,
    onRetry: noop,
  };

  it('shows a busy loading line, not an empty list', () => {
    const html = renderToStaticMarkup(h(DraftRail, { ...base, drafts: null, loading: true }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Loading drafts…');
    expect(html).not.toContain('No drafts yet');
  });

  it('shows the error with a retry action instead of hiding it', () => {
    const html = renderToStaticMarkup(
      h(DraftRail, { ...base, drafts: null, loadError: 'Could not load your drafts.' }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain('Could not load your drafts.');
    expect(html).toContain('Try again');
  });

  it('invites a first draft when the list is empty', () => {
    const html = renderToStaticMarkup(h(DraftRail, { ...base, drafts: [] }));
    expect(html).toContain('No drafts yet');
  });

  it('says so when no model wrote the draft (D11 honesty)', () => {
    // The canned generator answers when nothing is configured, so "generated"
    // must not imply a model produced it. A draft with a real model gets no
    // such marker.
    const demo = renderToStaticMarkup(h(DraftRail, { ...base, drafts: [SUMMARY] }));
    expect(SUMMARY.model).toBe('demo');
    expect(demo).toContain('canned example - no model configured');

    const real = renderToStaticMarkup(
      h(DraftRail, { ...base, drafts: [{ ...SUMMARY, model: 'gpt-oss-120b' }] }),
    );
    expect(real).not.toContain('canned example');
  });

  it('names name, origin, validation state and the approval marker per row', () => {
    const rows: SkillDraftSummary[] = [
      SUMMARY,
      {
        ...SUMMARY,
        id: 'chat-draft',
        name: 'Chat draft',
        origin: 'chat',
        validation: { ok: false, errors: ['unknown tool "files.read"'], warnings: [], checkedAt: 1 },
        pendingInstallId: 'pending-1',
      },
    ];
    const html = renderToStaticMarkup(h(DraftRail, { ...base, drafts: rows, selectedId: 'chat-draft' }));
    expect(html).toContain('Scratch checklist');
    expect(html).toContain('Generated');
    expect(html).toContain('From chat');
    expect(html).toContain('ok');
    expect(html).toContain('1 problem');
    expect(html).toContain('Awaiting your approval');
    // The marker is about ONE draft, not the list.
    expect(count(html, 'Awaiting your approval')).toBe(1);
    expect(count(html, 'aria-current="true"')).toBe(1);
  });
});

describe('deep-link focus intent', () => {
  it('lands on the named draft, even before the list has loaded', () => {
    const drafts = [{ id: 'a' }, { id: 'b' }];
    expect(resolveSelectedDraft(drafts, 'b', 'a')).toBe('b');
    expect(resolveSelectedDraft([], 'b', null)).toBe('b');
  });

  it('hands the local selection back once the shell clears the intent', () => {
    const drafts = [{ id: 'a' }, { id: 'b' }];
    expect(resolveSelectedDraft(drafts, null, 'b')).toBe('b');
  });

  /**
   * SOURCE-LEVEL on purpose: applying the intent is an effect, and effects do
   * not run under `renderToStaticMarkup`. What is asserted here is the WIRING —
   * that the intent opens the Build segment, is consumed exactly once, and that
   * the shell passes it in the same shape as the existing Notes deep link.
   */
  it('opens the Build segment from the intent and reports it consumed', () => {
    const view = source('src/SkillsView.tsx');
    expect(view).toContain('setSegment(\'studio\')');
    expect(view).toContain('onStudioFocusConsumed?.()');
    expect(view).toContain('focusDraftId={studioFocus?.draftId ?? null}');

    const app = source('src/App.tsx');
    expect(app).toContain('studioFocus={studioFocus}');
    expect(app).toContain('onStudioFocusConsumed={() => setStudioFocus(null)}');
    // The intent travels with the view switch, like the M16 note focus does.
    expect(app).toContain('setStudioFocus');
    expect(app).toContain("setView('skills')");
  });

  /**
   * The deep link has two producers, and both are asserted because the draft it
   * opens is the ONLY way to reach an update: the core refuses a PUT on an
   * already-installed draft, so a permission change always starts from an `edit`
   * draft (or a `fork`), never from an installed row.
   */
  it('starts an edit/fork draft from an installed skill and opens it', () => {
    const view = source('src/SkillsView.tsx');
    expect(view).toContain('await forkSkill(token, skillId)');
    expect(view).toContain('await editSkill(token, skillId)');
    expect(view).toContain('onOpenStudioDraft?.(draft.id)');
    expect(source('src/App.tsx')).toContain('onOpenStudioDraft={openSkillDraftInStudio}');
  });

  /**
   * The consent table's "before" side is keyed by the MANIFEST id, not the
   * draft id: an edit draft lives at `<skill>-edit` while its manifest keeps the
   * installed skill's id (that binding is what makes promote an update). Probing
   * the draft id finds nothing, which would silently hide the before/after table.
   * Source-level because the probe is an async effect.
   */
  it('probes the installed skill by the manifest id when it loads a draft', () => {
    const studio = source('src/SkillStudio.tsx');
    expect(studio).toContain('target = full.manifest?.id ?? full.id');
    expect(studio).toContain('getSkill(token, target)');
  });
});

describe('empty state (describe / template / blank)', () => {
  const base = {
    templatesError: null,
    disabled: false,
    onCreated: noop,
    onSessionLost: noop,
  };
  const TEMPLATES = [
    { id: 'pure', label: 'Pure skill', description: 'Transforms args', reach: 'Nothing else.' },
    {
      id: 'reads-files',
      label: 'Reads files under a root',
      description: 'Lists files',
      reach: 'Files under a root you grant.',
    },
  ];

  it('offers the numbered guide and the three named actions', () => {
    const html = renderToStaticMarkup(
      h(DraftEmptyState, { ...base, templates: TEMPLATES, providerConfigured: true }),
    );
    expect(html).toContain('No drafts yet');
    expect(html).toContain('Generate draft');
    expect(html).toContain('Start blank');
    expect(html).toContain('Create from template');
    expect(count(html, '<li>')).toBeGreaterThanOrEqual(4);
  });

  it('disables generation and says why when no provider is configured', () => {
    const html = renderToStaticMarkup(
      h(DraftEmptyState, { ...base, templates: TEMPLATES, providerConfigured: false }),
    );
    expect(html).toContain('Connect a provider to generate, or start from a template');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Generate draft<\/button>/);
  });

  it('does not claim there is no provider while the check is still in flight', () => {
    const html = renderToStaticMarkup(
      h(DraftEmptyState, { ...base, templates: null, providerConfigured: null }),
    );
    expect(html).toContain('Checking whether a model provider is configured…');
    expect(html).not.toContain('Connect a provider to generate');
    expect(html).toContain('Loading templates…');
  });

  it('lists only the templates the core reported, with their reach', () => {
    const html = renderToStaticMarkup(
      h(DraftEmptyState, { ...base, templates: TEMPLATES, providerConfigured: true }),
    );
    expect(html).toContain('Pure skill');
    expect(html).toContain('Reads files under a root');
    expect(html).toContain('Files under a root you grant.');
    expect(html).not.toContain('notes shaped');
  });

  it('says so plainly when this build ships no templates', () => {
    const html = renderToStaticMarkup(
      h(DraftEmptyState, { ...base, templates: [], providerConfigured: false }),
    );
    expect(html).toContain('This build offers no templates.');
  });
});

describe('validation panel', () => {
  it('reports ok without pretending a dry run has happened', () => {
    const html = renderToStaticMarkup(
      h(ValidationPanel, {
        validation: { ok: true, errors: [], warnings: ['cannot reach the network'], checkedAt: 1 },
        busy: false,
        disabled: false,
        onRevalidate: noop,
      }),
    );
    expect(html).toContain('ok');
    expect(html).toContain('A test run is still the only proof it works');
    expect(html).toContain('cannot reach the network');
  });

  it('lists every problem the core named', () => {
    const html = renderToStaticMarkup(
      h(ValidationPanel, {
        validation: {
          ok: false,
          errors: ['unknown tool "files.read"', 'network is not supported'],
          warnings: [],
          checkedAt: 1,
        },
        busy: false,
        disabled: false,
        onRevalidate: noop,
      }),
    );
    expect(html).toContain('2 problems');
    expect(html).toContain('unknown tool &quot;files.read&quot;');
    expect(html).toContain('network is not supported');
    expect(html).not.toContain('What this skill can reach');
  });
});

describe('test run panel', () => {
  it('refuses to run a draft the validator rejects, and says why', () => {
    const html = renderToStaticMarkup(
      h(RunPanel, {
        draft: {
          ...DRAFT,
          validation: { ok: false, errors: ['entry exports no run'], warnings: [], checkedAt: 1 },
          manifest: null,
        },
        disabled: false,
        onSessionLost: noop,
      }),
    );
    expect(html).toContain('fix the validation problems first');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>Run draft<\/button>/);
    expect(html).toContain('nothing is installed');
  });
});

describe('two-step install arming', () => {
  it('shows the summary and the arm button — and no acknowledgement path', () => {
    const html = renderToStaticMarkup(
      h(InstallPanel, {
        draft: DRAFT,
        diffRows: [],
        installedVersion: null,
        disabled: false,
        onInstalled: noop,
        onSessionLost: noop,
      }),
    );
    // What the owner is consenting to, before any confirmation.
    expect(html).toContain('Scratch checklist');
    expect(html).toContain('No tools');
    expect(html).toContain('Low risk');
    expect(html).toContain('None');
    expect(html).toContain('30000 ms');
    // Step 1 only: the confirm button does not exist yet.
    expect(html).toContain('Install skill…');
    expect(html).not.toContain('Install now');
    expect(html).not.toContain('acknowledg');
  });

  it('refuses to offer an install for a draft that does not validate', () => {
    const html = renderToStaticMarkup(
      h(InstallPanel, {
        draft: { ...DRAFT, validation: { ok: false, errors: ['bad'], warnings: [], checkedAt: 1 } },
        diffRows: [],
        installedVersion: null,
        disabled: false,
        onInstalled: noop,
        onSessionLost: noop,
      }),
    );
    expect(html).toContain('the core refuses to install a draft it cannot validate');
    expect(html).not.toContain('Install skill…');
    expect(html).not.toContain('Install now');
  });

  it('puts the before/after table in the confirmation before the acknowledgement', () => {
    const rows = permissionDiffRows(
      MANIFEST,
      { ...MANIFEST, permissions: { tools: ['files.read'], network: false, risk: 'medium' } },
    );
    expect(rows.length).toBeGreaterThan(0);
    const html = renderToStaticMarkup(
      h(InstallConfirm, {
        draft: DRAFT,
        diffRows: rows,
        isUpdate: true,
        busy: false,
        disabled: false,
        onConfirm: noop,
        onCancel: noop,
      }),
    );
    expect(html).toContain('What this update adds');
    expect(html).toContain('<th scope="col">Before</th>');
    expect(html).toContain('<th scope="col">After</th>');
    expect(html).toContain('Tools');
    expect(html).toContain('Risk');
    expect(html).toContain('Update now');
    expect(html).toContain('Cancel');
    expect(html).toContain('what you are approving');
  });

  it('says an update does not widen anything instead of showing an empty table', () => {
    const html = renderToStaticMarkup(
      h(InstallConfirm, {
        draft: DRAFT,
        diffRows: [],
        isUpdate: true,
        busy: false,
        disabled: false,
        onConfirm: noop,
        onCancel: noop,
      }),
    );
    expect(html).toContain('This update does not widen what the skill can do.');
    expect(html).toContain('Update now');
    expect(html).not.toContain('What this update adds');
  });
});

// ---------------------------------------------------------------------------
// M28 cut C (PLAN-M28.md): the FLOW tab and the tab strip it decides.
//
// The strip is a property of the DRAFT KIND, so it is asserted by rendering the
// editor: a flow-backed draft leads with Flow and opens on it; a code-authored
// draft keeps Code · Validation and carries the honest door to a flow. Where the
// property is an EFFECT (the tab is re-decided when the draft kind changes) it is
// asserted against the source with comments stripped, because
// `renderToStaticMarkup` does not run effects — the house rule this suite
// states up front.
// ---------------------------------------------------------------------------

/** The same draft, backed by a flow that has not been compiled yet. */
const FLOW_DRAFT: SkillDraft = {
  ...DRAFT,
  flow: {
    version: 1,
    nodes: [
      {
        id: 'in',
        type: 'input',
        position: { x: 0, y: 0 },
        data: { fields: [{ name: 'text', type: 'string', required: true }] },
      },
      { id: 'msg', type: 'template', position: { x: 240, y: 0 }, data: { text: '{{text}}' } },
      { id: 'out', type: 'output', position: { x: 480, y: 0 }, data: { shape: 'text' } },
    ],
    edges: [
      { id: 'e0', source: 'in', target: 'msg' },
      { id: 'e1', source: 'msg', target: 'out' },
    ],
  },
  flowSha256: null,
  flowCompiledAt: null,
  flowStale: true,
};

describe('M28 C: the Flow tab', () => {
  it('a code-authored draft keeps Code · Validation and offers the flow door by name', () => {
    const html = renderToStaticMarkup(
      h(DraftEditor, {
        draft: DRAFT,
        readOnly: false,
        disabled: false,
        onDraftChanged: noop,
        onSessionLost: noop,
      }),
    );
    // Two tabs, Code first and pressed.
    expect(count(html, 'seg-tab"')).toBe(2);
    expect(html).toContain('>Code<');
    expect(html).toContain('>Validation<');
    expect(html).not.toContain('>Flow<');
    // D7's sentence, and both routes to a graph, are in the Code panel.
    expect(html).toContain('no decompiler here');
    expect(html).toContain('Start an empty flow');
    expect(html).toContain('Build a flow from this code (lossy)');
    // The entry source is still the default reading task for this draft.
    expect(html).toContain('Entry source (entry.mjs)');
  });

  it('a flow-backed draft leads with Flow and opens on it', () => {
    const html = renderToStaticMarkup(
      h(DraftEditor, {
        draft: FLOW_DRAFT,
        readOnly: false,
        disabled: false,
        onDraftChanged: noop,
        onSessionLost: noop,
      }),
    );
    // Three tabs, and FLOW is the pressed one.
    expect(count(html, 'seg-tab"')).toBe(3);
    expect(html.indexOf('>Flow<')).toBeLessThan(html.indexOf('>Code<'));
    expect(html.indexOf('>Code<')).toBeLessThan(html.indexOf('>Validation<'));
    expect(html).toContain('aria-pressed="true"');
    // The canvas panel is the open one: it reads the flow from the core first
    // (the graph, its derived staleness and the palette gate all come from the
    // core — nothing here is inferred), so its loading state is what renders.
    expect(html).toContain('Loading the flow');
    // The code-authored door is NOT offered once there is a flow.
    expect(html).not.toContain('Start an empty flow');
  });

  it('offers no flow door on an installed draft (every write is refused)', () => {
    const html = renderToStaticMarkup(
      h(DraftEditor, {
        draft: { ...DRAFT, status: 'installed', installedVersion: '0.1.0' },
        readOnly: true,
        disabled: false,
        onDraftChanged: noop,
        onSessionLost: noop,
      }),
    );
    expect(html).not.toContain('Start an empty flow');
    expect(html).not.toContain('Build a flow from this code');
  });

  /**
   * SOURCE-LEVEL on purpose: the tab is re-decided by an effect keyed on the
   * draft KIND, and effects do not run under static markup. What is asserted is
   * the wiring a deep link depends on — a flow-backed draft lands on the canvas,
   * and starting a flow from the Code panel switches to it.
   */
  it('wires the tab to the draft kind and the starter to the canvas', () => {
    const editor = source('src/studio/DraftEditor.tsx');
    expect(editor).toContain("setTab(draft.flow === null ? 'code' : 'flow')");
    expect(editor).toContain("onFlowStarted={() => setTab('flow')}");
    expect(editor).toContain("{ id: 'flow', label: 'Flow' }");
    expect(editor).toContain("{ id: 'validation', label: 'Validation' }");
    // The deep link itself is a container concern and stays where it was: a
    // focus intent wins over the local selection (asserted above), and the draft
    // it names is what the editor renders.
    expect(source('src/SkillStudio.tsx')).toContain('resolveSelectedDraft');
  });
});
