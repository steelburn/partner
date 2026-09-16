/**
 * M26 Skill Studio helper tests (PLAN-M26.md cut D).
 *
 * These guard the three rules the Studio cannot afford to get wrong, each of
 * which is a single pure function on purpose:
 *
 *   1. `installRequestBody` — the acknowledgement travels only after the
 *      confirmation step, so no component can send it unseen (D6).
 *   2. `permissionDiffRows` — the consent table shows WIDENING only: a narrowed
 *      permission set is not a new power and must not nag.
 *   3. `resolveSelectedDraft` — a deep-link intent wins over whatever the rail
 *      had selected, and stops winning once it is cleared.
 */
import { describe, expect, it } from 'vitest';
import type { PermissionDiffEntry, SkillDraftValidation, SkillManifest } from '@partner/shared';
import {
  DRAFT_ORIGIN_LABELS,
  PERMISSION_FIELD_LABELS,
  draftOriginLabel,
  dryRunArgs,
  installRequestBody,
  permissionDiffRows,
  resolveSelectedDraft,
  slugPreview,
  templateOptions,
  toolOptions,
  validationSummary,
  warningCount,
} from '../src/lib/skill-studio-helpers.js';
import { MAX_ARGS_BYTES } from '../src/lib/skill-helpers.js';

function manifest(overrides: {
  tools?: string[];
  mcpServers?: string[];
  risk?: string;
  network?: boolean;
  llm?: boolean;
  timeMs?: number;
  maxTokens?: number;
}): SkillManifest {
  return {
    id: 'draft-one',
    name: 'Draft one',
    description: '',
    author: 'You',
    version: '0.1.0',
    entrypoint: 'entry.mjs',
    permissions: {
      tools: (overrides.tools ?? []) as SkillManifest['permissions']['tools'],
      network: overrides.network === true,
      risk: (overrides.risk ?? 'low') as SkillManifest['permissions']['risk'],
      ...(overrides.mcpServers !== undefined ? { mcpServers: overrides.mcpServers } : {}),
      ...(overrides.llm !== undefined ? { llm: overrides.llm } : {}),
    },
    budget: {
      timeMs: overrides.timeMs ?? 30_000,
      ...(overrides.maxTokens !== undefined ? { maxTokens: overrides.maxTokens } : {}),
    },
  };
}

function validation(overrides: Partial<SkillDraftValidation>): SkillDraftValidation {
  return { ok: true, errors: [], warnings: [], checkedAt: 1, ...overrides };
}

describe('slugPreview', () => {
  it('mirrors the core slug rules for a normal name', () => {
    expect(slugPreview('Scratch notes to checklist')).toBe('scratch-notes-to-checklist');
  });

  it('collapses runs of unsupported characters and trims separators', () => {
    expect(slugPreview('  --Hello,  World!! -- ')).toBe('hello-world');
  });

  it('keeps dots, underscores and dashes (a valid id may contain them)', () => {
    expect(slugPreview('csv_to-md.v2')).toBe('csv_to-md.v2');
  });

  it('caps at 48 characters, like the core allocator', () => {
    expect(slugPreview('a'.repeat(80)).length).toBe(48);
  });

  it('returns an empty preview rather than an invalid id', () => {
    expect(slugPreview('!!!')).toBe('');
    expect(slugPreview('')).toBe('');
  });
});

describe('origin labels', () => {
  it('names every origin the wire type can carry', () => {
    expect(Object.keys(DRAFT_ORIGIN_LABELS).sort()).toEqual([
      'chat',
      'edit',
      'fork',
      'generated',
      'import',
      'manual',
      'template',
    ]);
    expect(draftOriginLabel('chat')).toBe('From chat');
    expect(draftOriginLabel('import')).toBe('Imported');
  });

  it('names an unknown origin as itself instead of inventing a label', () => {
    expect(draftOriginLabel('teleported')).toBe('teleported');
  });
});

