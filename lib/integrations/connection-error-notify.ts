// lib/integrations/connection-error-notify.ts
// ============================================================================
// The 4-hour throttle behind the PM "your integration connection broke"
// notification, as two plain database calls.
//
// ── Why this is a module and not just a helper next to its caller ───────────
//
// The same throttle was open-coded twice — ownerrez/initial-sync.ts's
// handle-sync-failure step and ownerrez-reviews-sync.ts's mark-revoked step —
// with the same milestone key, the same 4-hour window, and the same
// read-then-send-then-record shape. Both copies also carried the same defect
// (see below), which is the usual argument for one owner: the second copy did
// not get fixed when the first one was looked at.
//
// ── What must NOT come back in here: step tooling ───────────────────────────
//
// Both call sites had `step.sendEvent()` sitting INSIDE a `step.run()`
// callback. Inngest does not support nesting step tooling; the SDK detects it
// and emits a NESTING_STEPS warning (see inngest/components/execution/v1.js —
// it warns, it does not throw, which is why this survived review).
//
// The runtime cost is not the warning. A step tool called mid-callback
// registers a NEW step op and the request unwinds so the server can schedule
// it — the enclosing step.run never resolves in that pass. On the next pass
// the nested op is memoized but the OUTER step is not, so its callback runs
// again from the top. At both call sites the callback's earlier statements
// include `logAuditEvent(...)`, which is a plain insert with no dedup key, so
// every connection revocation wrote TWO `integration.sync_failed` audit rows.
// The notification itself did still go out — this cost duplicate audit
// history and a wasted round trip, not a lost alert.
//
// So the split here is deliberate and load-bearing: everything in this file is
// ordinary async database work that is safe to call inside a step.run, and the
// `step.sendEvent` between the two halves stays at the TOP LEVEL of the
// Inngest function, where it belongs. Do not "tidy" the send back in here — it
// would take the step tooling with it and put the nesting straight back.
// unit/guardrails/inngest-nested-steps.test.ts fails if it returns.
// ============================================================================

import type { createServiceClient } from '@/lib/supabase/server'
import { reportQueryError } from '@/lib/supabase/unwrap'

type ServiceClient = ReturnType<typeof createServiceClient>

/** One notification per connection per this window. */
const THROTTLE_MS = 4 * 60 * 60 * 1000

/** Both halves must agree on the key, so neither call site spells it itself. */
export function connectionErrorMilestoneKey(connectionId: string): string {
  return `integration_error_notified:${connectionId}`
}

/**
 * Has enough time passed since the last notification for this connection?
 *
 * NON-THROWING, and fails OPEN — a read error resolves to "yes, notify".
 *
 * That direction is chosen, not incidental. This throttle guards a message
 * saying a connection is revoked: only the PM can fix that, and it never
 * self-resolves, so silence is the expensive failure and a repeat is the cheap
 * one. Failing open is bounded in practice — the reviews cron runs every 6
 * hours, which is wider than the 4-hour window this read exists to enforce, so
 * even a permanently broken read yields at most one notification per tick
 * rather than a loop.
 *
 * It also must not throw for a structural reason: callers run it inside a
 * step.run whose earlier statements have already written an audit row, and a
 * throw there re-runs the whole callback on retry and duplicates that row.
 */
export async function shouldNotifyConnectionError(
  admin:  ServiceClient,
  params: { orgId: string; connectionId: string; site: string },
): Promise<boolean> {
  const { data, error } = await admin
    .from('org_milestones')
    .select('value, achieved_at')
    .eq('org_id', params.orgId)
    .eq('milestone', connectionErrorMilestoneKey(params.connectionId))
    .order('achieved_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (reportQueryError(error, { site: params.site, orgId: params.orgId })) {
    return true
  }

  const lastNotifiedAt = (data?.value as Record<string, unknown> | null)?.notified_at
  if (typeof lastNotifiedAt !== 'string') return true

  const last = new Date(lastNotifiedAt).getTime()
  // An unparseable timestamp is treated as "never notified" for the same
  // fail-open reason as the read error above.
  if (Number.isNaN(last)) return true

  return Date.now() - last >= THROTTLE_MS
}

/**
 * Record that a notification just fired, so the next call throttles.
 *
 * NON-THROWING. Callers run this in its own step.run AFTER the send, so the
 * worst case of a failure here is that the milestone is missing and the next
 * tick notifies again — the same outcome as failing open above, and strictly
 * better than re-running a callback that already emitted an audit row.
 */
export async function recordConnectionErrorNotified(
  admin:  ServiceClient,
  params: { orgId: string; connectionId: string; site: string },
): Promise<void> {
  const { error } = await admin.from('org_milestones').upsert({
    org_id:    params.orgId,
    milestone: connectionErrorMilestoneKey(params.connectionId),
    value:     { notified_at: new Date().toISOString() },
  }, { onConflict: 'org_id,milestone' })

  reportQueryError(error, { site: params.site, orgId: params.orgId })
}
