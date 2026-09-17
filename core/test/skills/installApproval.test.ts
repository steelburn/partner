/**
 * M26 cut C — the install APPROVAL (PLAN-M26.md D2b, L1).
 *
 * What these tests pin, in the order the milestone cares:
 *
 *   1. AN ASK IS NOT AN ACTION. `requestInstall` writes one `pending_tools` row
 *      of kind 'skill_install' and installs NOTHING; only the owner's approve
 *      reaches `promote`.
 *   2. THE QUEUE CANNOT EXECUTE IT. `broker.decide` (here: the pending manager's
 *      own decide) refuses the row with `wrong_kind`, and `settleInstall` is the
 *      only door that closes it.
 *   3. A DENY and a DISCARD both leave no dangling card, and a discard takes the
 *      draft with it.
 *   4. The audit rows carry ids/flags/counts — never the draft's code or text.
 */
import { describe, expect, it } from 'vitest';
import type { ToolRisk } from '@partner/shared';
import {
  createSkillDraftManager,
} from '../../src/skills/drafts.js';
import type { SkillDraftManagerOptions } from '../../src/skills/drafts.js';
import { createSkillManager } from '../../src/skills/manager.js';
import { SkillError } from '../../src/skills/errors.js';
import { ToolError } from '../../src/broker/errors.js';
import { createPendingManager } from '../../src/broker/pending.js';
import { REPO_CATALOG, makeTempRoot, removeTempRoot } from '../helpers.js';
import {
  createAuditStore,
  createPendingToolStore,
  createSkillDraftStore,
  createSkillInvocationStore,
  createSkillStore,
  openDatabase,
} from '../../src/stores/db.js';
import { auditLog } from '../../src/services/redaction.js';

const TOOLS = new Set([
  'files.read',
  'files.list',
  'files.search',
  'files.edit',
  'files.apply',
  'files.delete',
]);

/** The same registry's own risks (M28 D5 — the flow-compile ceiling reads it). */
const TOOL_RISKS = new Map<string, ToolRisk>([
  ['files.read', 'low'],
  ['files.list', 'low'],
  ['files.search', 'low'],
  ['files.edit', 'medium'],
  ['files.apply', 'high'],
  ['files.delete', 'high'],
]);

const MANIFEST = (id: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    id,
    name: 'Scratch To Checklist',
    description: 'turns scratch notes into a checklist',
    author: 'Partner',
    version: '0.1.0',
    entrypoint: 'entry.mjs',
    permissions: { tools: [], network: false, risk: 'low' },
    budget: { timeMs: 5000 },
    ...over,
  });

const CODE = 'export function run(args){ return { ok: true }; }';

function env(overrides: Partial<SkillDraftManagerOptions> = {}) {
  const db = openDatabase(':memory:');
  const storeDir = makeTempRoot();
  const runsDir = makeTempRoot();
  const audit = auditLog({ store: createAuditStore(db) });
  const skills = createSkillManager({
    store: createSkillStore(db),
    invocations: createSkillInvocationStore(db),
    storeDir,
    catalogDir: REPO_CATALOG,
    tools: TOOLS,
    audit,
  });
  const toolStore = createPendingToolStore(db);
  const pending = createPendingManager({ store: toolStore });
  const drafts = createSkillDraftManager({
    store: createSkillDraftStore(db),
    skills,
    tools: TOOLS,
    riskOf: (toolId: string) => TOOL_RISKS.get(toolId) ?? null,
    audit,
    runsDir: overrides.runsDir ?? runsDir,
    ...overrides,
    // `pending: undefined` is a TEST case (the unwired queue), so the default is
    // added only when the caller did not name the dependency at all.
    ...('pending' in overrides ? {} : { pending }),
  });
  return {
    db,
    storeDir,
    audit,
    skills,
    drafts,
    pending,
    toolStore,
    close(): void {
      db.close();
      removeTempRoot(storeDir);
      removeTempRoot(runsDir);
    },
  };
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'no-error';
  } catch (err) {
    if (err instanceof SkillError || err instanceof ToolError) return err.code;
    return `other:${String(err)}`;
  }
}

async function stagedChatDraft(
  h: ReturnType<typeof env>,
  conversationId: string,
): Promise<string> {
  const draft = h.drafts.stageFromChat({
    name: 'Scratch To Checklist',
    description: 'turns scratch notes into a checklist',
    manifestText: MANIFEST('scratch-to-checklist'),
    code: CODE,
    conversationId,
    personaId: 'p-analyst',
  });
  return draft.id;
}

