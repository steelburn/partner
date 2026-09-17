/**
 * The skill-install approval card (M26 D2b, the M26-review addition).
 *
 * What this file pins, in the order it matters:
 *
 *   1. THE CONSENT RULE. `acknowledgePermissions` travels only when the
 *      before→after table is on screen — the same rule the Studio's install
 *      confirmation applies, asserted here on its own so neither surface can
 *      drift into sending an acknowledgement the owner never saw.
 *   2. THE CARD. An install ask shows the draft's plain-language permission
 *      summary; an UPDATE shows the version it moves from → to and, when it
 *      widens, the change table — plus `permission_change` rendered as the next
 *      step ("press Update now") instead of a dead end.
 *   3. THE LOADER. `loadSkillInstallView` probes the installed skill by the
 *      MANIFEST id (an edit draft lives at `<skill>-edit`), so a first install
 *      and an update are told apart from the same two endpoints the Studio uses.
 *
 * Rendered with `react-dom/server` (this suite has no DOM), so the states that
 * come from an EFFECT — the fetch — are asserted through the loader and through
 * the presentational body, and the wiring is asserted against the source.
 */
import { describe, expect, it } from 'vitest';
import { createElement as h } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { PendingToolCall, SkillDraft, SkillManifest } from '@partner/shared';
import {
  SkillInstallBody,
  loadSkillInstallView,
  skillInstallDecision,
} from '../src/SkillInstallCard.js';
import { permissionDiffRows } from '../src/lib/skill-studio-helpers.js';
import { source } from './helpers/css.js';

const MANIFEST: SkillManifest = {
  id: 'hello-skill',
  name: 'Hello Skill',
  description: 'greets',
  author: 'You',
  version: '0.1.0',
  entrypoint: 'entry.mjs',
  permissions: { tools: [], network: false, risk: 'low' },
  budget: { timeMs: 10_000 },
};

function draft(over: Partial<SkillDraft> = {}): SkillDraft {
  return {
    id: 'hello-skill-edit',
    name: 'Hello Skill',
    description: 'greets',
    status: 'draft',
    origin: 'edit',
    manifest: MANIFEST,
    validation: { ok: true, errors: [], warnings: [], checkedAt: 1 },
    model: null,
    conversationId: 'conv-1',
    personaId: null,
    pendingInstallId: null,
    createdAt: 1,
    updatedAt: 1,
    code: 'export function run(){ return {}; }',
    prompt: '',
    manifestText: JSON.stringify(MANIFEST, null, 2),
    installedVersion: null,
    flow: null,
    flowSha256: null,
    flowCompiledAt: null,
    flowStale: false,
    ...over,
  };
}

const ROW: PendingToolCall = {
  id: 'pending-1',
  toolId: 'skill.install' as PendingToolCall['toolId'],
  params: { draftId: 'hello-skill-edit' },
  risk: 'high',
  requestedBy: 'persona',
  createdAt: 1,
  personaName: 'Builder',
  conversationId: 'conv-1',
  kind: 'skill_install',
  draftId: 'hello-skill-edit',
  draftName: 'Hello Skill',
};

const noop = (): void => undefined;
const body = (over: Partial<Parameters<typeof SkillInstallBody>[0]> = {}): string =>
  renderToStaticMarkup(
    h(SkillInstallBody, {
      draftName: 'Hello Skill',
      view: { draft: draft(), installed: null, rows: [] },
      busy: false,
      deciding: false,
      error: null,
      onDecide: noop,
      ...over,
    }),
  );

// ---------------------------------------------------------------------------
// 1. The consent rule
// ---------------------------------------------------------------------------

