import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../src/lib/audit.js';
import {
  auditAreaLabel,
  auditJsonText,
  auditMarkdownText,
  prettyAuditDetails,
} from '../src/lib/audit-helpers.js';

const ROWS: AuditEntry[] = [
  {
    id: 1,
    actor: 'session',
    action: 'chat.stream',
    target: 'gpt-4o',
    details: '{"ok":true,"events":3}',
    createdAt: 1_700_000_000_000,
  },
  {
    id: 2,
    actor: 'web',
    action: 'deploy-profile.create',
    target: 'eu-prod',
    details: '{"name":"eu-prod","port":22}',
    createdAt: 1_700_000_000_500,
  },
];

describe('auditAreaLabel', () => {
  it('maps action prefixes onto the five chip tones', () => {
    expect(auditAreaLabel('chat.stream')).toBe('chat');
    expect(auditAreaLabel('pair.verify')).toBe('chat');
    expect(auditAreaLabel('provider.create')).toBe('provider');
    expect(auditAreaLabel('provider.budget')).toBe('provider');
    expect(auditAreaLabel('playbook.run')).toBe('playbook');
    expect(auditAreaLabel('deploy-profile.package')).toBe('playbook');
    expect(auditAreaLabel('skill.uninstall')).toBe('skill');
    expect(auditAreaLabel('note.create')).toBe('other');
    expect(auditAreaLabel('tool.exec')).toBe('other');
  });
});

describe('prettyAuditDetails', () => {
  it('pretty-prints valid JSON and falls back to the raw string', () => {
    expect(prettyAuditDetails('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(prettyAuditDetails('not json')).toBe('not json');
  });
});

describe('audit exports', () => {
  it('JSON export round-trips the fetched rows', () => {
    const parsed = JSON.parse(auditJsonText(ROWS)) as AuditEntry[];
    expect(parsed).toEqual(ROWS);
  });

  it('Markdown export renders a table with every row and no raw secrets', () => {
    const text = auditMarkdownText(ROWS);
    expect(text).toContain('# Partner audit log');
    expect(text).toContain('| chat.stream |');
    expect(text).toContain('| deploy-profile.create |');
    expect(text).toContain('eu-prod');
    // Content-bearing rows never appear in exports by construction.
    expect(text).not.toContain('secret');
  });
});
