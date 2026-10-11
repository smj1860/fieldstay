import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { calcNextDueDate } from '@/lib/turnovers/generator'
import { logAuditEvent, logAuditEvents } from '@/lib/audit'
import { createPmNotification, createPmNotifications } from '@/lib/inngest/helpers'
import { isVendorHardBlocked } from '@/lib/vendors/compliance'
import type { Enums } from '@/types/database'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { fetchAllRows, fetchDistinctOrgIds } from '@/lib/inngest/paginate'
import { reportError } from '@/lib/observability/report-error'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'
import { dueKey, loadExistingDueDatePairs } from './maintenance-schedules-helpers'

const AGING_DAYS = 7

/**
 * The DISPATCH-SILENCE thresholds, in hours.
 *
 * Separate from AGING_DAYS above, and keyed on a different column, because the
 * aging escalation reads `updated_at`: any note, photo or line item resets it,
 * so a dispatched work order could sit unanswered for a week, and a vendor who
 * documents progress pushes their own clock further out. This check reads
 * `vendor_dispatched_at` plus a NULL `vendor_progress` instead, so nothing the
 * PM or the vendor does to the row can reset it. Only an actual answer clears
 * it, because accepting or declining writes `vendor_progress`.
 *
 * 24h nudges the PM. 72h also asks the scorer for an alternative, because by
 * then the question is no longer "did they see it" but "who else can go".
 */
const DISPATCH_SILENT_NUDGE_HOURS   = 24
const DISPATCH_SILENT_REROUTE_HOURS = 72

interface AutoWoSchedule {
  id: string; name: string; org_id: string; property_id: string
  next_due_date: string | null; frequency: string | null; schedule_type: string | null
  // vendor_specialty_hint is the vendor_specialty enum, whose labels are all
  // valid wo_category labels too — that subset relationship is what lets the
  // hint double as the created work order's category below.
  assigned_vendor_id: string | null; vendor_specialty_hint: Enums<'vendor_specialty'> | null
  estimated_cost: number | null; instructions: string | null
  properties: { name: string } | { name: string }[] | null
}

type ServiceClient = ReturnType<typeof createServiceClient>

/** Minimal shape of the Inngest step logger this module uses. */
interface StepLogger {
  warn: (message: string, context?: Record<string, unknown>) => void
}

/**
 * Vendor selection chain for an auto-created WO: explicitly assigned vendor →
 * best-rated active vendor matching the specialty hint → nobody.
 *
 * A hard-blocked vendor is not a valid resolution — it falls through as if the
 * chain found nobody, so this unattended cron never silently assigns someone
 * 31+ days out of compliance (see lib/vendors/compliance.ts).
 *
 * isVendorHardBlocked() THROWS (VendorComplianceCheckError) when the compliance
 * state cannot be established. Letting that propagate would be fail-closed and
 * safe but aborts the whole step.run — an unrelated compliance-view blip would
 * burn both Inngest retries and end with NO work order for a schedule that is
 * genuinely due. So an unverifiable vendor is treated exactly like a
 * hard-blocked one: unresolved. The WO is still created, just unassigned, and
 * the vendor-suggestion flow picks it up (the PM notification says
 * "no vendor assigned yet").
 */