describe('validationSummary', () => {
  it('reads ok as ok', () => {
    expect(validationSummary(validation({}))).toEqual({ ok: true, label: 'ok' });
  });

  it('counts the problems, singular and plural', () => {
    expect(validationSummary(validation({ ok: false, errors: ['bad tool'] }))).toEqual({
      ok: false,
      label: '1 problem',
    });
    expect(validationSummary(validation({ ok: false, errors: ['a', 'b', 'c'] })).label).toBe(
      '3 problems',
    );
  });

  it('calls a not-ok record with no errors unvalidated, never "0 problems"', () => {
    expect(validationSummary(validation({ ok: false, errors: [] })).label).toBe('not validated');
  });

  it('counts warnings for the panel head', () => {
    expect(warningCount(validation({ warnings: ['cannot reach the network'] }))).toBe(1);
  });
});

describe('toolOptions', () => {
  it('offers the registry vocabulary in registry order', () => {
    const options = toolOptions([]);
    expect(options[0]).toEqual({ id: 'files.list', label: 'List directory' });
    expect(options.map((option) => option.id)).toContain('files.delete');
  });

  it('keeps an id a draft already declares, so it can be seen and removed', () => {
    const options = toolOptions(['notes.read']);
    expect(options.map((option) => option.id)).toContain('notes.read');
    expect(options.find((option) => option.id === 'notes.read')?.label).toBe('notes.read');
  });

  it('does not duplicate an id that is in both the registry and the manifest', () => {
    const options = toolOptions(['files.read']);
    expect(options.filter((option) => option.id === 'files.read')).toHaveLength(1);
  });
});

describe('templateOptions', () => {
  it('shapes the core list for the picker', () => {
    expect(
      templateOptions([
        { id: 'pure', name: 'Pure skill', description: 'Transforms args', reach: 'Nothing else.' },
      ]),
    ).toEqual([
      { id: 'pure', label: 'Pure skill', description: 'Transforms args', reach: 'Nothing else.' },
    ]);
  });

  it('drops an entry with no id (it could not be requested) and falls back to the id', () => {
    const options = templateOptions([
      { id: '', name: 'Broken', description: '', reach: '' },
      { id: 'reads-files', name: '', description: 'Lists files', reach: '' },
    ]);
    expect(options).toHaveLength(1);
    expect(options[0]).toEqual({
      id: 'reads-files',
      label: 'reads-files',
      description: 'Lists files',
      reach: '',
    });
  });

  it('handles an empty template list', () => {
    expect(templateOptions([])).toEqual([]);
  });
});

describe('permissionDiffRows (the consent table)', () => {
  it('has a label for every field the wire type can carry', () => {
    const fields: Array<PermissionDiffEntry['field']> = [
      'tools',
      'mcpServers',
      'risk',
      'network',
      'llm',
      'budget.timeMs',
      'budget.maxTokens',
    ];
    for (const field of fields) expect(PERMISSION_FIELD_LABELS[field]).toBeTruthy();
  });

  it('reports nothing for a create (no installed skill to compare with)', () => {
    expect(permissionDiffRows(null, manifest({ tools: ['files.read'] }))).toEqual([]);
  });

  it('reports nothing when the permission set does not widen', () => {
    expect(permissionDiffRows(manifest({ tools: ['files.read'] }), manifest({ tools: ['files.read'] }))).toEqual(
      [],
    );
  });

  it('does not nag when a permission set NARROWS', () => {
    expect(
      permissionDiffRows(
        manifest({ tools: ['files.read', 'files.delete'], risk: 'high', timeMs: 60_000 }),
        manifest({ tools: ['files.read'], risk: 'low', timeMs: 10_000 }),
      ),
    ).toEqual([]);
  });

  it('lists an added tool with before/after values', () => {
    const rows = permissionDiffRows(manifest({ tools: ['files.list'] }), manifest({ tools: ['files.list', 'files.read'] }));
    expect(rows).toEqual([
      { field: 'tools', label: 'Tools', before: 'files.list', after: 'files.list, files.read' },
    ]);
  });

  it('lists a raised risk, a new network reach, model reach and both budgets', () => {
    const rows = permissionDiffRows(
      manifest({ risk: 'low', network: false, timeMs: 10_000 }),
      manifest({
        risk: 'high',
        network: true,
        llm: true,
        timeMs: 20_000,
        maxTokens: 1_000,
        mcpServers: ['notes'],
      }),
    );
    expect(rows.map((row) => row.field)).toEqual([
      'mcpServers',
      'risk',
      'network',
      'llm',
      'budget.timeMs',
      'budget.maxTokens',
    ]);
    expect(rows.find((row) => row.field === 'network')).toMatchObject({
      before: 'false',
      after: 'true',
    });
    expect(rows.find((row) => row.field === 'budget.timeMs')).toMatchObject({
      before: '10000',
      after: '20000',
    });
  });

  it('reports nothing when a manifest is missing on either side', () => {
    expect(permissionDiffRows(manifest({}), null)).toEqual([]);
  });
});

