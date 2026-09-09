import { describe, expect, it } from 'vitest';
import { dataRowCount, parseCsv, sniffCsv } from '../src/csv.js';

describe('parseCsv', () => {
  it('parses simple comma rows', () => {
    expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles CRLF and lone CR line endings', () => {
    expect(parseCsv('a,b\r\n1,2\r')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps quoted fields with embedded separators and newlines', () => {
    const text = 'name,note\nAlice,"hi, there"\nBob,"line1\nline2"';
    expect(parseCsv(text)).toEqual([
      ['name', 'note'],
      ['Alice', 'hi, there'],
      ['Bob', 'line1\nline2'],
    ]);
  });

  it('un-escapes doubled quotes inside quoted fields', () => {
    expect(parseCsv('a,b\n1,"say ""hi"""')).toEqual([
      ['a', 'b'],
      ['1', 'say "hi"'],
    ]);
  });

  it('accepts tab and semicolon separators (TSV-tolerant)', () => {
    expect(parseCsv('a\tb\n1\t2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a;b\n1;2\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('keeps empty fields and a trailing blank line out of the result', () => {
    expect(parseCsv('a,,c\n,,\n\n')).toEqual([
      ['a', '', 'c'],
      ['', '', ''],
    ]);
  });

  it('returns [] for empty input and single-column rows for bare lines', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('just prose\nmore prose\n')).toEqual([['just prose'], ['more prose']]);
  });

  it('closes an unterminated quote at end of input', () => {
    expect(parseCsv('a,b\n1,"open')).toEqual([
      ['a', 'b'],
      ['1', 'open'],
    ]);
  });
});

describe('sniffCsv', () => {
  it('accepts a real table', () => {
    expect(sniffCsv('name,score\nada,9\nbob,7\n')).toBe(true);
  });

  it('accepts TSV', () => {
    expect(sniffCsv('name\tscore\nada\t9\n')).toBe(true);
  });

  it('accepts quoted commas', () => {
    expect(sniffCsv('name,note\nada,"big, long note"\n')).toBe(true);
  });

  it('rejects prose and one-column text', () => {
    expect(sniffCsv('Just some prose about the plan.\nAnother sentence here.')).toBe(false);
    expect(sniffCsv('one column\nsecond row\n')).toBe(false);
  });

  it('rejects ragged non-tables but tolerates a trailing partial row', () => {
    expect(sniffCsv('a,b,c\n1,2,3\n4,5\n')).toBe(true); // ragged tail tolerated
    expect(sniffCsv('a,b\n1\n2,3\n4,5\n')).toBe(false); // middle ragged -> not a table
  });

  it('rejects empty and single-row input', () => {
    expect(sniffCsv('')).toBe(false);
    expect(sniffCsv('a,b\n')).toBe(false);
  });
});

describe('dataRowCount', () => {
  it('counts rows after the header', () => {
    expect(dataRowCount(parseCsv('a,b\n1,2\n3,4\n'))).toBe(2);
    expect(dataRowCount(parseCsv('a,b\n'))).toBe(0);
  });
});
