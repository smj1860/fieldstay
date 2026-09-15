import { describe, it, expect } from 'vitest'

import { MAX_REPEAT_INSTANCES } from '@/lib/inspections/resolve-form'
import { MAX_ITEMS } from '@/lib/inspections/submit-payload'
import { INSPECTION_FORMS, type ItemDefinition } from '@/lib/inspections/forms'

// ============================================================================
// MAX_ITEMS (submit-payload.ts) and MAX_REPEAT_INSTANCES (resolve-form.ts)
// were chosen independently and drifted apart: at MAX_REPEAT_INSTANCES=999,
// the Safety form's 5-member extinguisher repeat group alone produced
// 999 * 5 = 4,995 rows — before counting the rest of that form's own ~60
// items — which exceeded MAX_ITEMS=5,000. The client-side resolver invited
// the inspector to fill out up to 999 instances (and gated every one of them
// as required before Review would let them sign off); the server then
// unconditionally destroyed the result with "That inspection has too many
// answers." submit-payload.ts's own header says a rejection here is TERMINAL
// for the outbox — it dead-letters a completed walk whose answers exist
// nowhere else.
//
// This asserts the actual worst-case item count a real form definition can
// produce at the current MAX_REPEAT_INSTANCES stays under MAX_ITEMS, computed
// from the live form trees rather than a hand-typed number — so the two
// constants can never silently drift apart again.
// ============================================================================

/** Every item a form can submit in the worst case: repeat groups multiplied by the cap. */
function worstCaseItemCount(items: ItemDefinition[], maxRepeatInstances: number): number {
  let count = 0
  for (const item of items) {
    count += 1
    if (item.children) count += worstCaseItemCount(item.children, maxRepeatInstances)
    if (item.repeats)  count += maxRepeatInstances * worstCaseItemCount(item.repeats, maxRepeatInstances)
  }
  return count
}

describe('guardrail: inspection item caps stay jointly consistent', () => {
  it('no form\'s worst-case submission exceeds MAX_ITEMS at the current MAX_REPEAT_INSTANCES', () => {
    for (const form of INSPECTION_FORMS) {
      const rootItems = form.sections.flatMap((s) => s.items)
      const worstCase = worstCaseItemCount(rootItems, MAX_REPEAT_INSTANCES)

      expect(
        worstCase,
        `${form.key} form's worst-case submission (${worstCase} items at ` +
          `MAX_REPEAT_INSTANCES=${MAX_REPEAT_INSTANCES}) exceeds MAX_ITEMS ` +
          `(${MAX_ITEMS}) — a legitimately-filled walk would be dead-lettered ` +
          `by parseSubmitPayload. Lower MAX_REPEAT_INSTANCES or raise MAX_ITEMS.`,
      ).toBeLessThanOrEqual(MAX_ITEMS)
    }
  })

  it('the check actually fires — a broken checker and a clean tree both return zero', () => {
    // A single fake form with the real repeat-group shape, sized to just
    // barely exceed a tiny fake ceiling — confirms worstCaseItemCount is
    // really multiplying repeats, not just counting the template once.
    const fakeRoot: ItemDefinition[] = [
      {
        key: 'fake.count', prompt: 'count', remediation: 'none', default_actions: [],
        repeats: [
          { key: 'fake.member', prompt: 'member', remediation: 'none', default_actions: [] },
        ],
      },
    ]
    // 1 (the count item) + 10 * 1 (repeat member) = 11
    expect(worstCaseItemCount(fakeRoot, 10)).toBe(11)
    expect(worstCaseItemCount(fakeRoot, 10)).toBeGreaterThan(5)
  })
})