describe('the acknowledgement travels only with the change table', () => {
  it('is empty when nothing widens, so a first install never claims to ack', () => {
    expect(skillInstallDecision([])).toEqual({});
  });

  it('carries acknowledgePermissions exactly when there is a table to have read', () => {
    const rows = permissionDiffRows(MANIFEST, {
      ...MANIFEST,
      permissions: { tools: ['files.read'], network: false, risk: 'medium' },
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(skillInstallDecision(rows)).toEqual({ acknowledgePermissions: true });
  });
});

// ---------------------------------------------------------------------------
// 2. The card
// ---------------------------------------------------------------------------

describe('skill install card — a first install', () => {
  it('names the skill and its permissions, and offers one press to install', () => {
    const html = body();
    expect(html).toContain('Install skill: Hello Skill');
    expect(html).toContain('No tools');
    expect(html).toContain('aria-label="Install Hello Skill"');
    // No table and no acknowledgement path for something that grants nothing new.
    expect(html).not.toContain('studio-diff-table');
    expect(html).not.toContain('including every line in the change table');
    expect(html).toContain('Deny');
  });

  it('says it is reading the draft before the manifests arrive', () => {
    const html = body({ view: null });
    expect(html).toContain('Skill install: Hello Skill');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Reading the draft…');
  });

  it('explains a draft it cannot read instead of showing an empty card', () => {
    const html = body({ view: null, loadError: 'Could not read that draft — it may have been discarded.' });
    expect(html).toContain('role="alert"');
    expect(html).toContain('may have been discarded');
    expect(html).not.toContain('Reading the draft…');
  });
});

describe('skill install card — an update', () => {
  const WIDER: SkillManifest = {
    ...MANIFEST,
    version: '0.2.0',
    permissions: { tools: ['files.read'], network: false, risk: 'medium' },
  };
  const rows = permissionDiffRows(MANIFEST, WIDER);

  it('shows the version it moves from → to, and the widening table before the press', () => {
    const html = body({
      view: { draft: draft({ manifest: WIDER }), installed: { manifest: MANIFEST, version: '0.1.0' }, rows },
    });
    expect(html).toContain('Update skill: Hello Skill');
    expect(html).toContain('v0.1.0 → v0.2.0');
    expect(html).toContain('studio-diff-table');
    expect(html).toContain('<th scope="col">Before</th>');
    expect(html).toContain('<th scope="col">After</th>');
    expect(html).toContain('Tools');
    expect(html).toContain('widens what the skill may do');
    // The press that sends the acknowledgement names what it is approving.
    expect(html).toContain('aria-label="Update Hello Skill — including every line in the change table"');
    expect(html).toContain('>Update now<');
  });

  it('says so when an update does not widen anything', () => {
    const html = body({
      view: { draft: draft({ manifest: WIDER }), installed: { manifest: WIDER, version: '0.2.0' }, rows: [] },
    });
    expect(html).toContain('This update does not widen what the skill can do.');
    expect(html).not.toContain('studio-diff-table');
  });

  it('turns the core own permission_change refusal into the next step', () => {
    const html = body({
      view: { draft: draft({ manifest: WIDER }), installed: { manifest: MANIFEST, version: '0.1.0' }, rows },
      error: 'permission_change',
    });
    expect(html).toContain('wants this widening acknowledged');
    expect(html).toContain('press Update now');
  });

  it('shows any other refusal verbatim', () => {
    const html = body({ error: 'not_pending' });
    expect(html).toContain('not_pending');
    expect(html).not.toContain('wants this widening acknowledged');
  });
});

// ---------------------------------------------------------------------------
// 3. The loader (the two endpoints the Studio also uses)
// ---------------------------------------------------------------------------

describe('loading the consent view', () => {
  /** A fetch stand-in that answers the draft and the skill lookups by path. */
  function fakeFetch(handlers: {
    draft?: () => { status: number; body: unknown };
    skill?: () => { status: number; body: unknown };
  }) {
    const calls: string[] = [];
    const impl = async (input: string): Promise<Response> => {
      calls.push(input);
      const answer = input.includes('/v1/skills/drafts/')
        ? (handlers.draft?.() ?? { status: 404, body: { error: 'not_found' } })
        : (handlers.skill?.() ?? { status: 404, body: { error: 'not_found' } });
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    };
    return { impl, calls };
  }

  it('probes the installed skill by the MANIFEST id, and reports no update when absent', async () => {
    const update = draft();
    const { impl, calls } = fakeFetch({
      draft: () => ({ status: 200, body: update }),
      // No installed skill: a first install.
      skill: () => ({ status: 404, body: { error: 'not_found' } }),
    });
    const view = await loadSkillInstallView('token', 'hello-skill-edit', { fetchImpl: impl });
    expect(view.draft.id).toBe('hello-skill-edit');
    expect(view.installed).toBeNull();
    expect(view.rows).toEqual([]);
    // The draft id is `<skill>-edit`; the skill probe must use `hello-skill`.
    expect(calls.some((url) => url.endsWith('/v1/skills/hello-skill'))).toBe(true);
    expect(calls.some((url) => url.endsWith('/v1/skills/drafts/hello-skill-edit'))).toBe(true);
  });

  it('computes the change table from the installed manifest and the draft', async () => {
    const wider = draft({
      manifest: { ...MANIFEST, version: '0.2.0', permissions: { tools: ['files.read'], network: false, risk: 'medium' } },
    });
    const { impl } = fakeFetch({
      draft: () => ({ status: 200, body: wider }),
      skill: () => ({ status: 200, body: { ...MANIFEST, source: 'authored', status: 'installed', sha256: 'x', installedAt: 1, updatedAt: 1, manifest: MANIFEST } }),
    });
    const view = await loadSkillInstallView('token', 'hello-skill-edit', { fetchImpl: impl });
    expect(view.installed?.version).toBe('0.1.0');
    expect(view.rows.map((row) => row.field)).toContain('tools');
    expect(skillInstallDecision(view.rows)).toEqual({ acknowledgePermissions: true });
  });
});

// ---------------------------------------------------------------------------
// 4. Wiring (source-level: the decision is an event handler, and effects do not
//    run under static markup — the house rule this suite states for such cases)
// ---------------------------------------------------------------------------

describe('both ask surfaces render the card', () => {
  it('the chat renders it for a skill_install row and passes the acknowledgement through', () => {
    const chat = source('src/ChatStrip.tsx');
    expect(chat).toContain("row.kind === 'skill_install'");
    expect(chat).toContain('<SkillInstallCard');
    expect(chat).toContain('decideChatApproval(row, decision, options)');
    expect(chat).toContain('decidePending(token, row.id, { decision, ...options })');
  });

  it('the Files queue renders it too, with its own decide call', () => {
    const files = source('src/FilesView.tsx');
    expect(files).toContain("item.kind === 'skill_install'");
    expect(files).toContain('<SkillInstallCard');
    expect(files).toContain('decidePending(token, item.id, { decision, ...options })');
  });
});

describe('a stale view is re-read when the core asks for the acknowledgement', () => {
  it('reloads on permission_change so the table it asks about is on screen', () => {
    const card = source('src/SkillInstallCard.tsx');
    // The refusal is the ONLY signal that this card's view is stale, so it is
    // what triggers the re-read — asserting the wiring because the effect does
    // not run under static markup (the house rule for effects in this suite).
    expect(card).toContain("error.includes('permission_change')");
    expect(card).toContain('setReloadKey');
    expect(card).toContain('[draftId, reloadKey]');
  });
});
