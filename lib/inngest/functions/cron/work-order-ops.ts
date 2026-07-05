import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM } from '@/lib/resend/client'
import { calcNextDueDate } from '@/lib/turnovers/generator'
import { getPmEmailsByOrgIds } from '@/lib/inngest/helpers'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'

/**
 * SCHEDULED: runs every morning at 8am CT (independent of maintenance-schedules cron).
 *
 *  • 7.1 — WO aging escalation: bumps stale open WOs to urgent priority
 *  • 7.2 — repeat issue detection: alerts PM when 3+ WOs of same category hit a property in 90 days
 *  • 7.4 — auto-WO creation: creates work orders for due maintenance schedules with auto_create_wo = true
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

    // ── Pre-collect org IDs with repeat issues so their PM emails are batched below ──
    const repeatIssueOrgIds = await step.run('find-repeat-issue-org-ids', async () => {
      const supabase = createServiceClient()
      const ninetyDaysAgo = new Date(today)
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

      const { data } = await supabase
        .from('work_orders')
        .select('org_id')
        .neq('status', 'cancelled')
        .gte('created_at', ninetyDaysAgo.toISOString())

      return [...new Set((data ?? []).map((w) => w.org_id))]
    })

    // ── Batch-resolve PM emails for every org touched by aging WOs, auto-WO schedules, or repeat issues ──
    const pmEmailEntries = await step.run('find-pm-emails', async () => {
      const supabase = createServiceClient()
      const orgIds = Array.from(new Set([
        ...agingWOs.map((wo) => wo.org_id),
        ...autoWOSchedules.map((s) => s.org_id),
        ...repeatIssueOrgIds,
      ]))
      const emails = await getPmEmailsByOrgIds(supabase, orgIds)
      return Array.from(emails.entries())
    })
    const pmEmailByOrg = new Map(pmEmailEntries)

    for (const wo of agingWOs) {
      const escalationEventData = await step.run(`escalate-aging-wo-${wo.id}`, async () => {
        const supabase = createServiceClient()
        const daysOpen = Math.round((today.getTime() - new Date(wo.created_at).getTime()) / 86_400_000)

        await supabase
          .from('work_orders')
          .update({ priority: 'urgent' })
          .eq('id', wo.id)

        await supabase.from('work_order_updates').insert({
          work_order_id:             wo.id,
          org_id:                    wo.org_id,
          updated_via_vendor_portal: false,
          status_from:               wo.status,
          status_to:                 wo.status,
          notes:                     `Priority auto-escalated to Urgent — open for ${daysOpen} day${daysOpen !== 1 ? 's' : ''} without update`,
        })

        const pmEmail = pmEmailByOrg.get(wo.org_id) ?? null
        if (pmEmail) {
          await resend.emails.send({
            from:    FROM,
            to:      pmEmail,
            subject: `Work order escalated to Urgent — open ${daysOpen} days`,
            html:    await renderPmAlert({
              heading:  'Work order auto-escalated to Urgent',
              body:     `${(wo.category ?? 'Work order').replace(/_/g, ' ')} has been open for ${daysOpen} day${daysOpen !== 1 ? 's' : ''} without an update and was auto-escalated to Urgent priority.`,
              details: [
                { label: 'Opened', value: new Date(wo.created_at).toLocaleDateString() },
              ],
              ctaLabel: 'Review Work Order →',
              ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/work-orders`,
            }),
          })
        }

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
    const repeatGroupsToAlert = await step.run('detect-repeat-issues', async () => {
      const supabase = createServiceClient()
      const ninetyDaysAgo = new Date(today)
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

      const { data: wos } = await supabase
        .from('work_orders')
        .select('id, org_id, property_id, category')
        .neq('status', 'cancelled')
        .not('category', 'is', null)
        .gte('created_at', ninetyDaysAgo.toISOString())

      const groups: Record<string, { org_id: string; property_id: string; category: string; count: number }> = {}
      for (const wo of wos ?? []) {
        const key = `${wo.org_id}:${wo.property_id}:${wo.category}`
        if (!groups[key]) {
          groups[key] = { org_id: wo.org_id, property_id: wo.property_id, category: wo.category, count: 0 }
        }
        groups[key]!.count++
      }

      const repeatGroups = Object.values(groups).filter((g) => g.count >= 3)
      const thirtyDaysAgo = new Date(today.getTime() - 30 * 86_400_000)
      const toAlert: typeof repeatGroups = []

      for (const group of repeatGroups) {
        const milestoneKey = `repeat_issue:${group.property_id}:${group.category}`

        const { data: existing } = await supabase
          .from('org_milestones')
          .select('created_at')
          .eq('org_id', group.org_id)
          .eq('milestone', milestoneKey)
          .maybeSingle()

        if (existing && new Date(existing.created_at) > thirtyDaysAgo) continue

        const pmEmail = pmEmailByOrg.get(group.org_id) ?? null
        if (pmEmail) {
          await resend.emails.send({
            from:    FROM,
            to:      pmEmail,
            subject: `Repeat maintenance issue — ${(group.category ?? '').replace(/_/g, ' ')} (${group.count}x in 90 days)`,
            html:    await renderPmAlert({
              heading:  'Repeat maintenance issue detected',
              body:     `${(group.category ?? '').replace(/_/g, ' ')} has come up ${group.count} times in the last 90 days at this property — this may indicate a recurring problem worth investigating.`,
              details: [
                { label: 'Work Orders', value: `${group.count} in the last 90 days` },
              ],
              ctaLabel: 'View Work Orders →',
              ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/work-orders`,
            }),
          })
        }

        // Reset milestone timestamp so we re-alert after 30 days
        await supabase.from('org_milestones')
          .delete()
          .eq('org_id', group.org_id)
          .eq('milestone', milestoneKey)
        await supabase.from('org_milestones')
          .insert({ org_id: group.org_id, milestone: milestoneKey })

        toAlert.push(group)
      }

      return toAlert
    })

    for (const group of repeatGroupsToAlert) {
      await step.sendEvent(`send-repeat-issue-event-${group.org_id}-${group.property_id}-${group.category}`, {
        name: 'maintenance/repeat-issue-detected' as const,
        data: {
          org_id:      group.org_id,
          property_id: group.property_id,
          wo_category: group.category,
          count:       group.count,
          window_days: 90,
        },
      })
    }

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

        const { data: wo } = await supabase
          .from('work_orders')
          .insert({
            property_id:        schedule.property_id,
            org_id:             schedule.org_id,
            vendor_id:          vendorId,
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

        const pmEmail = pmEmailByOrg.get(schedule.org_id) ?? null
        if (pmEmail) {
          await resend.emails.send({
            from:    FROM,
            to:      pmEmail,
            subject: `Work order auto-created — ${schedule.name} at ${property?.name}`,
            html:    await renderPmAlert({
              heading:  'Scheduled maintenance work order created',
              body:     `${schedule.name} is due today — a work order has been created.`,
              details: [
                { label: 'Property',  value: property?.name ?? null },
                { label: 'Due Date',  value: new Date(schedule.next_due_date! + 'T00:00:00').toLocaleDateString() },
                { label: 'Est. Cost', value: schedule.estimated_cost ? `$${schedule.estimated_cost}` : null },
              ],
              ctaLabel: 'View Work Order →',
              ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/work-orders`,
            }),
          })
        }

        return {
          work_order_id:  wo.id,
          property_id:    schedule.property_id,
          org_id:         schedule.org_id,
          vendor_id:      vendorId,
          portal_enabled: false,
        }
      })

      if (autoCreateEventData) {
        await step.sendEvent(`send-auto-create-event-${schedule.id}`, {
          name: 'work-order/created' as const,
          data: autoCreateEventData,
        })
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
