import { describe, it, expect } from 'vitest'
import { PUBLIC_FAQ, FAQ_FLAT } from '@/lib/faq-content'

// ============================================================================
// THE PUBLIC FAQ IS WRITTEN FOR A STRANGER, NOT FOR A SIGNED-IN CUSTOMER.
//
// lib/faq-content.ts has one pool of answers and two readers. The in-app help
// page's reader is signed in, so "Settings → Billing → Manage Subscription" is
// the most useful possible answer there. /faq's reader has no account, so the
// same sentence is advice they cannot follow, in the one place we are asking
// them to trust us.
//
// PUBLIC_FAQ selects by id out of that shared pool, which is what keeps a
// correction from needing to land twice. The cost of selecting rather than
// copying is that the SOURCE answer can be edited later by someone with only
// the in-app reader in mind, and nothing about that edit looks wrong: it
// improves the help page and silently puts a dead instruction on a marketing
// page. That is the drift this checks for, and it is why the check is on the
// RESOLVED text rather than on the id list.
//
// Deliberately NOT asserting a fixed question count or an exact id list: the
// owner can add or drop a question without consulting a test. What is asserted
// is the property that makes an entry publishable at all.
// ============================================================================

/**
 * In-app navigation. Each of these is a real string in the current pool, and
 * each would be unreachable advice for someone without an account.
 *
 * The arrow is matched on its own because it is this codebase's house style
 * for a navigation path ("Settings → Integrations", "Guidebook → [Property
 * Name]"), so it catches a path this list never anticipated.
 */
const IN_APP_NAVIGATION = [
  '→',
  'Go to Settings',
  'Go to Crew',
  'Go to Assets',
  'in Settings',
  'See Settings',
  'Review it at',
] as const

/**
 * A question stem that only makes sense about an account you already have.
 * "My properties didn't appear after connecting" is a support ticket; it is
 * not a thing a prospect can be asking.
 */
const ACCOUNT_SPECIFIC_STEMS = [
  'my properties',
  'my par levels',
  'my account',
  "hasn't updated",
  'why did only one',
  "didn't change this month",
  "didn't sync",
] as const

describe('guardrail: PUBLIC_FAQ is generic', () => {
  it('resolves every id — a rename throws rather than silently dropping a question', () => {
    // pickPublic() throws at module load, so importing PUBLIC_FAQ at all is
    // the assertion. This states the intent so a future reader does not
    // "simplify" that throw into a .filter(Boolean).
    expect(PUBLIC_FAQ.length).toBeGreaterThanOrEqual(8)
    expect(PUBLIC_FAQ.every((f) => f.question.length > 0 && f.answer.length > 0)).toBe(true)
  })

  it('no entry sends a reader to a screen they cannot reach', () => {
    const offenders = PUBLIC_FAQ.flatMap((f) =>
      IN_APP_NAVIGATION
        .filter((nav) => f.answer.includes(nav))
        .map((nav) => `${f.id}: answer contains in-app navigation "${nav}"`),
    )

    expect(offenders, [
      'A /faq answer tells an anonymous visitor to go somewhere inside the app.',
      '',
      'This usually means the SHARED answer in FAQ_CATEGORIES was edited for the',
      'in-app help page. Two ways out, and the first is better:',
      '',
      '  1. Reword the shared answer so it works for both readers.',
      '  2. Add a public phrasing to PUBLIC_FAQ_OVERRIDES in lib/faq-content.ts,',
      '     which keeps the rest of that answer shared.',
      '',
      'Dropping the question is the last resort, not the first.',
    ].join('\n')).toEqual([])
  })

  it('no entry asks a question only an existing customer could ask', () => {
    const offenders = PUBLIC_FAQ.flatMap((f) =>
      ACCOUNT_SPECIFIC_STEMS
        .filter((stem) => f.question.toLowerCase().includes(stem))
        .map((stem) => `${f.id}: question reads as a support ticket ("${stem}")`),
    )

    expect(offenders, 'diagnostic questions belong on the in-app help page').toEqual([])
  })

  it('the checks can still fire — the pool really does contain what they hunt for', () => {
    // A clean PUBLIC_FAQ and a broken scanner produce the same empty array.
    // FAQ_FLAT is the unfiltered pool, so these must be non-zero or the
    // patterns above have gone stale and the two checks are measuring nothing.
    const navInPool = FAQ_FLAT.filter((f) =>
      IN_APP_NAVIGATION.some((nav) => f.answer.includes(nav)),
    )
    const stemsInPool = FAQ_FLAT.filter((f) =>
      ACCOUNT_SPECIFIC_STEMS.some((stem) => f.question.toLowerCase().includes(stem)),
    )

    expect(navInPool.length, 'IN_APP_NAVIGATION matches nothing in FAQ_FLAT — patterns are stale').toBeGreaterThan(0)
    expect(stemsInPool.length, 'ACCOUNT_SPECIFIC_STEMS matches nothing in FAQ_FLAT — patterns are stale').toBeGreaterThan(0)

    // And the override mechanism is doing its job, not merely existing.
    //
    // This assertion is written against the RESOLVED answer rather than the
    // pool entry, and the difference is the whole point: the first version
    // compared POOL ids against public ids and failed on
    // billing-property-count, which is in the public set AND has a nav string
    // in its shared answer. That is not a leak, it is precisely the case
    // PUBLIC_FAQ_OVERRIDES exists for. An id-level check cannot tell "the
    // source needs an override" from "the override is missing".
    const needsOverride = navInPool
      .filter((f) => PUBLIC_FAQ.some((p) => p.id === f.id))
      .map((f) => f.id)

    expect(
      needsOverride.length,
      'no public entry currently inherits a nav string, so this check is not ' +
      'exercising the override path — expected at least billing-property-count',
    ).toBeGreaterThan(0)

    const unfixed = needsOverride.filter((id) => {
      const resolved = PUBLIC_FAQ.find((p) => p.id === id)
      return IN_APP_NAVIGATION.some((nav) => resolved?.answer.includes(nav))
    })

    expect(
      unfixed,
      'these ids carry in-app navigation in their shared answer and have no ' +
      'working PUBLIC_FAQ_OVERRIDES entry, so /faq renders the nav string',
    ).toEqual([])

    // Questions have no override path, so for those a pool hit IS a leak.
    const publicIds = new Set(PUBLIC_FAQ.map((f) => f.id))
    expect(stemsInPool.filter((f) => publicIds.has(f.id)).map((f) => f.id)).toEqual([])
  })
})
