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

/**
 * A destructuring pattern that takes `data` and drops `error`.
 *
 * `error` bound — possibly renamed, `error: fooError` — means it is handled
 * here. Binding no `data` at all means `{ count }` alone, which is covered
 * separately.
 */
function bindsDataWithoutError(bindings: string): boolean {
  return !/\berror\b/.test(bindings) && /\bdata\b/.test(bindings)
}

/** `const { data } = await supabase…` — the single-result form. */
function countDestructured(src: string, file: string): number {
  let n = 0
  for (const m of src.matchAll(DESTRUCTURE)) {
    if (!bindsDataWithoutError(m[1]!)) continue
    if (!looksLikeSupabase(m[2]!, file, m.index, src)) continue
    n++
  }
  return n
}

/** `const [{ data: a }, { data: b }] = await Promise.all([…])` — the fan-in form. */
function countPromiseAll(src: string): number {
  let n = 0
  for (const m of src.matchAll(PROMISE_ALL)) {
    // Only count when the awaited array actually holds Supabase queries.
    if (!/\.(from|rpc)\s*\(/.test(src.slice(m.index, m.index + 4000))) continue
    for (const el of m[1]!.matchAll(/\{([^}]*)\}/g)) {
      if (bindsDataWithoutError(el[1]!)) n++
    }
  }
  return n
}

function unhandledCounts(): Map<string, number> {
  const counts = new Map<string, number>()

  for (const file of collectSourceFiles(DIRS)) {
    const src = read(file)
    if (!src.includes('await')) continue

    const n = countDestructured(src, file) + countPromiseAll(src)
    if (n > 0) counts.set(rel(file), n)
  }
  return counts
}

