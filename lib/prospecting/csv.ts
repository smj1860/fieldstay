/**
 * CSV reading and writing for the prospecting funnel.
 *
 * A LEAF module — pure string work, no imports. The admin import wizard runs
 * it in the browser and scripts/import-prospects.ts runs it in node, so it
 * must not reach for `node:fs` or anything `server-only`.
 *
 * A real parser, not a split on commas: pms_note holds commas, quotes and
 * newlines, and the master CSV has quoted multi-line Notes cells. Splitting
 * on commas shifts every column after the first quoted one, which does not
 * fail — it writes a phone number into the email column.
 */

interface ScanState {
  rows:   string[][]
  row:    string[]
  cell:   string
  quoted: boolean
}

/** Inside quotes: only a doubled quote or a closing quote is special. */
function stepQuoted(st: ScanState, text: string, i: number): number {
  const ch = text[i]
  if (ch === '"' && text[i + 1] === '"') { st.cell += '"'; return i + 2 }
  if (ch === '"') { st.quoted = false; return i + 1 }
  st.cell += ch
  return i + 1
}

/** Outside quotes: a quote opens, a comma ends a cell, a newline ends a row. */
function stepBare(st: ScanState, text: string, i: number): number {
  const ch = text[i]
  if (ch === '"')  { st.quoted = true; return i + 1 }
  if (ch === ',')  { st.row.push(st.cell); st.cell = ''; return i + 1 }
  if (ch === '\r') { return i + 1 }
  if (ch === '\n') {
    st.row.push(st.cell)
    st.rows.push(st.row)
    st.row = []
    st.cell = ''
    return i + 1
  }
  st.cell += ch
  return i + 1
}

export function parseCsv(text: string): string[][] {
  // A UTF-8 BOM is invisible and would otherwise become part of the first
  // header name, so "Company" stops matching its alias and the whole file
  // reads as having no company column.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text

  const st: ScanState = { rows: [], row: [], cell: '', quoted: false }
  let i = 0
  while (i < body.length) {
    i = st.quoted ? stepQuoted(st, body, i) : stepBare(st, body, i)
  }
  if (st.cell !== '' || st.row.length > 0) { st.row.push(st.cell); st.rows.push(st.row) }
  return st.rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/**
 * One CSV cell, quoted when it needs to be and defused when it could be read
 * as a formula.
 *
 * A leading =, +, - or @ makes Excel and Sheets evaluate the cell on open, so
 * a company literally named "=SUM(1)" — or a notes field someone pasted —
 * becomes a formula in the operator's spreadsheet. Prefixing an apostrophe is
 * the standard defusing: the sheet shows the original text and never runs it.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  const s = value === null || value === undefined ? '' : String(value)
  const defused = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s
  return /[",\n\r]/.test(defused) ? `"${defused.replaceAll('"', '""')}"` : defused
}

/** A whole CSV document, with a UTF-8 BOM so Excel opens it as UTF-8. */
export function toCsv(
  header: readonly string[],
  rows: readonly (readonly (string | number | boolean | null | undefined)[])[],
): string {
  const lines = [header.map(csvCell).join(',')]
  for (const row of rows) lines.push(row.map(csvCell).join(','))
  return `﻿${lines.join('\n')}`
}
