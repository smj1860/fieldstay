import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// ============================================================================
// Never name a GENERATED ALWAYS column in a write payload.
//
// Postgres rejects it outright — 428C9 "cannot insert a non-DEFAULT value into
// column" — so the whole statement fails, not just that column.
//
// This shipped and survived. work_order_line_items.line_total is
// GENERATED ALWAYS AS (quantity * unit_cost) STORED on BOTH projects, and
// insertVendorLineItems() named it in its insert payload while only
// console.error-ing on failure. Result: every vendor completion persisted the
// invoice and flipped the work order to `completed`, and silently stored ZERO
// line items. The itemisation the vendor typed in was discarded on every
// submission, with nothing surfaced to anyone. The knock-on was worse than it
// looks: `sync_wo_cost_on_line_items` derives work_orders.actual_cost from
// those rows, so that trigger never fired either.
//
// Three things had to be true at once for it to hide, and all three are normal:
//   - supabase/schema_reference.sql describes the column as a plain DEFAULT,
//     not GENERATED, so reading the snapshot made the insert look right;
//   - the error was logged and swallowed rather than returned;
//   - the e2e spec asserted on invoice rows, not line-item rows.
//
// Hence a source-level check rather than trusting review. GENERATED columns are
// rare and change rarely, so the list is maintained by hand and verified
// against the live database (information_schema.columns.is_generated = 'ALWAYS').
// ============================================================================

/**
 * table -> generated column names, verified against BOTH the production and
 * E2E projects on 2026-08-01. Add an entry whenever a migration introduces a
 * GENERATED column; nothing may write to one.
 */
const GENERATED_COLUMNS: Record<string, string[]> = {
  work_order_line_items:  ['line_total'],
  assignment_outcomes:    ['duration_minutes'],
  checklist_item_signals: ['flag_probability', 'dynamic_photo_required'],
}

/** Write verbs whose payload object is the thing Postgres will reject. */
const WRITE_CALL = /\.(insert|upsert|update)\s*\(/g

/**
 * Find the balanced argument text of a call starting at `openParenIdx`, so the
 * scan looks at the payload only rather than the rest of the file.
 */
function argsOf(src: string, openParenIdx: number): string {
  let depth = 0
  let inString: string | null = null
  for (let i = openParenIdx; i < src.length; i++) {
    const ch = src[i]!
    if (inString) {
      if (ch === inString && src[i - 1] !== '\\') inString = null
      continue
    }
    if (ch === "'" || ch === '"' || ch === '`') { inString = ch; continue }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return src.slice(openParenIdx + 1, i)
    }
  }
  return ''
}

function findOffenders(): string[] {
  const offenders: string[] = []

  for (const file of collectSourceFiles(['app', 'lib', 'components'])) {
    const src = read(file)
    if (!/\.(insert|upsert|update)\s*\(/.test(src)) continue

    for (const [table, columns] of Object.entries(GENERATED_COLUMNS)) {
      // Only inspect files that actually touch this table.
      const fromIdx = src.indexOf(`.from('${table}')`)
      if (fromIdx === -1) continue

      WRITE_CALL.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = WRITE_CALL.exec(src))) {
        const openParen = m.index + m[0].length - 1
        const args = argsOf(src, openParen)
        for (const col of columns) {
          // `col:` as an object key in the payload.
          if (new RegExp(`(^|[{,\\s])${col}\\s*:`).test(args)) {
            const line = src.slice(0, m.index).split('\n').length
            offenders.push(`${rel(file)}:${line} writes ${table}.${col} (GENERATED ALWAYS)`)
          }
        }
      }
    }
  }
  return offenders
}

describe('guardrail: no writes to GENERATED ALWAYS columns', () => {
  it('finds no write payload naming a generated column', () => {
    expect(
      findOffenders(),
      'A GENERATED ALWAYS column cannot be written — Postgres rejects the whole\n' +
      'statement with 428C9. Remove the field from the payload and let the\n' +
      'database compute it. See work_order_line_items.line_total, which silently\n' +
      'discarded every vendor line item until 2026-08-01.',
    ).toEqual([])
  })

  it('the scan is wired up (it can actually see write payloads)', () => {
    // Guards against the check silently passing because the regex or the file
    // walk stopped matching anything at all.
    const files = collectSourceFiles(['app', 'lib'])
      .filter((f) => /\.(insert|upsert|update)\s*\(/.test(read(f)))
    expect(files.length).toBeGreaterThan(20)
  })
})
