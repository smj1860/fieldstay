import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// ============================================================================
// Ratchet: an exported Server Action must have a caller.
//
// Three superseded implementations were found dead in one week, each of which
// had kept compiling — and passing its tests — long after nothing called it:
//
//   • app/(public)/wo/[token]/ + two actions in app/actions/work-order-public.ts
//     — a whole second vendor portal, keyed on work_orders.public_token, a
//     column nothing wrote and which had ZERO rows in production. It contained
//     a completion path that wrote `status: 'completed'` directly, skipping the
//     owner_transactions maintenance expense.
//   • reportTurnoverIssue (app/crew/turnovers/actions.ts) — a second crew
//     work-order path with no category, no asset, no client_report_id, and no
//     Dexie outbox, i.e. strictly worse than the live one.
//   • updateProperty (app/(dashboard)/properties/actions.ts) — not a stale copy
//     but a DIVERGENT one: it called store_property_door_code unconditionally,
//     whose NULL branch DELETES the Vault secret, while the live saveDetails
//     guards that behind a `door_code_unchanged` field. Wiring a form to it
//     would have destroyed a door code on a rename.
//
// The common shape is not "unused code is untidy". It is that a dead action
// keeps the API surface of a live one while silently missing the safety its
// replacement had to learn — so whoever revives it inherits the old bug.
//
// TESTS DO NOT COUNT AS A CALLER. This is the entire point and it is not an
// oversight: every one of the three above had a full unit-test suite. Counting
// tests would have made this guardrail green on all three. The reference
// search therefore covers app/, lib/ and components/ only.
// ============================================================================

const SOURCE_DIRS = ['app', 'lib', 'components']

/** `export async function foo(` in a file that declares 'use server'. */
const SERVER_ACTION = /^export\s+async\s+function\s+([A-Za-z0-9_$]+)/gm

/**
 * Exported Server Actions with no reference anywhere outside their own file.
 *
 * Shrink-only, exactly like tailwind-color-ratchet: delete an entry when the
 * action gains a caller or is removed. NEVER add one — a newly-dead action is
 * the case this exists to catch, and adding it here defeats that.
 *
 * Every entry below was verified 2026-08-05 to be referenced ONLY by its own
 * unit tests. They are recorded rather than deleted because "no caller yet" and
 * "no caller ever" look identical from here: several are plausibly staged for
 * UI that has not shipped. That is a product call, not a lint fix.
 */
const BASELINE = new Set([
  'app/crew/turnovers/actions.ts::submitAssetDiscovery',
  'app/(dashboard)/settings/privacy/actions.ts::anonymizeGuestData',
  'app/(dashboard)/inventory/actions.ts::updatePurchaseOrderStatus',
  'app/(dashboard)/maintenance/actions.ts::assignCrewToWorkOrder',
  'app/(dashboard)/maintenance/actions.ts::updateWorkOrder',
  'app/(dashboard)/maintenance/actions.ts::addWorkOrderNote',
  'app/(dashboard)/maintenance/actions.ts::recordWorkOrderPhoto',
  'app/(dashboard)/maintenance/actions.ts::deleteWorkOrderPhoto',
  'app/(dashboard)/maintenance/actions.ts::approveQuoteRequest',
  'app/(dashboard)/maintenance/actions.ts::declineQuoteRequest',
  'app/(dashboard)/maintenance/actions.ts::recordMaintenanceCompletion',
  'app/(dashboard)/maintenance/work-order-actions.ts::reorderWorkOrderLineItems',
  'app/(dashboard)/maintenance/work-order-actions.ts::updatePropertyAccessInstructions',
  'app/(dashboard)/properties/[id]/setup/maintenance/actions.ts::addMaintenanceSchedule',
  'app/(dashboard)/properties/[id]/setup/maintenance/actions.ts::cloneMaintenanceFromProperty',
])

interface Action { key: string; file: string; name: string }