async function resolveScheduleVendor(
  supabase: ServiceClient,
  schedule: AutoWoSchedule,
  logger:   StepLogger,
): Promise<string | null> {
  let vendorId: string | null = schedule.assigned_vendor_id ?? null

  if (!vendorId && schedule.vendor_specialty_hint) {
    const hintVendorRes = await supabase
      .from('vendors')
      .select('id')
      .eq('org_id', schedule.org_id)
      .eq('specialty', schedule.vendor_specialty_hint)
      .eq('is_active', true)
      .order('avg_rating', { ascending: false })
      .limit(1)
      .maybeSingle()

    // Reported, not thrown, matching this function's documented stance on an
    // unverifiable vendor: an unresolvable one yields an UNASSIGNED work
    // order rather than no work order at all. But discarding the error made
    // "this org has no vendor with that specialty" and "the vendor lookup
    // failed" the same answer, so a schedule with a perfectly good vendor
    // silently produced unassigned WOs with nothing saying why.
    if (hintVendorRes.error) {
      logger.warn(
        `Org ${schedule.org_id}: specialty-hint vendor lookup failed for schedule ${schedule.id} — creating the WO unassigned`,
        { error: hintVendorRes.error.message }
      )
      reportError(hintVendorRes.error, {
        site:  'inngest.work-order-ops-org.auto-create-wo.hint-vendor',
        orgId: schedule.org_id,
        extra: { schedule_id: schedule.id },
      })
    }

    vendorId = hintVendorRes.data?.id ?? null
  }

  if (!vendorId) return null

  try {
    return (await isVendorHardBlocked(supabase, vendorId, schedule.org_id)) ? null : vendorId
  } catch (err) {
    logger.warn(
      `Org ${schedule.org_id}: compliance check failed for vendor ${vendorId} on schedule ${schedule.id} — creating the WO unassigned`,
      { error: err instanceof Error ? err.message : String(err) }
    )
    reportError(err, {
      site:  'inngest.work-order-ops-org.auto-create-wo.compliance-check',
      orgId: schedule.org_id,
      extra: { vendor_id: vendorId, schedule_id: schedule.id },
    })
    return null
  }
}

/**
 * Advances next_due_date for routine schedules. Optimistic-locked on the
 * current next_due_date, same guard dailyMaintenanceScheduleCheck's Pass 1
 * uses — prevents this cron from double-advancing a date the other cron
 * already rolled forward for the same schedule.
 */
async function advanceRoutineSchedule(
  supabase: ServiceClient,
  schedule: AutoWoSchedule,
): Promise<void> {
  if (schedule.schedule_type !== 'routine' || !schedule.frequency) return

  const dueDate = new Date(schedule.next_due_date! + 'T00:00:00')
  const nextDue = calcNextDueDate(schedule.frequency, dueDate)

  // The same advance in the Server Action path (advanceScheduleNextDueDate in
  // app/(dashboard)/maintenance/actions.ts) already binds its error and scopes
  // to the org; this copy did neither. Same table, same column, one fixed and
  // one not.
  //
  // It matters more here, because this runs daily and the failure is silent
  // and permanent: if the advance fails, next_due_date stays put, the schedule
  // is "due" again tomorrow, and the auto-create step's unique constraint on
  // (source_schedule_id, scheduled_date) rejects the duplicate WO with 23505 —
  // which this function treats as the expected race and swallows. So the
  // schedule stops producing work orders entirely, for this occurrence AND
  // every future one, while the cron reports a clean run every day.
  //
  // Zero rows is NOT an error: `.eq('next_due_date', ...)` is an optimistic
  // lock against dailyMaintenanceScheduleCheck's Pass 1 advancing the same
  // schedule first, and losing that race is the designed outcome.
  const { error } = await supabase
    .from('maintenance_schedules')
    .update({ next_due_date: nextDue.toISOString().split('T')[0] })
    .eq('id', schedule.id)
    .eq('org_id', schedule.org_id)
    .eq('next_due_date', schedule.next_due_date!)

  if (error) {
    throw new Error(
      `maintenance_schedules next_due_date advance failed for schedule ${schedule.id}: ${error.message}`
    )
  }
}

/**
 * SCHEDULED: 13:30 UTC daily. Staggered off asset-health (12:30) and
 * maintenance-schedules (13:00) — all three used to fire at 13:00 and
 * stampede Supabase together.
 *
 *  • 7.1 — WO aging escalation: bumps stale open WOs to urgent priority
 *  • 7.4 — auto-WO creation: creates work orders for due maintenance schedules
 *          with auto_create_wo = true
 *
 * DISPATCHER ONLY. The previous shape ran two serial
 * `for (const row of platformWideRows) { await step.run(...) }` loops inside a
 * single invocation: 2 steps per aging WO and up to 3 per auto-WO schedule, so
 * ~2,000+ steps in one run at 150 tenants — past Inngest's per-run ceiling,
 * with memoized-state payload growth on every step, and a single failing
 * tenant retrying the entire tail. Both source `.select()`s were also
 * unbounded, so PostgREST's 1000-row cap was silently hiding the step
 * explosion behind a truncated work list.
 *
 * Now: one `org/work_order_ops.requested` per org (see workOrderOpsOrg below).
 */
