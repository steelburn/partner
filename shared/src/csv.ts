/**
 * M16 F6 (PLAN-M16.md): pure CSV parsing + sniffing shared between the core
 * and the web UI (zero runtime deps — same convention as vision.ts).
 *
 * parseCsv implements the RFC-4180 shape the product needs: quoted fields
 * with embedded separators, escaped quotes ("") and CRLF/CR/LF tolerance.
 * The parser is lenient about ragged input: unterminated quotes close at the
 * end of input and a trailing blank line produces no empty row.
 */

/** Parse CSV/TSV text into rows of fields (no header interpretation). */
export function parseCsv(text: string): string[][] {
  if (text === '') return [];
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  function endField(): void {
    row.push(field);
    field = '';
  }

  function endRow(): void {
    endField();
    rows.push(row);
    row = [];
  }

  while (i < len) {
    const char = text[i] as string;
    if (inQuotes) {
      if (char === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += char;
      i += 1;
      continue;
    }
    if (char === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (char === ',' || char === ';' || char === '\t') {
      endField();
      i += 1;
      continue;
    }
    if (char === '\r') {
      // CRLF or lone CR both end the row. A blank line produces no row.
      if (row.length === 0 && field === '') {
        i += text[i + 1] === '\n' ? 2 : 1;
        continue;
      }
      endRow();
      i += text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    if (char === '\n') {
      if (row.length === 0 && field === '') {
        i += 1;
        continue;
      }
      endRow();
      i += 1;
      continue;
    }
    field += char;
    i += 1;
  }
  // Trailing content without a closing newline (a text ending in '\n' has
  // already pushed its final row with an empty field).
  if (field !== '' || row.length > 0) {
    endRow();
  }
  return rows;
}

/**
 * Does this text look like a CSV/TSV table? Heuristic used by the asset
 * renderer: at least two rows, at least two columns on the first row, and a
 * consistent column count across the first few rows (quoted commas are
 * tolerated because we parse then measure). Returns false for prose.
 */
export function sniffCsv(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed === '') return false;
  const rows = parseCsv(trimmed);
  if (rows.length < 2) return false;
  const width = rows[0]?.length ?? 0;
  if (width < 2) return false;
  // First rows must agree on width; only the FINAL row may be ragged (a
  // trailing partial row). A wide mismatch in any other row = not a table.
  const probe = Math.min(rows.length, 5);
  const strictLast = rows.length - 1;
  for (let r = 1; r < probe && r < strictLast; r += 1) {
    const rowWidth = rows[r]?.length ?? 0;
    if (rowWidth === 0) continue;
    if (rowWidth !== width) return false;
  }
  // A real table rarely has multi-sentence prose in its first cell.
  const first = rows[0]?.[0] ?? '';
  if (first.length > 200) return false;
  return true;
}

/** Number of data rows after the (optional) header row. */
export function dataRowCount(rows: string[][]): number {
  return rows.length > 1 ? rows.length - 1 : 0;
}
