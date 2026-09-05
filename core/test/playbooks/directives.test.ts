/**
 * Directive parser tests (PLAN-M9.md "Persona tool directive protocol").
 *
 * The exact line form is `[[partner:tool <toolId> <json>]]` — ONE line, JSON
 * allowed to be {}. Malformed lines are skipped silently (never throw);
 * prose mentioning the marker mid-sentence is NOT a directive; the loop
 * engine consumes the LAST directive of a reply (lastDirective).
 */
import { describe, expect, it } from 'vitest';
import { lastDirective, parseReplyTools } from '../../src/playbooks/directives.js';

describe('parseReplyTools', () => {
  it('extracts the exact single-line form with a json object', () => {
    const text =
      'Let me check the file.\n' +
      '[[partner:tool files.read {"projectId":"r1","path":"notes/one.md"}]]\n' +
      'Back in a second.';
    const directives = parseReplyTools(text);
    expect(directives).toEqual([
      { toolId: 'files.read', args: { projectId: 'r1', path: 'notes/one.md' } },
    ]);
  });

  it('accepts an empty {} argument and tolerates surrounding whitespace', () => {
    const directives = parseReplyTools(
      '   [[partner:tool   files.list   {}   ]]   ',
    );
    expect(directives).toEqual([{ toolId: 'files.list', args: {} }]);
  });

  it('parses JSON with nested braces on one line', () => {
    const text = `[[partner:tool files.edit {"projectId":"r1","path":"a.ts","proposedContent":"{ outer: { inner: true } }"}]]`;
    const directives = parseReplyTools(text);
    expect(directives).toHaveLength(1);
    expect(directives[0]?.toolId).toBe('files.edit');
    expect(directives[0]?.args).toMatchObject({ path: 'a.ts' });
    expect(directives[0]?.args.proposedContent).toContain('inner: true');
  });

  it('ignores malformed lines silently (never crashes)', () => {
    const text = [
      'no marker here',
      '[[partner:tool', // truncated
      '[[partner:tool files.read]]', // missing json
      '[[partner:tool files.read {"projectId":}]', // broken json
      '[[partner:tool files.read ["array","not","object"]]]', // non-object json
      '[[partner:tool files.read {"projectId":"r1","path":"ok.md"}]] trailing text', // not own-line
      'text [[partner:tool files.read {"projectId":"r1"}]] inline', // mid-sentence
    ].join('\n');
    expect(parseReplyTools(text)).toEqual([]);
  });

  it('extracts every directive across lines, in order', () => {
    const text = [
      '[[partner:tool files.list {"projectId":"r1","path":"."}]]',
      'some prose',
      '[[partner:tool files.read {"projectId":"r1","path":"a.md"}]]',
    ].join('\n');
    const directives = parseReplyTools(text);
    expect(directives.map((d) => d.toolId)).toEqual(['files.list', 'files.read']);
  });

  it('lastDirective returns the LAST one (chainable across rounds)', () => {
    const text = [
      '[[partner:tool files.read {"projectId":"r1","path":"one.md"}]]',
      '[[partner:tool files.read {"projectId":"r1","path":"two.md"}]]',
    ].join('\n');
    expect(lastDirective(text)).toEqual({
      toolId: 'files.read',
      args: { projectId: 'r1', path: 'two.md' },
    });
  });

  it('lastDirective is null for prose or empty input', () => {
    expect(lastDirective('just a normal reply')).toBeNull();
    expect(lastDirective('')).toBeNull();
    expect(lastDirective('   \n  ')).toBeNull();
  });
});