export const dailyWorkOrderOps = inngest.createFunction(
  {
    id:      'cron-work-order-ops',
    name:    'Cron: Work Order Aging + Auto-WO',
    retries: 2,
  },
  { cron: '30 13 * * *' },
  async ({ step, logger }) => {
    // Memoized so every derived date is stable across a retry.
    const nowMs = await step.run('capture-now', async () => Date.now())

    const todayStr     = new Date(nowMs).toISOString().split('T')[0]!
    const agingCutoff  = new Date(nowMs - AGING_DAYS * 86_400_000).toISOString()

    const orgIds = await step.run('find-orgs-with-work', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-ops' })

      const silentCutoff = new Date(nowMs - DISPATCH_SILENT_NUDGE_HOURS * 3_600_000).toISOString()

      const [agingOrgs, scheduleOrgs] = await Promise.all([
        fetchDistinctOrgIds(
          (from, to) => supabase
            .from('work_orders')
            .select('org_id')
            .in('status', ['pending', 'assigned', 'in_progress'])
            .neq('priority', 'urgent')
            .lt('updated_at', agingCutoff)
            .order('org_id', { ascending: true })
            .range(from, to),
          { label: 'work_orders(aging).org_id' }
        ),
        fetchDistinctOrgIds(
          (from, to) => supabase
            .from('maintenance_schedules')
            .select('org_id')
            .lte('next_due_date', todayStr)
            .eq('auto_create_wo', true)
            .eq('is_active', true)
            .order('org_id', { ascending: true })
            .range(from, to),
          { label: 'maintenance_schedules(auto-wo).org_id' }
        ),
      ])

      // Orgs holding a dispatch nobody has answered. `vendor_progress IS NULL`
      // is the "no answer yet" test: accepting or declining both write it, so
      // this set empties itself the moment the vendor responds.
      //
      // SEQUENTIAL, not folded into the Promise.all above, because it is the
      // SECOND paginated scan of work_orders. Running two of those at once
      // doubles this dispatcher's peak connection usage against the largest
      // table in the schema, and connection usage under fan-out is exactly
      // what the concurrency caps on this function exist to hold down. One
      // extra round trip, once a day, is the cheaper side of that trade.
      const silentOrgs = await fetchDistinctOrgIds(
        (from, to) => supabase
          .from('work_orders')
          .select('org_id')
          .not('vendor_id', 'is', null)
          .is('vendor_progress', null)
          .not('vendor_dispatched_at', 'is', null)
          .lt('vendor_dispatched_at', silentCutoff)
          .in('status', ['pending', 'assigned', 'quote_requested'])
          .order('org_id', { ascending: true })
          .range(from, to),
        { label: 'work_orders(dispatch-silent).org_id' }
      )

      return Array.from(new Set([...agingOrgs, ...scheduleOrgs, ...silentOrgs]))
    })

    logger.info(`Work order ops: dispatching ${orgIds.length} org(s)`)

    if (orgIds.length) {
      await step.sendEvent(
        'fan-out-work-order-ops',
        orgIds.map((orgId) => ({
          name: 'org/work_order_ops.requested' as const,
          data: { org_id: orgId, now_ms: nowMs },
        }))
      )
    }

    // ── Webhook inbox TTL cleanup ─────────────────────────────────────────────
    // Platform-level, single bounded DELETE — stays in the dispatcher.
    await step.run('cleanup-webhook-inbox', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-ops' })
      const { error } = await supabase
        .from('processed_webhooks')
        .delete()
        .lt('processed_at', new Date(nowMs - 72 * 60 * 60 * 1000).toISOString())

      if (error) {
        throwIfAnyQueryFailed({ site: 'inngest.work-order-ops.cleanup-webhook-inbox' }, error)
      }
    })

    return { dispatched: orgIds.length, webhook_inbox_cleaned: true }
  }
)

