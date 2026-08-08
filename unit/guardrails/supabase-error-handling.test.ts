import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// ============================================================================
// Ratchet: a Supabase result may not be destructured for `data` alone.
//
// `const { data } = await supabase.from(...)...` collapses two completely
// different outcomes into `data == null`:
//
//   • the table is genuinely empty  → render the friendly empty state
//   • the query FAILED (an RLS regression, a missing GRANT to `authenticated`,
//     a dropped connection) → an outage, which this shape renders as the SAME
//     friendly empty state, with nothing in the console and nothing in Sentry
//
// That is not hypothetical. The notification bell was dark in production for
// exactly this reason: `notifications` had RLS policies but no authenticated
// GRANT, lib/notifications.ts discarded the error, and the panel cheerfully
// said "You're all caught up."
//
// The fix at each call site is one of:
//   • unwrap / unwrapList / unwrapCount   (lib/supabase/unwrap.ts) — throws, so
//     the segment's error.tsx renders a real error state
//   • tryUnwrap / tryUnwrapList           — explicit { ok } the caller branches on
//   • reportQueryError(error, ctx)        — for writes that return their own
//     { success: false } to the client
//   • destructure `error` and handle it inline
//
// 481 call sites predate the rule, so this is a clean-baseline ratchet in the
// same shape as tailwind-color-ratchet: the per-file counts below may only go
// DOWN. Lower a number when you fix sites in that file; delete the entry when
// it reaches zero. NEVER add an entry and never raise a number — a new file
// with an unhandled result fails immediately.
// ============================================================================

const DIRS = ['app', 'lib', 'components']

/**
 * Matches `const { data ... } = await <something>` where the destructuring
 * pattern contains no `error` binding. Restricted to awaited expressions so
 * ordinary object destructuring (props, config) is not swept in, and the
 * expression must mention a Supabase-ish call to avoid flagging awaited
 * fetch/JSON shapes that legitimately have a `data` key.
 */
const DESTRUCTURE = /(?:const|let)\s*\{([^}]*)\}\s*=\s*await\s+([^\n]*)/g

/**
 * The other half of the problem, and the more common one on list pages:
 *   const [{ data: a }, { data: b }] = await Promise.all([...])
 * Each element is its own Supabase result, and each one drops its error.
 */