describe('installRequestBody (the two-step gate)', () => {
  const rows = permissionDiffRows(manifest({ tools: [] }), manifest({ tools: ['files.read'] }));

  it('sends NOTHING before the confirmation step', () => {
    expect(installRequestBody('idle', rows)).toBeNull();
    expect(installRequestBody('idle', [])).toBeNull();
  });

  it('omits the acknowledgement when there is nothing to acknowledge', () => {
    expect(installRequestBody('confirm', [])).toEqual({});
  });

  it('sends the acknowledgement once the table has been shown', () => {
    expect(installRequestBody('confirm', rows)).toEqual({ acknowledgePermissions: true });
  });

  it('acknowledges when the CORE demanded it even if this screen found no rows', () => {
    expect(installRequestBody('confirm', [], { coreDemanded: true })).toEqual({
      acknowledgePermissions: true,
    });
  });
});

describe('dryRunArgs', () => {
  it('accepts empty text as "no args"', () => {
    expect(dryRunArgs('   ')).toMatchObject({ ok: true, value: undefined });
  });

  it('parses JSON and counts its bytes', () => {
    const check = dryRunArgs('{"a":1}');
    expect(check.ok).toBe(true);
    if (!check.ok) throw new Error('unreachable');
    expect(check.value).toEqual({ a: 1 });
    expect(check.bytes).toBe(7);
  });

  it('refuses malformed JSON without echoing the content back', () => {
    const check = dryRunArgs('{oops}');
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error('unreachable');
    expect(check.error).not.toContain('oops');
  });

  it('shares the invocation cap, so the two fields cannot disagree', () => {
    const oversized = `"${'a'.repeat(MAX_ARGS_BYTES + 1)}"`;
    const check = dryRunArgs(oversized);
    expect(check.ok).toBe(false);
    if (check.ok) throw new Error('unreachable');
    expect(check.error).toContain('64 KB');
  });
});

describe('resolveSelectedDraft (the deep-link intent)', () => {
  const drafts = [{ id: 'a' }, { id: 'b' }];

  it('lets a deep-link intent win over the local selection', () => {
    expect(resolveSelectedDraft(drafts, 'b', 'a')).toBe('b');
  });

  it('honours an intent for a draft the list has not loaded yet', () => {
    expect(resolveSelectedDraft([], 'fresh', null)).toBe('fresh');
  });

  it('keeps the local choice once the intent is cleared', () => {
    expect(resolveSelectedDraft(drafts, null, 'b')).toBe('b');
    expect(resolveSelectedDraft(drafts, '', 'b')).toBe('b');
  });

  it('falls back to the newest draft when the local choice is gone', () => {
    expect(resolveSelectedDraft(drafts, null, 'discarded')).toBe('a');
  });

  it('selects nothing when there are no drafts', () => {
    expect(resolveSelectedDraft([], null, null)).toBeNull();
  });
});
