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
  'app/(dashboard)/bookings/calendar-actions.ts': 1,
  'app/(dashboard)/capital-planning/actions.ts': 1,
  'app/(dashboard)/capital-planning/trigger-ledger-button.tsx': 1,
  'app/(dashboard)/capital-planning/trigger-projections-button.tsx': 1,
  'app/(dashboard)/inventory/actions.ts': 13,
  'app/(dashboard)/maintenance/actions.ts': 30,
  'app/(dashboard)/maintenance/create-work-order-helpers.ts': 1,
  'app/(dashboard)/maintenance/work-order-actions.ts': 2,
  'app/(dashboard)/messages/actions.ts': 4,
  'app/(dashboard)/owners/actions.ts': 8,
  'app/(dashboard)/properties/[id]/setup/checklist/actions.ts': 3,
  'app/(dashboard)/properties/[id]/setup/details/actions.ts': 1,
  'app/(dashboard)/properties/[id]/setup/details/page.tsx': 1,
  'app/(dashboard)/properties/[id]/setup/ical/actions.ts': 2,
  'app/(dashboard)/properties/[id]/setup/maintenance/actions.ts': 4,
  'app/(dashboard)/properties/actions.ts': 8,
  'app/(dashboard)/properties/clone-actions.ts': 4,
  'app/(dashboard)/properties/page.tsx': 1,
  'app/(dashboard)/reviews/actions.ts': 2,
  'app/(dashboard)/settings/actions.ts': 11,
  'app/(dashboard)/settings/integrations/actions.ts': 4,
  'app/(dashboard)/settings/team/actions.ts': 3,
  'app/(dashboard)/setup/actions.ts': 1,
  'app/(dashboard)/templates/checklist/actions.ts': 3,
  'app/(dashboard)/templates/inventory/actions.ts': 2,
  'app/(dashboard)/templates/maintenance/actions.ts': 3,
  'app/(dashboard)/turnovers/actions.ts': 21,
  'app/(dashboard)/vendors/actions.ts': 3,
  'app/accept-invite/[token]/page.tsx': 1,
  'app/actions/guidebook.ts': 3,
  'app/actions/work-order-public.ts': 2,
  'app/admin/inventory-catalog/page.tsx': 1,
  'app/admin/inventory-templates/actions.ts': 1,
  'app/admin/inventory-templates/page.tsx': 2,
  'app/admin/seed-templates/actions.ts': 2,
  'app/admin/seed-templates/page.tsx': 1,
  'app/api/assets/capex-csv/route.ts': 1,
  'app/api/assets/cpa-export/route.ts': 2,
  'app/api/assets/request-scan/route.ts': 3,
  'app/api/crew/feedback/route.ts': 1,
  'app/api/crew/inventory-count/route.ts': 6,
  'app/api/crew/turnovers/[id]/complete/route.ts': 2,
  'app/api/crew/turnovers/[id]/start/route.ts': 1,
  'app/api/crew/work-order-reports/route.ts': 2,
  'app/api/crew/work-orders/[id]/complete/route.ts': 1,
  'app/api/dashboard/push-subscribe/route.ts': 1,
  'app/api/gdpr/export/route.ts': 5,
  'app/api/guidebook/redeem/route.ts': 2,
  'app/api/invoices/[invoiceId]/checkout/route.ts': 1,
  'app/api/repuguard/generate/route.ts': 4,
  'app/api/support-inbox/reply/route.ts': 1,
  'app/api/support-inbox/resolve/route.ts': 1,
  'app/api/support/chat/route.ts': 1,
  'app/api/vendor-connect/[token]/onboard/route.ts': 2,
  'app/api/webhooks/[provider]/route.ts': 1,
  'app/api/webhooks/stripe-connect/route.ts': 1,
  'app/api/webhooks/stripe/handlers/core-billing.ts': 1,
  'app/api/webhooks/stripe/handlers/work-order-invoice.ts': 1,
  'app/api/work-orders/[token]/complete/helpers.ts': 3,
  'app/api/work-orders/[token]/complete/route.ts': 4,
  'app/api/work-orders/[token]/photos/route.ts': 2,
  'app/api/work-orders/[token]/quote/route.ts': 3,
  'app/billing-wall/page.tsx': 1,
  'app/crew-invite/[token]/page.tsx': 1,
  'app/crew/availability/page.tsx': 1,
  'app/crew/layout.tsx': 1,
  'app/crew/turnovers/actions.ts': 3,
  'app/g/[slug]/page.tsx': 2,
  'app/g/b/[token]/opt-in/page.tsx': 2,
  'app/g/b/[token]/page.tsx': 4,
  'app/g/kit/[media_kit_token]/page.tsx': 1,
  'app/g/kit/[media_kit_token]/print/page.tsx': 2,
  'app/onboarding/page.tsx': 3,
  'app/vendor-connect/[token]/status/page.tsx': 1,
  'app/work-orders/[token]/page.tsx': 1,
  'app/work-orders/[token]/quote/page.tsx': 1,
  'lib/asset-discovery/engine.ts': 1,
  'lib/asset-discovery/seed-from-amenities.ts': 2,
  'lib/auth.ts': 3,
  'lib/auth/invites.ts': 1,
  'lib/checklists/apply-master-template.ts': 5,
  'lib/checklists/seed-default-room-templates.ts': 2,
  'lib/crew-auth.ts': 1,
  'lib/dexie/context.tsx': 1,
  'lib/guidebook/featured-amenities.ts': 1,
  'lib/guidebook/slug.ts': 2,
  'lib/guidebook/sync.ts': 4,
  'lib/ical/conflict-detection.ts': 1,
  'lib/inngest/functions/apply-master-checklist.ts': 1,
  'lib/inngest/functions/asset-scan.ts': 1,
  'lib/inngest/functions/auto-assign-turnover.ts': 8,
  'lib/inngest/functions/auto-assign-vendor.ts': 6,
  'lib/inngest/functions/booking-events.ts': 5,
  'lib/inngest/functions/build-shopping-cart.ts': 2,
  'lib/inngest/functions/checklist-broadcast.ts': 4,
  'lib/inngest/functions/crew-assignment.ts': 3,
  'lib/inngest/functions/crew-turnover-cancelled.ts': 3,
  'lib/inngest/functions/cron/asset-health.ts': 2,
  'lib/inngest/functions/cron/checklist-signals.ts': 1,
  'lib/inngest/functions/cron/comms-retention.ts': 1,
  'lib/inngest/functions/cron/daily-wrapup.ts': 14,
  'lib/inngest/functions/cron/guest-pii-retention.ts': 1,
  'lib/inngest/functions/cron/integration-token-refresh-handler.ts': 1,
  'lib/inngest/functions/cron/maintenance-schedules-helpers.ts': 1,
  'lib/inngest/functions/cron/maintenance-schedules.ts': 2,
  'lib/inngest/functions/cron/vendor-compliance-expiry-check.ts': 2,
  'lib/inngest/functions/cron/vendor-compliance-grace-check.ts': 3,
  'lib/inngest/functions/cron/work-order-ops.ts': 2,
  'lib/inngest/functions/email-subscriber-checkin.ts': 1,
  'lib/inngest/functions/email-trial-lifecycle.tsx': 4,
  'lib/inngest/functions/flagged-turnover-wo.ts': 3,
  'lib/inngest/functions/geocoding-backfill.ts': 2,
  'lib/inngest/functions/guidebook-guest-opted-in.ts': 1,
  'lib/inngest/functions/guidebook-sms-evening-cron.ts': 3,
  'lib/inngest/functions/guidebook-sms-morning-cron.ts': 4,
  'lib/inngest/functions/guidebook-sponsor-activated.ts': 1,
  'lib/inngest/functions/guidebook-sponsor-deactivated.ts': 2,
  'lib/inngest/functions/guidebook-stay-extension-cron.ts': 5,
  'lib/inngest/functions/guidebook-stay-extension-handler.ts': 4,
  'lib/inngest/functions/hospitable/calendar-sync-cron.ts': 1,
  'lib/inngest/functions/hospitable/hospitable-reviews-backfill.ts': 2,
  'lib/inngest/functions/hospitable/incremental-sync.ts': 6,
  'lib/inngest/functions/hospitable/initial-sync.ts': 3,
  'lib/inngest/functions/hospitable/property-merge.ts': 1,
  'lib/inngest/functions/hostaway/initial-sync.ts': 3,
  'lib/inngest/functions/ical-sync.ts': 2,
  'lib/inngest/functions/inventory-events.ts': 8,
  'lib/inngest/functions/kroger-connected.ts': 2,
  'lib/inngest/functions/log-message-comm.ts': 2,
  'lib/inngest/functions/notify-assignment-gap.ts': 2,
  'lib/inngest/functions/onboarding-drip.tsx': 3,
  'lib/inngest/functions/ownerrez/incremental-sync.ts': 6,
  'lib/inngest/functions/ownerrez/initial-sync.ts': 7,
  'lib/inngest/functions/ownerrez/ownerrez-reviews-sync.ts': 3,
  'lib/inngest/functions/ownerrez/reconciliation-handler.ts': 1,
  'lib/inngest/functions/platform-inventory-template-broadcast.ts': 7,
  'lib/inngest/functions/promo-hospitable-award-lock.ts': 1,
  'lib/inngest/functions/support-conversation-escalated.ts': 2,
  'lib/inngest/functions/turnover-events.ts': 7,
  'lib/inngest/functions/work-order-crew-assigned.ts': 1,
  'lib/inngest/functions/work-order-crew-completed.ts': 1,
  'lib/inngest/functions/work-order-dispatch.ts': 5,
  'lib/inngest/functions/work-order-events-helpers.ts': 1,
  'lib/inngest/functions/work-order-events.ts': 8,
  'lib/inngest/functions/work-order-invoice-paid.ts': 1,
  'lib/inngest/functions/work-order-invoice.ts': 2,
  'lib/inngest/helpers.ts': 1,
  'lib/integrations/finalize-connection.ts': 1,
  'lib/integrations/health.ts': 3,
  'lib/integrations/providers/hospitable-owner.ts': 1,
  'lib/integrations/providers/hospitable-token.ts': 1,
  'lib/integrations/providers/kroger-token.ts': 2,
  'lib/integrations/providers/ownerrez-api.ts': 1,
  'lib/integrations/providers/ownerrez.ts': 1,
  'lib/maintenance/vacancy-suggestions.ts': 1,
  'lib/properties/upsert-normalized.ts': 1,
  'lib/push/send-push.ts': 2,
  'lib/sms/optin-claim.ts': 1,
  'lib/sms/templates.ts': 1,
  'lib/stripe/vendor-connect-invite.ts': 1,
  'lib/supabase/unwrap.ts': 1,
  'lib/support/account-tools.ts': 3,
  'lib/support/retrieve.ts': 1,
  'lib/turnovers/assignment.ts': 1,
  'lib/turnovers/generator.ts': 5,
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
