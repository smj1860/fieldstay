import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { calcNextDueDate } from '@/lib/turnovers/generator'
import { logAuditEvent } from '@/lib/audit'
import { createPmNotification } from '@/lib/inngest/helpers'

/**
 * SCHEDULED: runs every morning at 8am CT (independent of maintenance-schedules cron).
 *
 *  • 7.1 — WO aging escalation: bumps stale open WOs to urgent priority
 *  • 7.4 — auto-WO creation: creates work orders for due maintenance schedules with auto_create_wo = true
 *
 * 7.2 (repeat issue detection) was removed entirely — see the comment at its
 * old call site. The aging-escalation email is covered by cron-daily-wrapup's
 * daily digest instead. The 7.4 auto-created-WO email was replaced with a
 * direct bell notification (not left to the digest) — these WOs always have
 * portal_enabled=false, so handleWorkOrderCreated's own notify step never
 * runs for them, and they may not be vendor_id-null either (assigned_vendor_id/
 * specialty-hint chain), so the digest's unassigned-WO section can't be
 * relied on to catch them. This cron's non-email side effects (priority
 * escalation, WO auto-creation, audit logs) are unchanged.
 */
export const dailyWorkOrderOps = inngest.createFunction(
  {
    id:      'cron-work-order-ops',
    name:    'Cron: Work Order Aging + Repeat Issues + Auto-WO',
    retries: 2,
  },
  { cron: '0 13 * * *' },  // same time as maintenance-schedules — they are independent
  async ({ step, logger }) => {
    const today    = new Date()
    const todayStr = today.toISOString().split('T')[0]

    // ── 7.1: WO Aging Escalation ─────────────────────────────────────────────
    const agingWOs = await step.run('find-aging-work-orders', async () => {
      const supabase = createServiceClient()
      const sevenDaysAgo = new Date(today)
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7)

      const { data } = await supabase
        .from('work_orders')
        .select('id, org_id, property_id, category, status, priority, created_at')
        .in('status', ['pending', 'assigned', 'in_progress'])
        .neq('priority', 'urgent')
        .lt('updated_at', sevenDaysAgo.toISOString())

      return data ?? []
    })

    logger.info(`Found ${agingWOs.length} aging work orders to escalate`)

    // ── 7.4 lookup: schedules eligible for auto-WO (fetched early to batch PM emails) ──
    const autoWOSchedules = await step.run('find-auto-wo-schedules', async () => {
      const supabase = createServiceClient()
      const { data } = await supabase
        .from('maintenance_schedules')
        .select(`
          id, name, org_id, property_id, next_due_date,
          frequency, schedule_type, assigned_vendor_id,
          vendor_specialty_hint, estimated_cost, instructions,
          properties ( name )
        `)
        .lte('next_due_date', todayStr)
        .eq('auto_create_wo', true)
        .eq('is_active', true)

      return data ?? []
    })

    logger.info(`Found ${autoWOSchedules.length} schedules eligible for auto-WO creation`)

    for (const wo of agingWOs) {
      const escalationEventData = await step.run(`escalate-aging-wo-${wo.id}`, async () => {
        const supabase = createServiceClient()
        const daysOpen = Math.round((today.getTime() - new Date(wo.created_at).getTime()) / 86_400_000)

        await supabase
          .from('work_orders')
          .update({ priority: 'urgent' })
          .eq('id', wo.id)

        await logAuditEvent({
          orgId:      wo.org_id,
          action:     'work_order.updated',
          targetType: 'work_order',
          targetId:   wo.id,
          metadata:   { change: 'auto_escalated_to_urgent' },
        })

        await supabase.from('work_order_updates').insert({
          work_order_id:             wo.id,
          org_id:                    wo.org_id,
          updated_via_vendor_portal: false,
          status_from:               wo.status,
          status_to:                 wo.status,
          notes:                     `Priority auto-escalated to Urgent — open for ${daysOpen} day${daysOpen !== 1 ? 's' : ''} without update`,
        })

        // PM-facing escalation alert removed — cron-daily-wrapup's
        // escalations digest section reads this work_order_updates note.

        return {
          work_order_id: wo.id,
          org_id:        wo.org_id,
          property_id:   wo.property_id,
          days_open:     daysOpen,
        }
      })

      await step.sendEvent(`send-escalation-event-${wo.id}`, {
        name: 'work-order/aging-escalated' as const,
        data: {
          work_order_id: escalationEventData.work_order_id,
          org_id:        escalationEventData.org_id,
          property_id:   escalationEventData.property_id,
          days_open:     escalationEventData.days_open,
          new_priority:  'urgent',
        },
      })
    }

    // ── 7.2: Repeat Issue Detection ──────────────────────────────────────────
    // Removed entirely — its only purpose was gating the PM alert email on a
    // 30-day re-alert milestone. Nothing else consumed the
    // maintenance/repeat-issue-detected event. cron-daily-wrapup's repeat-issues
    // digest section (3+ same-category WOs per property in 90 days) re-implements
    // the detection independently and simplified, with no 30-day suppression.

    // ── 7.4: Auto-create WOs for due maintenance schedules ───────────────────
    for (const schedule of autoWOSchedules) {
      const autoCreateEventData = await step.run(`auto-create-wo-${schedule.id}`, async () => {
        const supabase = createServiceClient()
        const property = Array.isArray(schedule.properties) ? schedule.properties[0] : schedule.properties

        // Idempotency: skip if an open WO already exists for this schedule + date
        const { data: existingWO } = await supabase
          .from('work_orders')
          .select('id')
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

        // vendor_specialty_hint values are a subset of WoCategory — the
        // closest thing a maintenance schedule has to a WO category, and
        // needed for vendor suggestions to have anything to match a
        // vendor's specialty against when this chain doesn't resolve one.
        const category = schedule.vendor_specialty_hint ?? null

        const { data: wo } = await supabase
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

        // Advance next_due_date for routine schedules
        if (schedule.schedule_type === 'routine' && schedule.frequency) {
          const dueDate = new Date(schedule.next_due_date! + 'T00:00:00')
          const nextDue = calcNextDueDate(schedule.frequency, dueDate)
          await supabase
            .from('maintenance_schedules')
            .update({ next_due_date: nextDue.toISOString().split('T')[0] })
            .eq('id', schedule.id)
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
        // the assigned_vendor_id/specialty-hint chain above resolved one. Without
        // this, a WO auto-created here with a resolved vendor would get zero
        // PM-facing surface at all.
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

    // ── Webhook inbox TTL cleanup ─────────────────────────────────────────────
    // Removes processed_webhooks entries older than 72 hours (all providers).
    // Moved off the webhook hot path — runs once daily here instead.
    await step.run('cleanup-webhook-inbox', async () => {
      const supabase = createServiceClient()
      await supabase
        .from('processed_webhooks')
        .delete()
        .lt('processed_at', new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString())
    })

    return {
      aging_escalated:       agingWOs.length,
      auto_wos_attempted:    autoWOSchedules.length,
      webhook_inbox_cleaned: true,
    }
  }
)
