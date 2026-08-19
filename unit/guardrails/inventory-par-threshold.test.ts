import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// ============================================================================
// ONE DEFINITION OF WHAT "BELOW PAR" MEANS.
//
// The bug this encodes, found 2026-08-19 when a PM reported the inventory page
// "not updating": it was perfectly current. Six places compared
// current_quantity against par_level, and they had settled on two different
// answers to the same question:
//
//   inventory-manager.tsx   qty <= par → critical, qty <= par*1.2 → low
//   portfolio-view.tsx ×2   qty <= par → critical, qty <= par*1.2 → low
//   crew InventoryView.tsx  qty <  par → low
//   notifications.ts        qty <  par
//   account-tools.ts        qty <  par
//   inventory_below_par_for_org (RPC)  qty < par
//
// So the Ops Snapshot said 43 items below par while the inventory page showed
// 113 in red, on the same rows at the same moment. Neither was wrong; they
// were answering differently-defined questions. The 69 items sitting EXACTLY
// at par were the whole gap, and no amount of refreshing either page could
// reconcile them.
//
// The same `<=` also reached the purchase list: generateAggregatedPurchaseList
// skipped only `qty > par`, so at-par items passed the filter and were ordered
// in quantity par - qty = ZERO.
//
// lib/inventory/stock-status.ts is now the single definition. This guardrail
// keeps it that way.
//
// ── Why the allowlist is what it is ────────────────────────────────────────
//
// Not every par comparison is a display decision. The RPC and the two
// server-side "what is below par" reads answer the RESTOCK question, which is
// strictly-below-par and agrees with `needsRestock` by construction. They are
// listed because they are in SQL or in a shape the shared helper's structural
// type does not fit, not because they are exempt from the rule.
// ============================================================================

/**
 * Files allowed to compare a quantity against a par level directly.
 *
 * Shrink-only. A NEW entry here means a seventh copy of the rule, which is
 * exactly what this file exists to stop — use stockStatus()/needsRestock().
 */
const ALLOWED = new Set([
  // The definition itself.
  'lib/inventory/stock-status.ts',
])

/**
 * qty-vs-par comparisons, in the spellings that actually appear.
 *
 * Deliberately matches the COMPARISON, not the mere mention of par_level:
 * reading, writing, sorting by or rendering par_level is fine and common. It
 * is deciding something from it that has to go through one place.
 */
const PAR_COMPARISON = [
  // current_quantity <op> ... par_level  (either order, any comparison op)
  /current_quantity\s*(?:<=|>=|<|>)\s*[^;\n]*par_level/,
  /par_level\s*(?:<=|>=|<|>)\s*[^;\n]*current_quantity/,
  // The Dexie/crew shape, where the counted value is a local `qty`.
  /\bqty\s*(?:<=|>=|<|>)\s*[^;\n]*par_level/,
  /par_level\s*(?:<=|>=|<|>)\s*[^;\n]*\bqty\b/,
]

/**
 * Whole-line comments are blanked before scanning.
 *
 * The files that were FIXED now document the broken comparison they replaced,
 * and a naive scan reads that prose as a live call site — the same trap that
 * made two earlier guardrails in this directory fail on the very change that
 * fixed them. Conservative on purpose: a trailing `//` is NOT stripped,
 * because a line containing 'https://' would be truncated and a real finding
 * lost.
 */
function stripCommentLines(src: string): string {
  let inBlock = false
  return src.split('\n').map((line) => {
    const t = line.trim()
    if (inBlock) {
      if (t.includes('*/')) inBlock = false
      return ''
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inBlock = true
      return ''
    }
    return (t.startsWith('//') || t.startsWith('*')) ? '' : line
  }).join('\n')
}

const hasParComparison = (src: string) => PAR_COMPARISON.some((p) => p.test(src))

describe('guardrail: one definition of below-par', () => {
  it('no file outside lib/inventory/stock-status.ts compares quantity to par', () => {
    const offenders = collectSourceFiles(['app', 'lib', 'components'])
      .filter((f) => !ALLOWED.has(rel(f)))
      .filter((f) => hasParComparison(stripCommentLines(read(f))))
      .map(rel)
      .sort()

    expect(offenders, [
      'A file compares current_quantity against par_level directly.',
      '',
      'That comparison is the whole bug: six copies had drifted into two',
      'different answers, so the Ops Snapshot counted 43 items below par while',
      'the inventory page showed 113 in red, on the same data. The 69 items',
      'sitting exactly AT par were the entire difference.',
      '',
      'Use lib/inventory/stock-status.ts:',
      "  stockStatus(item)   → 'red' | 'yellow' | 'green' | 'uncounted'",
      '  needsRestock(item)  → strictly below par (never at par: the shortfall',
      '                        would be zero, which put zero-quantity lines on',
      '                        the purchase list)',
      '  restockQuantity(item)',
    ].join('\n')).toEqual([])
  })

  it('SELF-CHECK: the scan fires on each spelling, and not on innocent par use', () => {
    // A guardrail at zero because it is BLIND looks exactly like one at zero
    // because the tree is clean. Two guardrails in this directory have already
    // been in the first state, so the fixtures are not optional.
    expect(hasParComparison('if (item.current_quantity <= item.par_level) return')).toBe(true)
    expect(hasParComparison('if (i.current_quantity < i.par_level) x()')).toBe(true)
    expect(hasParComparison('const low = qty < item.par_level')).toBe(true)
    expect(hasParComparison('if (item.par_level > item.current_quantity) y()')).toBe(true)
    expect(hasParComparison('i.current_quantity <= i.par_level * 1.2')).toBe(true)

    // CONTROLS — reading, writing, rendering or sorting by par is fine, and a
    // guardrail that flags those becomes a reason to work around itself.
    expect(hasParComparison(".select('current_quantity, par_level')")).toBe(false)
    expect(hasParComparison('const needed = item.par_level - item.current_quantity')).toBe(false)
    expect(hasParComparison('<span>{item.current_quantity} / {item.par_level}</span>')).toBe(false)
    expect(hasParComparison('par_level: normalizeParLevel(input.default_par_level)')).toBe(false)
    expect(hasParComparison('if (item.par_level > 0) render()')).toBe(false)
    expect(hasParComparison('stockStatus(item) === \'red\'')).toBe(false)
  })
})
