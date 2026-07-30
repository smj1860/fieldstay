import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { calcNextDueDate } from '@/lib/turnovers/generator'
import { logAuditEvent, logAuditEvents } from '@/lib/audit'
import { createPmNotification } from '@/lib/inngest/helpers'
import { isVendorHardBlocked } from '@/lib/vendors/compliance'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { fetchAllRows, fetchDistinctOrgIds } from '@/lib/inngest/paginate'

const AGING_DAYS = 7

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

      return Array.from(new Set([...agingOrgs, ...scheduleOrgs]))
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
      await supabase
        .from('processed_webhooks')
        .delete()
        .lt('processed_at', new Date(nowMs - 72 * 60 * 60 * 1000).toISOString())
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

    // ── 7.1: WO Aging Escalation (batched) ───────────────────────────────────
    const escalated = await step.run('escalate-aging-work-orders', async () => {
      const supabase = createServiceClient({ system: 'inngest:work-order-ops' })
      const agingCutoff = new Date(nowMs - AGING_DAYS * 86_400_000).toISOString()

      const agingWOs = await fetchAllRows<{
        id: string; org_id: string; property_id: string
        status: string; created_at: string
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
      const { data: updatedRows, error: updateError } = await supabase
        .from('work_orders')
        .update({ priority: 'urgent' })
        .in('id', agingWOs.map((wo) => wo.id))
        .neq('priority', 'urgent')
        .select('id')

      if (updateError) throw new Error(`Failed to escalate aging WOs: ${updateError.message}`)

      const updatedIds = new Set((updatedRows ?? []).map((r) => r.id))
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
            notes:                     `Priority auto-escalated to Urgent — open for ${daysOpen} day${daysOpen !== 1 ? 's' : ''} without update`,
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
      return fetchAllRows<{
        id: string; name: string; org_id: string; property_id: string
        next_due_date: string | null; frequency: string | null; schedule_type: string | null
        assigned_vendor_id: string | null; vendor_specialty_hint: string | null
        estimated_cost: number | null; instructions: string | null
        properties: { name: string } | { name: string }[] | null
      }>(
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

    logger.info(`Org ${orgId}: ${escalated.length} WO(s) escalated, ${autoWOSchedules.length} schedule(s) eligible for auto-WO`)

    for (const schedule of autoWOSchedules) {
      const autoCreateEventData = await step.run(`auto-create-wo-${schedule.id}`, async () => {
        const supabase = createServiceClient({ system: 'inngest:work-order-ops' })
        const property = unwrapJoin(schedule.properties)

        // Idempotency: skip if an open WO already exists for this schedule + date
        const { data: existingWO } = await supabase
          .from('work_orders')
          .select('id')
          .eq('org_id', orgId)
          .eq('source_schedule_id', schedule.id)
          .eq('scheduled_date', schedule.next_due_date!)
          .not('status', 'in', '("completed","cancelled")')
          .maybeSingle()

        if (existingWO) return null

        // Vendor selection chain: assigned → specialty hint → null
        let vendorId: string | null = schedule.assigned_vendor_id ?? null

        if (!vendorId && schedule.vendor_specialty_hint) {
          const { data: hintVendor } = await supabase
            .from('vendors')
            .select('id')
            .eq('org_id', schedule.org_id)
            .eq('specialty', schedule.vendor_specialty_hint)
            .eq('is_active', true)
            .order('avg_rating', { ascending: false })
            .limit(1)
            .maybeSingle()

          vendorId = hintVendor?.id ?? null
        }

        // A hard-blocked assigned/specialty-hint vendor is not a valid
        // resolution — fall through as if the chain found no vendor so this
        // unattended cron never silently assigns someone 31+ days out of
        // compliance (see lib/vendors/compliance.ts).
        if (vendorId && await isVendorHardBlocked(supabase, vendorId, schedule.org_id)) {
          vendorId = null
        }

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

        // Advance next_due_date for routine schedules. Optimistic-locked on the
        // current next_due_date, same guard dailyMaintenanceScheduleCheck's Pass 1
        // uses — prevents this cron from double-advancing a date the other cron
        // already rolled forward for the same schedule.
        if (schedule.schedule_type === 'routine' && schedule.frequency) {
          const dueDate = new Date(schedule.next_due_date! + 'T00:00:00')
          const nextDue = calcNextDueDate(schedule.frequency, dueDate)
          await supabase
            .from('maintenance_schedules')
            .update({ next_due_date: nextDue.toISOString().split('T')[0] })
            .eq('id', schedule.id)
            .eq('next_due_date', schedule.next_due_date!)
        }

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
          title:     `Work order auto-created — ${schedule.name}`,
          subtitle:  `${property?.name ?? 'Property'}${vendorId ? '' : ' — no vendor assigned yet'}`,
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
      auto_wos_attempted: autoWOSchedules.length,
    }
  }
)