const PROMISE_ALL = /(?:const|let)\s*\[([\s\S]{0,2000}?)\]\s*=\s*await\s+Promise\.all\(/g

function looksLikeSupabase(expr: string, file: string, index: number, src: string): boolean {
  // Single-line form: `= await supabase.from('x')...`
  if (/\b(supabase|admin|service|serviceClient|db|client)\s*\n?\s*$/.test(expr)) return true
  if (/\.(from|rpc)\s*\(/.test(expr)) return true
  // Multi-line chain: peek at the next few lines for `.from(` / `.rpc(`.
  const tail = src.slice(index, index + 600)
  return /=\s*await[\s\S]{0,120}?\.(from|rpc)\s*\(/.test(tail)
}

function unhandledCounts(): Map<string, number> {
  const counts = new Map<string, number>()
  for (const file of collectSourceFiles(DIRS)) {
    const src = read(file)
    if (!src.includes('await')) continue
    let n = 0
    for (const m of src.matchAll(DESTRUCTURE)) {
      const bindings = m[1]!
      // `error` bound (possibly renamed: `error: fooError`) ⇒ handled here.
      if (/\berror\b/.test(bindings)) continue
      // Must actually bind `data` — `{ count }` alone is covered separately.
      if (!/\bdata\b/.test(bindings)) continue
      if (!looksLikeSupabase(m[2]!, file, m.index, src)) continue
      n++
    }
    for (const m of src.matchAll(PROMISE_ALL)) {
      // Only count when the awaited array actually holds Supabase queries.
      const body = src.slice(m.index, m.index + 4000)
      if (!/\.(from|rpc)\s*\(/.test(body)) continue
      for (const el of m[1]!.matchAll(/\{([^}]*)\}/g)) {
        const bindings = el[1]!
        if (/\berror\b/.test(bindings)) continue
        if (!/\bdata\b/.test(bindings)) continue
        n++
      }
    }
    if (n > 0) counts.set(rel(file), n)
  }
  return counts
}

// Measured after the 2026-07-30 sweep: 481 unhandled results across 169 files.
// Every number may only DECREASE. Lower it when you fix sites in that file;
// delete the entry when it reaches zero. Never add an entry, never raise one.
const BASELINE: Record<string, number> = {
  'app/(dashboard)/bookings/actions.ts': 2,
  'app/(dashboard)/owners/actions.ts': 7,
  'app/(dashboard)/properties/[id]/setup/checklist/actions.ts': 3,
  'app/(dashboard)/properties/[id]/setup/ical/actions.ts': 2,
  'app/(dashboard)/properties/actions.ts': 3,
  'app/(dashboard)/properties/clone-actions.ts': 4,
  'app/(dashboard)/settings/actions.ts': 11,
  // 4 -> 1: the three connection lookups now go through tryUnwrap. The
  // disconnectIntegration one was the costly one — a failed read produced the
  // same null as "no such connection", so the PM was told the integration
  // isn't connected while the provider token stayed live in Vault. Same defect
  // on the same table as the deleted findUserByExternalId (lib/integrations/
  // vault.ts). getSyncProgress's bare `catch { return null }` now reports too.
  'app/(dashboard)/settings/integrations/actions.ts': 1,
  // 3 -> 2: removeMember's target-role lookup unwraps. It is the ONLY thing
  // enforcing "an owner cannot be removed", and the delete below it is
  // org-scoped but role-blind — so a transient failure of that read let the
  // delete run against an owner, and a non-member id returned { ok: true }
  // with an audit row for a removal that never happened.
  'app/(dashboard)/settings/team/actions.ts': 2,
  'app/(dashboard)/templates/inventory/actions.ts': 2,
  'app/(dashboard)/templates/maintenance/actions.ts': 3,
  'app/(dashboard)/vendors/actions.ts': 3,
  // 3 -> 2: optInGuestSms's booking lookup now binds and reports its error.
  // Discarding it made a transient failure indistinguishable from a bad token,
  // so a guest with a valid link was told the link was invalid.
  // 2 -> 1: createSponsorCheckoutSession's media-kit-token lookup had the SAME
  // defect one function over — a sponsor holding a valid link was told it was
  // invalid whenever the query itself failed.
  'app/actions/guidebook.ts': 1,

  'app/api/repuguard/generate/route.ts': 3,
  'app/api/vendor-connect/[token]/onboard/route.ts': 2,
  'app/g/b/[token]/page.tsx': 4,
  // 5 -> 4: the already-has-a-default guard read now unwraps. Discarded, a
  // transient failure made existingTemplate null, the guard evaluated false,
  // and a SECOND default template was created for a property that already had
  // one — then compounded, because with two rows the guard's .maybeSingle()
  // errored on every later run and each run added another.
  // 20260807190000 adds the partial unique index that makes it impossible.
  'lib/checklists/apply-master-template.ts': 4,
  'lib/checklists/seed-default-room-templates.ts': 2,

  'lib/guidebook/sync.ts': 4,
  // 2 -> 0 (entry deleted). Both are scoring signals for a vendor SUGGESTION,
  // so they report rather than throw — a PM accepts or overrides it, and
  // there is deliberately no autopilot mode for vendors. Discarded, though, a
  // failed read silently removed an entire signal: an empty workload map
  // makes every vendor look idle, so the busiest scores the same as the free
  // one. That is exactly what makes "the suggestions got worse" unexplainable.
  // 2 -> 0 (entry deleted). The Kroger connection read was the costly one:
  // discarded, a failure made `connection` null, which the caller reads as
  // "no store configured" — so it told a PM whose store IS connected to go
  // connect it, and wrote the kroger_store_needed flag to keep saying so.
  'lib/inngest/functions/checklist-broadcast.ts': 4,
  // 13 -> 0 (entry deleted). Every read in the per-org digest now unwraps.
  // Discarded, each failure produced null, `?? []` made it an empty section,
  // and the digest went out silently short — with no other surface for some of
  // it (handleTurnoverCreated defers unassigned-turnover warnings here by
  // design), and `nothing_to_report` if enough failed at once, so a total
  // outage rendered as a quiet day.
  //
  // The diffed sections were worse: diffDigestSnapshot upserts
  // `{ ids: currentIds }` unconditionally, so an empty list from a failed read
  // overwrote the stored snapshot with [] and the next day re-announced the
  // entire backlog as new. That is the exact defect diffDigestSnapshot's own
  // comment describes — closed on the snapshot read, left open on every read
  // feeding it.
  // 2 -> 0 (entry deleted). The overdue pass could silently do nothing: the
  // open-WO lookup decides the whole branch, so a failed read sent a schedule
  // that already HAS an open work order down the create path instead, where
  // the unique constraint no-ops the insert — the existing WO never got
  // escalated to urgent, which is the entire purpose of that pass. The
  // idempotency read and the insert itself were discarded the same way, so a
  // real insert failure was indistinguishable from the expected 23505 race.
  // 2 -> 0 (entry deleted). The next_due_date advance was the costly one: a
  // silent failure left the schedule pointing at a date already handled, so
  // the auto-create step's unique constraint rejected tomorrow's duplicate as
  // an expected race and the schedule stopped producing work orders for this
  // occurrence and every future one.
  'lib/inngest/functions/email-trial-lifecycle.tsx': 4,
  // 3 -> 0 (entry deleted). The idempotency read was the interesting one:
  // discarded, a failure looked like "no work order yet", so the insert ran
  // and hit wo_crew_flag_source_unique — surfacing as "duplicate key" on
  // every retry. No duplicate was ever possible (that partial unique index
  // guarantees it), but the reported cause was the collision rather than the
  // read that caused it.
  // 3 -> 0 (entry deleted), same three reads as its morning twin below: a
  // failed sponsor lookup was indistinguishable from an org with no sponsors,
  // and a failed opt-in read from a guest who opted out — every one of them
  // ending at "no SMS" with nothing logged.
  // 4 -> 0 (entry deleted): every read in the per-guest send now unwraps. The
  // opt-in one mattered most — `{ data: optin }` collapsed "this guest opted
  // out" and "the consent read failed" into the same null, and both ended at
  // `return false`, so a transient failure silently suppressed the message
  // with nothing logged and no retry. The two sponsor reads had the same
  // shape: a failed lookup produced an empty pool, indistinguishable from an
  // org that simply has no sponsor in that slot.
  //
  // guidebook-stay-extension-cron.ts 5 -> 0 and
  // guidebook-stay-extension-handler.ts 4 -> 0 (both entries deleted): the
  // gap-night offer's whole failure
  // surface was silent. In the cron a failed bookings read looked like "this
  // org has no checkouts", a failed existence check looked like "not yet
  // handled", and a failed next-booking read looked like "open calendar" —
  // each ending in a successful `dispatched: 0`. In the handler a failed
  // context read left `booking` null, so `portalUrl` was null, so the guest
  // SMS block was skipped entirely while the PM email went out reading
  // "checks out on undefined".
  'lib/inngest/functions/hospitable/hospitable-reviews-backfill.ts': 2,
  // 5 -> 0 (entry deleted). Two of them drove DECISIONS rather than display:
  // the existing-booking read feeds `datesChanged`, so a failed read
  // regenerated the property's turnovers on every webhook; the
  // existing-property read feeds `isNewProperty`, re-running the whole
  // first-time seeding path plus a spurious "new property" PM notification.
  // The other three failed toward silently-unlinked data — a review stored
  // with no property, guest messages with no booking, and a read failure
  // surfacing as "Property not in FieldStay".
  // 2 -> 0 (entry deleted). The revenue read was the costly one: `?? []` on a
  // failed read meant ZERO booking/confirmed events, so no revenue posted to
  // owner_transactions for any imported reservation — reported as a clean
  // sync. The other was inside a local read-modify-write metadata merge that
  // this change deleted in favour of the atomic RPC.
  'lib/inngest/functions/hostaway/initial-sync.ts': 2,
  'lib/inngest/functions/ical-sync.ts': 2,
  // 5 -> 3: the count-session and count-items reads at the top of the
  // below-par path now bind and throw their error, so a transient failure
  // gets an Inngest retry instead of reporting success with an empty restock.
  // 3 -> 0 (entry deleted). The same-day-flip detection fails in ONE
  // direction: both booking reads produced an empty array on error, which
  // reads as "not a same-day flip", so the PO went unmarked and the immediate
  // restock email never sent — the order waits for the end-of-day cron in the
  // one case where waiting is wrong, with a guest arriving today or tomorrow.
  // 3 -> 1: the two hand-rolled email_unsubscribed_at reads were replaced by
  // resolveEmailAudience(), which goes through tryUnwrap and fails closed.
  // 4 -> 2: the new-property diff's `known` read and the connection reload
  // unwrap. The first amplified rather than degraded — a null result made
  // every OwnerRez property look new, re-firing a full initial sync for the
  // whole org, hourly. The second reported a healthy connection as
  // `connection_not_active`.
  'lib/inngest/functions/ownerrez/incremental-sync.ts': 2,
  // 6 -> 4: the checklist-seeding reads unwrap. A failed properties read
  // short-circuited to [] and every freshly synced property silently never got
  // a checklist — a turnover with nothing for the crew to work from, reported
  // as a clean sync.
  'lib/inngest/functions/ownerrez/initial-sync.ts': 4,
  'lib/inngest/functions/ownerrez/ownerrez-reviews-sync.ts': 3,
  'lib/inngest/functions/platform-inventory-template-broadcast.ts': 4,
  // 3 -> 0 (entry deleted). Each failure produced a skip reason that was a
  // false statement about why: 'work order not found for comms log' for a WO
  // that exists, 'no vendor on work order' for one that has a vendor. The
  // vendor still received the dispatch email every time — only the record of
  // it, or the same-day payout invite, went missing.
  // 8 -> 3. The two that mattered were both on the money path: the
  // work_orders read feeding the maintenance expense (discarded, a failed read
  // produced cost null and the step returned `{ skipped: true }` — success, so
  // no Inngest retry, and the expense never reached owner_transactions), and
  // the owner_transactions upsert itself (its error was indistinguishable from
  // the legitimate ignoreDuplicates no-op, so a failed insert still reported
  // `{ posted: cost }`). The other three were the overdue-path reads, each of
  // which failed toward "no alert" with nothing logged.
  'lib/inngest/functions/work-order-events.ts': 3,

  'lib/integrations/providers/kroger-token.ts': 2,
  'lib/push/send-push.ts': 2,
  'lib/support/account-tools.ts': 3,
  'lib/turnovers/generator.ts': 3,
}

describe('guardrail: Supabase results are not destructured for data without error', () => {
  const counts = unhandledCounts()

  it('no file exceeds its baseline count of unhandled Supabase results', () => {
    const regressions: string[] = []
    for (const [path, n] of counts) {
      const allowed = BASELINE[path] ?? 0
      if (n > allowed) {
        regressions.push(
          `${path}: ${n} unhandled (baseline ${allowed})`
        )
      }
    }
    expect(
      regressions.sort(),
      'A Supabase result destructured for `data` with no `error` makes a failed ' +
      'query indistinguishable from an empty table — the exact defect that left ' +
      'the notification bell dark in production. Use unwrap/unwrapList/tryUnwrap/' +
      'reportQueryError from lib/supabase/unwrap.ts, or destructure and handle ' +
      '`error` inline. Never raise a baseline number.',
    ).toEqual([])
  })

  it('baseline entries whose files improved are lowered (the ratchet tightens)', () => {
    const stale: string[] = []
    for (const [path, allowed] of Object.entries(BASELINE)) {
      const actual = counts.get(path) ?? 0
      if (actual < allowed) stale.push(`${path}: now ${actual}, baseline still ${allowed}`)
    }
    expect(
      stale.sort(),
      'These files have fewer unhandled results than their baseline — lower (or ' +
      'delete) the entry so the cleanup is locked in.',
    ).toEqual([])
  })
})