describe('requestInstall (the ask, not the action)', () => {
  it('opens a skill_install row for the draft and installs nothing', async () => {
    const h = env();
    try {
      const draft = h.drafts.stageFromChat({
        name: 'Scratch To Checklist',
        manifestText: MANIFEST('scratch-to-checklist'),
        code: CODE,
        conversationId: 'conv-7',
        personaId: 'p-analyst',
      });
      expect(draft.origin).toBe('chat');
      expect(draft.conversationId).toBe('conv-7');
      expect(draft.validation.ok).toBe(true);

      const { pendingId } = h.drafts.requestInstall(draft.id, {
        conversationId: 'conv-7',
        personaId: 'p-analyst',
      });
      const row = h.toolStore.findById(pendingId);
      expect(row).toMatchObject({
        kind: 'skill_install',
        draftId: draft.id,
        toolId: 'skill.install',
        requestedBy: 'persona',
        conversationId: 'conv-7',
        personaId: 'p-analyst',
        // The skill's OWN declared risk, so the queue reads honestly.
        risk: 'low',
        decidedAt: null,
      });
      // Invariant 1: the ask installed nothing at all.
      expect(h.skills.list()).toEqual([]);
      expect(h.drafts.get(draft.id)?.status).toBe('draft');
      // The draft reports the open ask so the Studio rail can mark it.
      expect(h.drafts.get(draft.id)?.pendingInstallId).toBe(pendingId);
      expect(h.drafts.list()[0]?.pendingInstallId).toBe(pendingId);
      // ...and the queue carries both the kind and the draft id.
      expect(h.pending.list()[0]).toMatchObject({
        id: pendingId,
        kind: 'skill_install',
        draftId: draft.id,
      });
    } finally {
      h.close();
    }
  });

  it('falls back to the draft own conversation and reuses an open ask', async () => {
    const h = env();
    try {
      const draftId = await stagedChatDraft(h, 'conv-9');
      const first = h.drafts.requestInstall(draftId);
      const row = h.toolStore.findById(first.pendingId);
      // No conversation was passed: the draft's own binding is used, so the
      // card still lands in the chat the draft came from.
      expect(row?.conversationId).toBe('conv-9');

      // A second ask must not stack a second card.
      const second = h.drafts.requestInstall(draftId, { conversationId: 'conv-9' });
      expect(second.pendingId).toBe(first.pendingId);
      expect(h.pending.list()).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('refuses an ask it could never honour, by name', async () => {
    const h = env();
    try {
      expect(codeOf(() => h.drafts.requestInstall('nope'))).toBe('not_found');

      // A draft that does not validate can only fail at approval, so the ask is
      // refused WITH the reason the model has to fix.
      const broken = h.drafts.stageFromChat({
        name: 'Broken',
        manifestText: MANIFEST('broken', { permissions: { tools: [], network: false, risk: 'extreme' } }),
        code: CODE,
      });
      expect(broken.validation.ok).toBe(false);
      let message = '';
      try {
        h.drafts.requestInstall(broken.id);
      } catch (err) {
        message = err instanceof SkillError ? err.message : '';
      }
      expect(message).toContain('fix it');

      // An already-installed draft cannot be promoted again.
      const installed = h.drafts.stageFromChat({
        name: 'Settled',
        manifestText: MANIFEST('settled'),
        code: CODE,
      });
      h.drafts.promote(installed.id);
      expect(codeOf(() => h.drafts.requestInstall(installed.id))).toBe('conflict');
      expect(h.pending.list()).toEqual([]);
    } finally {
      h.close();
    }
  });

  it('refuses by name when no approval queue is wired', async () => {
    const h = env({ pending: undefined });
    try {
      const draftId = await stagedChatDraft(h, 'conv-1');
      let message = '';
      try {
        h.drafts.requestInstall(draftId);
      } catch (err) {
        message = err instanceof SkillError ? err.message : '';
      }
      expect(codeOf(() => h.drafts.requestInstall(draftId))).toBe('invalid_input');
      expect(message).toContain('approval queue is not wired');
    } finally {
      h.close();
    }
  });
});

describe('deciding an install ask', () => {
  it('approving installs ONCE through promote, audited as via approval', async () => {
    const h = env();
    try {
      const draftId = await stagedChatDraft(h, 'conv-1');
      const { pendingId } = h.drafts.requestInstall(draftId, { conversationId: 'conv-1' });

      const result = h.drafts.promote(draftId, { via: 'approval' });
      expect(result.mode).toBe('created');
      expect(result.skill).toMatchObject({ id: draftId, source: 'authored', status: 'installed' });
      h.pending.settleInstall(pendingId, 'approve', 'web');

      expect(h.toolStore.findById(pendingId)?.decision).toBe('approve');
      expect(h.pending.list()).toEqual([]);
      expect(h.drafts.get(draftId)?.pendingInstallId).toBeNull();
      const install = h.audit.list(50).find((row) => row.action === 'skill.draft.install');
      expect(JSON.parse(install?.details ?? '{}')).toMatchObject({
        mode: 'created',
        via: 'approval',
      });

      // Exactly once: the second attempt is refused, and there is one skill.
      expect(codeOf(() => h.drafts.promote(draftId, { via: 'approval' }))).toBe('conflict');
      expect(codeOf(() => h.pending.settleInstall(pendingId, 'approve', 'web'))).toBe('not_pending');
      expect(h.skills.list()).toHaveLength(1);
    } finally {
      h.close();
    }
  });

  it('refuses broker.decide on the row and runs nothing', async () => {
    const h = env();
    try {
      const draftId = await stagedChatDraft(h, 'conv-1');
      const { pendingId } = h.drafts.requestInstall(draftId);

      // The queue's own decide can only approve a BROKER tool: an install ask is
      // a different decision with a different executor.
      expect(codeOf(() => h.pending.decide(pendingId, { decision: 'approve' }, 'web'))).toBe(
        'wrong_kind',
      );
      expect(codeOf(() => h.pending.settleInstall(pendingId, 'approve', 'web'))).toBe('no-error');
      // Nothing ran and nothing was installed by either call.
      expect(h.skills.list()).toEqual([]);
      expect(h.drafts.get(draftId)?.status).toBe('draft');
    } finally {
      h.close();
    }
  });

  it('denying closes the ask and leaves the draft exactly as it was', async () => {
    const h = env();
    try {
      const draftId = await stagedChatDraft(h, 'conv-1');
      const before = h.drafts.get(draftId);
      const { pendingId } = h.drafts.requestInstall(draftId);

      h.pending.settleInstall(pendingId, 'deny', 'web');
      const row = h.toolStore.findById(pendingId);
      expect(row?.decision).toBe('deny');
      expect(row?.decidedAt).not.toBeNull();
      expect(row?.decidedBy).toBe('web');
      expect(h.pending.list()).toEqual([]);

      const after = h.drafts.get(draftId);
      expect(after?.status).toBe('draft');
      expect(after?.code).toBe(before?.code);
      expect(after?.manifestText).toBe(before?.manifestText);
      expect(after?.pendingInstallId).toBeNull();
      expect(h.skills.list()).toEqual([]);
    } finally {
      h.close();
    }
  });
});

describe('discard closes the ask', () => {
  it('hard-deletes the draft and closes its open install ask', async () => {
    const h = env();
    try {
      const draftId = await stagedChatDraft(h, 'conv-1');
      const { pendingId } = h.drafts.requestInstall(draftId);
      h.drafts.discard(draftId);

      expect(h.drafts.get(draftId)).toBeNull();
      // No dangling card: the row is decided, so the queue cannot approve a
      // promote of a draft that no longer exists.
      expect(h.pending.list()).toEqual([]);
      expect(h.toolStore.findById(pendingId)?.decision).toBe('deny');
      const row = h.audit.list(50).find((entry) => entry.action === 'skill.draft.discard');
      expect(JSON.parse(row?.details ?? '{}')).toMatchObject({ hasPending: true });
    } finally {
      h.close();
    }
  });
});

describe('audit discipline', () => {
  it('never carries the draft code, manifest text or description', async () => {
    const h = env();
    try {
      const draft = h.drafts.stageFromChat({
        name: 'Quiet Draft',
        description: 'a secret description',
        manifestText: MANIFEST('quiet-draft'),
        code: 'export function run(){ return "secret code marker"; }',
        conversationId: 'conv-1',
      });
      h.drafts.requestInstall(draft.id, { conversationId: 'conv-1' });
      const rows = h.audit.list(100);
      const serialized = JSON.stringify(rows);
      expect(serialized).not.toContain('secret code marker');
      expect(serialized).not.toContain('a secret description');
      expect(serialized).not.toContain('entrypoint');
      const request = rows.find((row) => row.action === 'skill.draft.request');
      expect(JSON.parse(request?.details ?? '{}')).toMatchObject({
        reused: false,
        hasConversation: true,
      });
    } finally {
      h.close();
    }
  });
});