/**
 * Per-org work order ops. One invocation = one tenant.
 *
 * Aging escalation is fully batched (one UPDATE, one INSERT, one batched audit
 * write, one sendEvent) rather than 2 steps per WO. Auto-WO creation keeps a
 * step per schedule — each iteration resolves a different vendor and creates a
 * different row, and the count is bounded by "schedules coming due for one org
 * today", which is single digits in practice.
 */
export const workOrderOpsOrg = inngest.createFunction(
  {
    id:          'work-order-ops-org',
    name:        'Work Order Ops — per org',
    retries:     2,
    concurrency: { limit: 10 },
  },
  { event: 'org/work_order_ops.requested' },
  async ({ event, step, logger }) => {
    const orgId = event.data.org_id
    const nowMs = event.data.now_ms
    const today = new Date(nowMs)
    const todayStr = today.toISOString().split('T')[0]!

    // Runs BEFORE the aging escalation below. The two passes are independent
    // (one reads vendor_dispatched_at, the other writes priority), so the order
    // is a free choice, and putting the read-only pass first keeps its scan off
    // the row locks the escalation's bulk UPDATE takes.
    // ── Dispatch silence ─────────────────────────────────────────────────────
    //
    // A work order sent to a vendor who has neither accepted nor declined.
    // Keyed on vendor_dispatched_at and a NULL vendor_progress rather than on
    // updated_at, so nothing anybody does to the row resets the clock — only
    // an actual answer does, because accepting and declining both write
    // vendor_progress. See the constants' comment for why the aging
    // escalation above cannot serve this purpose.
    const silent = await step.run('find-silent-dispatches', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-ops' })
      const nudgeCutoff = new Date(nowMs - DISPATCH_SILENT_NUDGE_HOURS * 3_600_000).toISOString()

      const rows = await fetchAllRows<{
        id: string; wo_number: string | null; title: string; property_id: string
        category: Enums<'wo_category'> | null
        vendor_dispatched_at: string
        vendors: { name: string } | { name: string }[] | null
      }>(
        (from, to) => supabase
          .from('work_orders')
          .select('id, wo_number, title, property_id, category, vendor_dispatched_at, vendors(name)')
          .eq('org_id', orgId)
          .not('vendor_id', 'is', null)
          .is('vendor_progress', null)
          .not('vendor_dispatched_at', 'is', null)
          .lt('vendor_dispatched_at', nudgeCutoff)
          .in('status', ['pending', 'assigned', 'quote_requested'])
          .order('id', { ascending: true })
          .range(from, to),
        { label: `work_orders(dispatch-silent)[org=${orgId}]` }
      )

      const rerouteCutoffMs = nowMs - DISPATCH_SILENT_REROUTE_HOURS * 3_600_000

      return rows.map((wo) => ({
        id:          wo.id,
        label:       wo.wo_number ?? wo.title,
        propertyId:  wo.property_id,
        category:    wo.category,
        vendorName:  unwrapJoin(wo.vendors)?.name ?? 'The vendor',
        hoursSilent: Math.floor((nowMs - new Date(wo.vendor_dispatched_at).getTime()) / 3_600_000),
        reroute:     new Date(wo.vendor_dispatched_at).getTime() < rerouteCutoffMs,
      }))
    })

    if (silent.length) {
      await step.run('notify-silent-dispatches', async () => {
        const supabase = createServiceClient({ system: 'inngest:work-order-ops' })

        // Batched, and dedupe-keyed on the work order plus the THRESHOLD
        // crossed, so the 24h nudge fires once and the 72h one fires once more
        // rather than the same alert every day the vendor stays quiet.
        await createPmNotifications(supabase, silent.map((wo) => ({
          orgId:    orgId,
          type:     'work_order.dispatch_silent',
          title:    wo.reroute
            ? `${wo.vendorName} still has not answered`
            : `${wo.vendorName} has not answered yet`,
          subtitle: `${wo.label}: no response after ${wo.hoursSilent} hours.`
                  + (wo.reroute ? ' A suggested alternative is on the work order.' : ''),
          href:     `/maintenance/${wo.id}`,
          severity: wo.reroute ? 'red' as const : 'amber' as const,
          dedupeKey: `dispatch_silent:${wo.id}:${wo.reroute ? '72h' : '24h'}`,
        })))
      })

      // Past the reroute threshold, ask the EXISTING scorer for an alternative.
      // A suggestion only: nothing here reassigns the work order, for the same
      // reason the decline handler does not — vendors are suggest-only until
      // the planned vendor-Autopilot work lands, and an unattended cron is the
      // last place to cross that line.
      //
      // At the function's TOP LEVEL, not inside the step above: step tooling
      // nested in a step callback unwinds the request to schedule the inner op
      // and leaves the enclosing step unresolved, replaying the notification
      // insert on the next pass.
      const toReroute = silent.filter((wo) => wo.reroute && wo.category !== null)
      if (toReroute.length) {
        await step.sendEvent(
          'request-alternatives-for-silent-dispatches',
          toReroute.map((wo) => ({
            name: 'work-order/vendor-suggestion.requested' as const,
            data: {
              work_order_id: wo.id,
              property_id:   wo.propertyId,
              org_id:        orgId,
              category:      wo.category!,
            },
          })),
        )
      }
    }

    // ── 7.1: WO Aging Escalation (batched) ───────────────────────────────────
    const escalated = await step.run('escalate-aging-work-orders', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-ops' })
      const agingCutoff = new Date(nowMs - AGING_DAYS * 86_400_000).toISOString()

      const agingWOs = await fetchAllRows<{
        id: string; org_id: string; property_id: string
        status: Enums<'wo_status'>; created_at: string
      }>(
        (from, to) => supabase
          .from('work_orders')
          .select('id, org_id, property_id, status, created_at')
          .eq('org_id', orgId)
          .in('status', ['pending', 'assigned', 'in_progress'])
          .neq('priority', 'urgent')
          .lt('updated_at', agingCutoff)
          .order('id', { ascending: true })
          .range(from, to),
        { label: `work_orders(aging)[org=${orgId}]` }
      )

      if (!agingWOs.length) return []

      // Optimistic-locked bulk update: `.neq('priority', 'urgent')` means a
      // retry of this step matches zero rows (they are already urgent), so the
      // work_order_updates notes below are never written twice.
      // CHUNKED because the RETURNING clause is capped too. `.select('id')` on
      // an UPDATE is a PostgREST response like any other, so max_rows = 1000
      // truncates it — silently, with a 200. With a >1000-row backlog the
      // UPDATE correctly escalated every row, but only the first 1000 came
      // back, so `changed` was short and the work_order_updates notes (and the
      // count this step reports, which the daily wrap-up digest reads) covered
      // a fraction of what actually changed. The write was right and the
      // record of it was wrong, which is the harder version to notice.
      const UPDATE_RETURNING_CHUNK = 500
      const updatedIds = new Set<string>()

      for (let i = 0; i < agingWOs.length; i += UPDATE_RETURNING_CHUNK) {
        const chunk = agingWOs.slice(i, i + UPDATE_RETURNING_CHUNK)
        const { data: updatedRows, error: updateError } = await supabase
          .from('work_orders')
          .update({ priority: 'urgent' })
          .in('id', chunk.map((wo) => wo.id))
          .neq('priority', 'urgent')
          .select('id')

        if (updateError) throw new Error(`Failed to escalate aging WOs: ${updateError.message}`)

        for (const r of updatedRows ?? []) updatedIds.add(r.id)
      }
      const changed    = agingWOs.filter((wo) => updatedIds.has(wo.id))
      if (!changed.length) return []

      const daysOpenFor = (wo: { created_at: string }) =>
        Math.round((nowMs - new Date(wo.created_at).getTime()) / 86_400_000)

      // PM-facing escalation alert is cron-daily-wrapup's escalations digest
      // section, which reads exactly this work_order_updates note.
      const { error: notesError } = await supabase.from('work_order_updates').insert(
        changed.map((wo) => {
          const daysOpen = daysOpenFor(wo)
          return {
            work_order_id:             wo.id,
            org_id:                    wo.org_id,
            updated_via_vendor_portal: false,
            status_from:               wo.status,
            status_to:                 wo.status,
            notes:                     `Priority auto-escalated to Urgent, open for ${daysOpen} day${daysOpen !== 1 ? 's' : ''} without update`,
          }
        })
      )
      if (notesError) throw new Error(`Failed to record escalation notes: ${notesError.message}`)

      await logAuditEvents(
        changed.map((wo) => ({
          orgId:      wo.org_id,
          action:     'work_order.updated' as const,
          targetType: 'work_order',
          targetId:   wo.id,
          metadata:   { change: 'auto_escalated_to_urgent' },
        }))
      )

      return changed.map((wo) => ({
        work_order_id: wo.id,
        org_id:        wo.org_id,
        property_id:   wo.property_id,
        days_open:     daysOpenFor(wo),
        new_priority:  'urgent' as const,
      }))
    })

    if (escalated.length) {
      await step.sendEvent(
        'send-escalation-events',
        escalated.map((data) => ({ name: 'work-order/aging-escalated' as const, data }))
      )
    }

    // ── 7.4: Auto-create WOs for due maintenance schedules ───────────────────
    const autoWOSchedules = await step.run('find-auto-wo-schedules', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-ops' })
      return fetchAllRows<AutoWoSchedule>(
        (from, to) => supabase
          .from('maintenance_schedules')
          .select(`
            id, name, org_id, property_id, next_due_date,
            frequency, schedule_type, assigned_vendor_id,
            vendor_specialty_hint, estimated_cost, instructions,
            properties ( name )
          `)
          .eq('org_id', orgId)
          .lte('next_due_date', todayStr)
          .eq('auto_create_wo', true)
          .eq('is_active', true)
          .order('id', { ascending: true })
          .range(from, to),
        { label: `maintenance_schedules(auto-wo)[org=${orgId}]` }
      )
    })

    // ONE batched idempotency read for the whole set, replacing the
    // per-schedule pre-check that used to live inside each step.
    //
    // `next_due_date <= today` includes every schedule the org has ever let go
    // overdue, and that set does not self-clear: nothing advances an
    // already-overdue schedule past today (this pass returns early the moment
    // its pre-check finds the work order, before advanceRoutineSchedule, and
    // maintenance-schedules' own overdue pass never advances at all), and
    // advanceSchedulesAfterCompletion advances routine schedules only. So a
    // seasonal or one-time schedule that slipped once sits here forever,
    // costing an Inngest step and a round-trip every single day to rediscover
    // that its work order already exists.
    //
    // "Any work order at that date" is the correct question, and a strictly
    // better one than the old pre-check's "any OPEN work order":
    // wo_maintenance_schedule_date_unique ignores status, so a COMPLETED work
    // order at that date made the insert below a guaranteed 23505 — swallowed
    // as the expected race, returning null, having spent the step anyway.
    const pendingSchedules = await step.run('filter-auto-wo-schedules', async () => {
      if (!autoWOSchedules.length) return []
      const supabase = createServiceClient({ system: 'inngest:work-order-ops' })
      const existing = await loadExistingDueDatePairs(supabase, orgId, autoWOSchedules)
      return autoWOSchedules.filter((s) => !existing.has(dueKey(s.id, s.next_due_date!)))
    })

    logger.info(
      `Org ${orgId}: ${escalated.length} WO(s) escalated, ${pendingSchedules.length} of ` +
      `${autoWOSchedules.length} auto-WO schedule(s) still need a work order`
    )

    for (const schedule of pendingSchedules) {
      const autoCreateEventData = await step.run(`auto-create-wo-${schedule.id}`, async () => {
        const supabase = createServiceClient({ system: 'inngest:work-order-ops' })
        const property = unwrapJoin(schedule.properties)

        // Assigned → specialty hint → nobody, with the compliance gate applied.
        const vendorId = await resolveScheduleVendor(supabase, schedule, logger)

        // vendor_specialty_hint values are a subset of WoCategory — the
        // closest thing a maintenance schedule has to a WO category, and
        // needed for vendor suggestions to have anything to match a
        // vendor's specialty against when this chain doesn't resolve one.
        const category = schedule.vendor_specialty_hint ?? null

        const { data: wo, error: insertError } = await supabase
          .from('work_orders')
          .insert({
            property_id:        schedule.property_id,
            org_id:             schedule.org_id,
            vendor_id:          vendorId,
            category,
            title:              schedule.name,
            description:        schedule.instructions,
            priority:           'medium',
            status:             'pending',
            source:             'maintenance_schedule',
            source_schedule_id: schedule.id,
            scheduled_date:     schedule.next_due_date,
            estimated_cost:     schedule.estimated_cost,
            portal_enabled:     false,
          })
          .select('id')
          .single()

        if (insertError) {
          // 23505 = unique_violation on wo_maintenance_schedule_date_unique
          // (source_schedule_id, scheduled_date) WHERE source='maintenance_schedule' —
          // dailyMaintenanceScheduleCheck's Pass 1 races this same schedule+date.
          // The DB constraint is the real guard against a duplicate WO; losing
          // this race is expected, not an error — any other error code is real
          // and should retry the step.
          if (insertError.code !== '23505') throw new Error(`Failed to insert auto-created WO: ${insertError.message}`)
          return null
        }

        await advanceRoutineSchedule(supabase, schedule)

        if (!wo) return null

        await logAuditEvent({
          orgId:      schedule.org_id,
          action:     'work_order.created',
          targetType: 'work_order',
          targetId:   wo.id,
          metadata:   { source: 'maintenance_schedule', maintenance_schedule_id: schedule.id },
        })

        // Bell notification (not the removed PM alert email) — required here
        // because portal_enabled is always false for this path, so
        // handleWorkOrderCreated's own notify-pm step never runs for these WOs
        // (it's gated on portal_enabled), and cron-daily-wrapup's unassigned-WO
        // section filters vendor_id IS NULL — which this WO may not satisfy if
        // the assigned_vendor_id/specialty-hint chain above resolved one.
        await createPmNotification(supabase, {
          orgId:     schedule.org_id,
          type:      'work_order_created',
          title:     `Work order auto-created: ${schedule.name}`,
          subtitle:  `${property?.name ?? 'Property'}${vendorId ? '' : ', no vendor assigned yet'}`,
          href:      `/maintenance/${wo.id}`,
          severity:  'blue',
          dedupeKey: `auto-wo-created-${schedule.id}-${schedule.next_due_date}`,
        })

        return {
          work_order_id:  wo.id,
          property_id:    schedule.property_id,
          org_id:         schedule.org_id,
          vendor_id:      vendorId,
          portal_enabled: false,
          category,
        }
      })

      if (autoCreateEventData) {
        await step.sendEvent(`send-auto-create-event-${schedule.id}`, {
          name: 'work-order/created' as const,
          data: autoCreateEventData,
        })

        if (!autoCreateEventData.vendor_id && autoCreateEventData.category) {
          await step.sendEvent(`send-vendor-suggestion-event-${schedule.id}`, {
            name: 'work-order/vendor-suggestion.requested' as const,
            data: {
              work_order_id: autoCreateEventData.work_order_id,
              property_id:   autoCreateEventData.property_id,
              org_id:        autoCreateEventData.org_id,
              category:      autoCreateEventData.category,
            },
          })
        }
      }
    }

    return {
      org_id:             orgId,
      aging_escalated:    escalated.length,
      dispatch_silent:    silent.length,
      auto_wos_attempted: pendingSchedules.length,
    }
  }
)