function findServerActions(sources: { path: string; src: string }[]): Action[] {
  const actions: Action[] = []
  for (const { path, src } of sources) {
    // The directive may sit under a leading comment block, so don't anchor to
    // the first byte — but it must be its own statement, not a mention in prose.
    if (!/^['"]use server['"]$/m.test(src)) continue
    SERVER_ACTION.lastIndex = 0
    for (const m of src.matchAll(SERVER_ACTION)) {
      actions.push({ key: `${path}::${m[1]}`, file: path, name: m[1]! })
    }
  }
  return actions
}

function findUnreferenced(sources: { path: string; src: string }[]): string[] {
  const actions = findServerActions(sources)
  const unreferenced: string[] = []

  for (const action of actions) {
    const referenced = sources.some(
      ({ path, src }) =>
        path !== action.file && new RegExp(`\\b${action.name}\\b`).test(src),
    )
    if (!referenced) unreferenced.push(action.key)
  }
  return unreferenced
}

function loadSources() {
  return collectSourceFiles(SOURCE_DIRS).map((f) => ({ path: rel(f), src: read(f) }))
}

describe('guardrail: every exported Server Action has a caller', () => {
  it('no NEW Server Action is exported without a reference outside its own file', () => {
    const unreferenced = findUnreferenced(loadSources())
    const fresh = unreferenced.filter((k) => !BASELINE.has(k))

    expect(
      fresh.length === 0
        ? []
        : [
            'These exported Server Actions have no reference anywhere in app/, lib/',
            'or components/ — only (at most) their own unit tests. A Server Action',
            'with no caller is not merely unused: three of them were found this week',
            'still carrying the bug their live replacement had already fixed, and a',
            'full test suite made all three look healthy.',
            '',
            'Either wire it up, or delete it along with its tests. Do NOT add it to',
            'BASELINE — that set is shrink-only and exists solely to record what was',
            'already dead when this guardrail was written.',
            '',
            ...fresh,
          ].join('\n'),
    ).toEqual([])
  })

  it('baseline entries that gained a caller (or were deleted) are pruned', () => {
    const unreferenced = new Set(findUnreferenced(loadSources()))
    const stale = [...BASELINE].filter((k) => !unreferenced.has(k))

    expect(
      stale.length === 0
        ? []
        : [
            'These BASELINE entries are no longer unreferenced — they either gained',
            'a caller or were removed. Delete them from BASELINE so the progress is',
            'locked in and the set keeps shrinking.',
            '',
            ...stale,
          ].join('\n'),
    ).toEqual([])
  })

  // A rule at zero because it is broken is indistinguishable from a rule at
  // zero because the tree is clean. These pin both directions against fixtures,
  // so a refactor upstream cannot quietly turn this into a no-op.
  it('detects a dead action, and does not flag one that has a caller', () => {
    const sources = [
      { path: 'app/x/actions.ts', src: "'use server'\nexport async function deadOne() {}\nexport async function liveOne() {}" },
      { path: 'app/x/page.tsx',   src: "import { liveOne } from './actions'" },
    ]

    expect(findUnreferenced(sources)).toEqual(['app/x/actions.ts::deadOne'])
  })

  it('does NOT count a unit test as a caller — the defect that made this necessary', () => {
    // unit/ is outside SOURCE_DIRS, so a test file is never in `sources` at
    // all. Modelled explicitly because it is the single assumption the whole
    // guardrail rests on: reportTurnoverIssue had six passing tests and zero
    // callers, and counting them would have reported it healthy.
    const sources = [
      { path: 'app/x/actions.ts', src: "'use server'\nexport async function testedButDead() {}" },
    ]

    expect(findUnreferenced(sources)).toEqual(['app/x/actions.ts::testedButDead'])
  })

  it('ignores a file that only mentions "use server" in prose', () => {
    const sources = [
      { path: 'lib/x.ts', src: "// files marked 'use server' export actions\nexport async function notAnAction() {}" },
    ]

    expect(findUnreferenced(sources)).toEqual([])
  })
})
