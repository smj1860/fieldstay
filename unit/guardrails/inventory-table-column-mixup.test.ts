import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// ============================================================================
// Inventory table/column mixup guardrail: CLAUDE.md calls out two inventory
// count tables with DIFFERENT column names for the same concepts, warning
// "do not mix them":
//   - inventory_count_draft_items (current path): item_id, counted_qty,
//     note, notes, previous_quantity
//   - inventory_count_items (legacy direct-commit): inventory_item_id,
//     quantity_counted
// This is the exact same shape of drift as the already-ESLint-banned
// 'memberships'/assigned_crew_id table/column mistakes — a name that's
// syntactically valid TypeScript but wrong for the table in scope — except
// here the wrong-table columns ARE valid identifiers (just on the OTHER
// table), so a flat literal ban would misfire; the check has to be scoped
// to the same .from(...) call's own query chain, not the whole file.
//
// Scope: a `.from('TABLE')` call followed (within a bounded window — the
// query chain, not the whole file) by the OTHER table's distinctively-named
// columns counts as a mixup. `item_id` alone is deliberately excluded from
// the inventory_count_items-with-draft-columns direction — it's too short
// and generic a name to trust within a proximity window without real
// paren-scoped parsing; counted_qty/previous_quantity/draft_id are unique
// enough on their own to catch the real mistake without that risk.
// ============================================================================

const FROM_TABLE = /\.from\(\s*['"](inventory_count_draft_items|inventory_count_items)['"]\s*\)/g
const WINDOW_CHARS = 200

const WRONG_COLUMNS_FOR: Record<string, RegExp> = {
  // inventory_count_draft_items mistakenly queried with inventory_count_items' columns
  inventory_count_draft_items: /\binventory_item_id\b|\bquantity_counted\b/,
  // inventory_count_items mistakenly queried with inventory_count_draft_items' columns
  inventory_count_items: /\bcounted_qty\b|\bprevious_quantity\b|\bdraft_id\b/,
}

function findOffenders(): string[] {
  const offenders: string[] = []
  for (const file of collectSourceFiles(['app', 'lib'])) {
    const src = read(file)
    FROM_TABLE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = FROM_TABLE.exec(src))) {
      const table = m[1]!
      const window = src.slice(m.index, m.index + WINDOW_CHARS)
      if (WRONG_COLUMNS_FOR[table]!.test(window)) {
        const line = src.slice(0, m.index).split('\n').length
        offenders.push(`${rel(file)}:${line}`)
      }
    }
  }
  return offenders
}

// Verified against the codebase 2026-07-26. No violations currently exist —
// this guardrail is a ratchet keeping the baseline clean, same model as
// tailwind-color-ratchet.
const EXCEPTIONS: Record<string, string> = {}

describe('guardrail: no inventory_count_draft_items/inventory_count_items column mixups', () => {
  const offenders = findOffenders()

  it('detects a synthetic mixup (sanity: the scan is not silently inert)', () => {
    const synthetic = ".from('inventory_count_draft_items').select('inventory_item_id, quantity_counted')"
    FROM_TABLE.lastIndex = 0
    const match = FROM_TABLE.exec(synthetic)
    expect(match).not.toBeNull()
    expect(WRONG_COLUMNS_FOR[match![1]!]!.test(synthetic.slice(match!.index, match!.index + WINDOW_CHARS))).toBe(true)
  })

  it('every match is either fixed or a named, justified exception', () => {
    const unlisted = offenders.filter((o) => !EXCEPTIONS[o])

    expect(
      unlisted,
      [
        'A query against inventory_count_draft_items or inventory_count_items',
        'references the OTHER table\'s column names (CLAUDE.md: "Two inventory',
        'tables with different column names — do not mix them"). Fix the',
        'column names for the table actually in scope, or — if this is a false',
        'positive (e.g. unrelated code coincidentally nearby) — add it to',
        'EXCEPTIONS in this test with a reason. Offenders:',
        ...unlisted,
      ].join('\n')
    ).toEqual([])
  })

  it('every EXCEPTIONS entry still exists at that file:line (prune when code moves)', () => {
    const present = new Set(offenders)
    for (const key of Object.keys(EXCEPTIONS)) {
      expect(
        present.has(key),
        `EXCEPTIONS lists ${key}, which no longer matches the mixup pattern — remove the stale entry (the code likely moved or was fixed).`
      ).toBe(true)
    }
  })
})