// Measured after the 2026-07-30 sweep: 481 unhandled results across 169 files.
// Every number may only DECREASE. Lower it when you fix sites in that file;
// delete the entry when it reaches zero. Never add an entry, never raise one.
const BASELINE: Record<string, number> = {
  // 3 -> 0 (entry deleted). resolveTemplateId's template/property lookups and
  // validateRoomTemplateIds' ownership read now unwrap — discarded, a
  // transient failure looked identical to "not found", returning a
  // false-negative error to the PM instead of retrying.
  // 2 -> 0 (entry deleted). addIcalFeed's property-ownership lookup and
  // triggerSingleFeedSync's feed lookup now filter for a real query error
  // (isRealQueryError) before falling through their already-tolerant "not
  // found" default, so a transient failure reports rather than silently
  // behaving as "this property/feed doesn't exist".
  // 3 -> 0 (entry deleted). createAsset's and bulkImportAssets' property
  // lookups now filter for a real query error before falling through their
  // already-tolerant "not found" default; markStepComplete's milestone-count
  // read and the second-property milestone upsert now unwrap.
  // 4 -> 0 (entry deleted). Every read/write in the setup clone (inventory,
  // checklist template, maintenance schedules) now unwraps.
  // 11 -> 0 (entry deleted). Every ownership/existence lookup across crew,
  // vendor, invite-claim, billing-portal, and checkout-session flows now
  // filters for a real query error (isRealQueryError) before falling through
  // its already-tolerant "not found" default, or unwraps outright where no
  // such tolerance existed (the billing-portal and checkout-session org
  // reads). Discarded, a transient failure on e.g. the invite-claim read
  // looked identical to "someone else already claimed this send", and on the
  // checkout-session org read looked identical to "no Stripe customer yet" —
  // silently letting a second Checkout session through for an
  // already-subscribed org.
  // 4 -> 1 -> 0 (entry deleted). The three connection lookups now go through
  // tryUnwrap. The disconnectIntegration one was the costly one — a failed
  // read produced the same null as "no such connection", so the PM was told
  // the integration isn't connected while the provider token stayed live in
  // Vault. Same defect on the same table as the deleted findUserByExternalId
  // (lib/integrations/vault.ts). getSyncProgress's bare `catch { return null
  // }` now reports too. The last one, triggerResync's Hospitable
  // property-fan-out read, now reports its error instead of silently
  // skipping the calendar re-sync for every active property.
  // 3 -> 2: removeMember's target-role lookup unwraps. It is the ONLY thing
  // enforcing "an owner cannot be removed", and the delete below it is
  // org-scoped but role-blind — so a transient failure of that read let the
  // delete run against an owner, and a non-member id returned { ok: true }
  // with an audit row for a removal that never happened.
  // 2 -> 0 (entry deleted). inviteTeamMember's already-member and
  // existing-invite lookups now filter for a real query error before
  // falling through their already-tolerant "not found" default.
  // 2 -> 0 (entry deleted). upsertParLevelItems' property-ownership check and
  // its client-supplied-id verification read now unwrap/isRealQueryError —
  // discarded, a failed verification read produced an empty verified set, so
  // every client-supplied item id looked unowned and silently dropped out of
  // the save instead of erroring.
  // 3 -> 0 (entry deleted). The template/item ownership lookups in
  // addMaintenanceTemplateItem, updateMaintenanceTemplateItem, and
  // removeMaintenanceTemplateItem now unwrap.
  // 3 -> 2: optInGuestSms's booking lookup now binds and reports its error.
  // Discarding it made a transient failure indistinguishable from a bad token,
  // so a guest with a valid link was told the link was invalid.
  // 2 -> 1 -> 0 (entry deleted). createSponsorCheckoutSession's media-kit-token
  // lookup had the SAME defect one function over — a sponsor holding a valid
  // link was told it was invalid whenever the query itself failed.
  // upsertPropertyGuidebookConfig's property-ownership check now filters for
  // a real query error (isRealQueryError) before falling through to its
  // already-tolerant "Property not found." response.

  // 4 -> 0 (entry deleted). The booking-by-token lookup, the org guidebook
  // config read, the pending-extension read, and the sponsors list all now
  // unwrap/unwrapList. Discarded, a failed booking read rendered the same
  // 404 as an unknown token, and a failed org-config read rendered the same
  // "guidebook unavailable" as a PM who genuinely hasn't published one —
  // both indistinguishable from an outage to the guest looking at the page.
  // 5 -> 4 -> 0 (entry deleted). The already-has-a-default guard read
  // unwraps, and the remaining reads (the step-complete flag, the property
  // fetch, the existing-sections read, the new-template insert) now unwrap
  // or throw too. Discarded, a transient failure made existingTemplate
  // null, the guard evaluated false, and a SECOND default template was
  // created for a property that already had one — then compounded, because
  // with two rows the guard's .maybeSingle() errored on every later run and
  // each run added another.
  // 20260807190000 adds the partial unique index that makes it impossible.
  // 2 -> 0 (entry deleted). The org-seeded check and the existing-template
  // lookup inside upsertOneSeedTemplate now filter for a real query error
  // (isRealQueryError) before falling back to their already-tolerant "not
  // found" default.

  // 4 -> 2: ensureGuidebookConfiguration's upsert, createGuidebookPropertyConfigsForProperties'
  // existingConfigs read and its own upsert, and syncGuidebookConfigsFromProperty's
  // configs read now unwrap/unwrapList. The remaining two (the property reads
  // feeding both create/sync passes) are unchanged.
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
  // 4 -> 0 (entry deleted). The source-template read, the target upsert, the
  // existing-sections read, and the per-section insert all now check for a
  // real query error and throw (per-step Inngest retry) instead of falling
  // through their existing "not found"/"skip this section" tolerance on a
  // transient failure — a broadcast that silently dropped a section on a
  // transient error still reported the target as fully synced.
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
  // 2 -> 0 (entry deleted). The synced-property-list read and the connection
  // metadata read inside updateConnectionMeta now throw on a real error.
  // Discarded, the property-list failure looked identical to "no synced
  // properties yet" and skipped the backfill silently; the metadata read
  // failure meant a merged metadata patch silently dropped every other key
  // already on the row instead of the intended {...existing, ...patch}.
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
  // 2 -> 0 (entry deleted). The upsert-bookings step's upserted-rows read and
  // the alert-pm-overlap-conflict step's property read now unwrap/filter for
  // a real query error.
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
  // 4 -> 2 -> 0 (entry deleted). The new-property diff's `known` read and the
  // connection reload unwrap. The first amplified rather than degraded — a
  // null result made every OwnerRez property look new, re-firing a full
  // initial sync for the whole org, hourly. The second reported a healthy
  // connection as `connection_not_active`. The remaining two — the
  // no-cursor property-id fallback and the throttled error-notification's
  // recent-notification lookup — now unwrap/filter for a real error too.
  // 3 -> 0 (entry deleted). The revoked-connection existence check, the
  // throttled error-notification's recent-notification lookup, and the
  // property lookup feeding the review upsert now all throw on a real error
  // instead of falling through their existing-tolerance path — the property
  // lookup mattered most, since a discarded failure there left every review
  // in this batch silently unlinked from its property.
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
  // 3 -> 0 (entry deleted). The three completion/overdue/quote notification
  // steps' work-order reads now filter for a real query error before
  // falling through their existing "not found" tolerance.

  // 2 -> 0 (entry deleted). sendPushToUser's crew-member and subscription
  // lookups now report and return early on a real error, rather than
  // treating the failure identically to "this user has no crew record" /
  // "no subscriptions registered" and silently sending nothing.
  // 3 -> 0 (entry deleted). snapshotChecklist's sections read, instance
  // insert, and signals read now unwrap/unwrapList.
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
