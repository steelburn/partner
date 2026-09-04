import { describe, expect, it } from 'vitest';
import type { SkillInvocationMeta, SkillPermissions } from '@partner/shared';
import {
  MAX_ARGS_BYTES,
  formatBytes,
  formatInvocations,
  invocationErrorLabel,
  permissionSummary,
  readPermissions,
  riskChip,
  sortSkills,
  validateArgsJson,
} from '../src/lib/skill-helpers.js';
import type { SkillSummary } from '@partner/shared';

function permissions(overrides: Partial<SkillPermissions> = {}): SkillPermissions {
  return {
    tools: [],
    network: false,
    risk: 'low',
    ...overrides,
  };
}

function summary(overrides: Partial<SkillSummary> = {}): SkillSummary {
  return {
    id: 's-1',
    name: 'Skill one',
    description: 'd',
    author: 'partner',
    version: '1.0.0',
    source: 'local',
    status: 'installed',
    sha256: 'h',
    installedAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

function invocation(overrides: Partial<SkillInvocationMeta> = {}): SkillInvocationMeta {
  return {
    id: 'inv-1',
    skillId: 's-1',
    personaId: null,
    startedAt: 100,
    finishedAt: 200,
    ok: true,
    toolCalls: 0,
    error: null,
    ms: 100,
    ...overrides,
  };
}

describe('readPermissions', () => {
  it('accepts a bare permissions block or a {permissions} wrapper', () => {
    const bare = permissions({ tools: ['files.read'], risk: 'high' });
    expect(readPermissions(bare)).toEqual(bare);
    expect(readPermissions({ permissions: bare })).toEqual(bare);
    expect(readPermissions({ permissions: { tools: 'nope' } })).toBeNull();
    expect(readPermissions(null)).toBeNull();
  });
});

describe('permissionSummary', () => {
  it('lists declared tools with the M2 human labels', () => {
    const chips = permissionSummary(
      permissions({ tools: ['files.read', 'files.search'], risk: 'high' }),
    );
    const labels = chips.map((chip) => chip.label);
    expect(labels).toContain('Read file');
    expect(labels).toContain('Search files');
    expect(labels).toContain('High risk');
    const readChip = chips.find((chip) => chip.label === 'Read file');
    expect(readChip?.title).toBe('Tool: files.read');
  });

  it('shows a single "No tools" chip when nothing is declared', () => {
    const chips = permissionSummary(permissions());
    expect(chips.some((chip) => chip.label === 'No tools')).toBe(true);
    expect(chips.some((chip) => chip.label === 'Low risk')).toBe(true);
  });

  it('flags network as a red danger chip only when declared', () => {
    const none = permissionSummary(permissions());
    expect(none.some((chip) => chip.label === 'Network')).toBe(false);

    const flagged = permissionSummary(permissions({ network: true }));
    const network = flagged.find((chip) => chip.label === 'Network');
    expect(network?.tone).toBe('danger');
  });

  it('reads permissions out of a full manifest (nested shape)', () => {
    const chips = permissionSummary({ permissions: permissions({ risk: 'medium' }) });
    expect(chips.some((chip) => chip.label === 'Medium risk')).toBe(true);
  });

  it('maps risk tiers to the documented semantic tones', () => {
    expect(riskChip('low').tone).toBe('success');
    expect(riskChip('medium').tone).toBe('neutral');
    expect(riskChip('high').tone).toBe('danger');
  });

  it('degrades to a danger "unknown" chip for malformed input', () => {
    const chips = permissionSummary({ permissions: { nope: true } });
    expect(chips[0]?.label).toBe('Permissions unknown');
    expect(chips[0]?.tone).toBe('danger');
  });
});

describe('sortSkills', () => {
  it('keeps installed skills above disabled ones', () => {
    const installed = summary({ id: 'a', name: 'Zeta' });
    const disabled = summary({ id: 'b', name: 'Alpha', status: 'disabled' });
    expect(sortSkills([disabled, installed]).map((row) => row.id)).toEqual(['a', 'b']);
  });

  it('orders within a status by name (case-insensitive), then id', () => {
    const list = [
      summary({ id: 'x', name: 'bravo' }),
      summary({ id: 'y', name: 'alpha' }),
      summary({ id: 'z', name: 'Alpha' }),
    ];
    expect(sortSkills(list).map((row) => row.id)).toEqual(['y', 'z', 'x']);
  });

  it('does not mutate the input array', () => {
    const list = [summary({ id: 'b' }), summary({ id: 'a' })];
    const copy = [...list];
    sortSkills(list);
    expect(list).toEqual(copy);
  });
});

describe('invocationErrorLabel', () => {
  it('labels every documented code', () => {
    expect(invocationErrorLabel('not_found')).toMatch(/not found/i);
    expect(invocationErrorLabel('disabled')).toMatch(/disabled/i);
    expect(invocationErrorLabel('budget_exceeded')).toMatch(/budget/i);
    expect(invocationErrorLabel('crashed')).toMatch(/crash/i);
    expect(invocationErrorLabel('denied')).toMatch(/denied/i);
    expect(invocationErrorLabel('tool_denied')).toMatch(/denied/i);
  });

  it('falls back for unknown codes without echoing the value', () => {
    expect(invocationErrorLabel('something_new')).toBe('Invocation failed');
  });
});

describe('validateArgsJson', () => {
  it('parses valid JSON and reports its byte size', () => {
    const check = validateArgsJson('{"a":1}');
    expect(check.ok).toBe(true);
    if (check.ok) expect(check.value).toEqual({ a: 1 });
    expect(formatBytes(check.bytes)).toBe('7 B');
  });

  it('accepts empty / whitespace text as "no args"', () => {
    expect(validateArgsJson('')).toEqual({ ok: true, value: undefined, bytes: 0 });
    expect(validateArgsJson('   \n ').ok).toBe(true);
  });

  it('rejects invalid JSON with an error that never echoes content', () => {
    const check = validateArgsJson('{broken');
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toMatch(/valid JSON/i);
  });

  it('rejects oversized text over the 64 KB cap before parsing', () => {
    const oversize = `{"blob":"${'x'.repeat(MAX_ARGS_BYTES)}"}`;
    const check = validateArgsJson(oversize);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.error).toMatch(/64 KB/i);
  });

  it('counts bytes as UTF-8 so multi-byte text cannot dodge the cap', () => {
    // 3-byte character: 1024 characters -> 3072 bytes, not 1024.
    const text = JSON.stringify({ s: 'é'.repeat(1024) });
    const check = validateArgsJson(text);
    expect(check.ok).toBe(true);
    expect(check.bytes).toBeGreaterThan(1024);
  });
});

describe('formatInvocations', () => {
  it('sorts newest first and renders ok rows with counts', () => {
    const old = invocation({ id: 'a', startedAt: 100, ms: 50, toolCalls: 1 });
    const fresh = invocation({ id: 'b', startedAt: 500, ms: 250, toolCalls: 3 });
    const rows = formatInvocations([old, fresh], 600);
    expect(rows.map((row) => row.id)).toEqual(['b', 'a']);
    expect(rows[0]).toMatchObject({ ok: true, running: false, toolCalls: 3, ms: 250, errorLabel: null });
    expect(rows[0]?.startedLabel).toBe('now');
  });

  it('marks in-flight runs (finishedAt null) as running without an error label', () => {
    const rows = formatInvocations([invocation({ finishedAt: null, ok: false, error: null })], 200);
    expect(rows[0]).toMatchObject({ running: true, ok: false, errorLabel: null, errorCode: null });
  });

  it('maps the coded error onto failed rows (never the content)', () => {
    const rows = formatInvocations(
      [invocation({ ok: false, error: 'tool_denied', ms: 30, toolCalls: 1 })],
      300,
    );
    expect(rows[0]).toMatchObject({ ok: false, running: false, errorCode: 'tool_denied' });
    expect(rows[0]?.errorLabel).toMatch(/denied/i);
  });
});
