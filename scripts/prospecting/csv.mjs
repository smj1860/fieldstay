/**
 * Minimal RFC4180 CSV read/write, shared by the crawl and merge scripts.
 *
 * Extracted because both files carried an identical copy of the parser, and
 * that one function was 2 points over the repo's cognitive-complexity ceiling
 * — so the duplication cost two CI errors for one defect. The quoted-field run
 * is now consumed by its own helper rather than by a fourth level of branching
 * inside the scanner loop.
 */

/** Reads a quoted field starting just after its opening quote. */
function readQuotedField(text, start) {
  let value = '';
  let i = start;
  while (i < text.length) {
    if (text[i] !== '"') { value += text[i]; i += 1; continue; }
    if (text[i + 1] === '"') { value += '"'; i += 2; continue; }   // escaped ""
    return { value, next: i + 1 };
  }
  return { value, next: i };   // unterminated quote — take what there is
}

/** Raw rows of raw cells. Handles quoted fields with embedded commas/newlines. */
function parseRows(text) {
  const rows = [];
  let row = [];
  let field = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      const q = readQuotedField(text, i + 1);
      field += q.value;
      i = q.next;
      continue;
    }
    i += 1;
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    if (c !== '\r') field += c;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

/** `{ header, rows }`, rows as objects keyed by the trimmed header cells. */
export function parseCSV(text) {
  const raw = parseRows(text);
  if (!raw.length) return { header: [], rows: [] };
  const header = raw.shift().map((h) => h.trim());
  return {
    header,
    rows: raw
      .filter((r) => r.some((v) => v && v.trim()))
      .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()]))),
  };
}

export const esc = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export const toCSV = (header, rows) =>
  [header.map(esc).join(','), ...rows.map((r) => header.map((h) => esc(r[h])).join(','))].join('\n');
