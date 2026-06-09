import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM } from '@/lib/resend/client'
import { calcNextDueDate } from '@/lib/turnovers/generator'
import { calculateHealthScore } from '@/lib/assets/health-score'
import { getPmEmail } from '@/lib/inngest/helpers'

const ALERT_WINDOW_DAYS  = 7   // alert PM when schedule due within 7 days
const ESCALATE_DAYS_PAST = 3   // escalate when schedule is 3+ days overdue

/**
 * SCHEDULED: runs every morning at 8am CT.
 *
 * Pass 1 — due-soon: schedules due within ALERT_WINDOW_DAYS
 *   • auto_create_wo = true  → create WO + notify PM
 *   • auto_create_wo = false → alert email
 *
 * Pass 2 — overdue escalation: schedules past their due date
 *   • If an open WO exists for the schedule → bump priority to urgent
 *   • If no WO exists → create one (regardless of auto_create_wo) + alert PM
 */
export const dailyMaintenanceCheck = inngest.createFunction(
  {
    id:   'maintenance-daily-check',
    name: 'Daily Maintenance Check',
  },
  { cron: '0 13 * * *' },  // 8am CT (UTC-5)
  async ({ step, logger }) => {
    const supabase  = createServiceClient()
    const today     = new Date()
    const todayStr  = today.toISOString().split('T')[0]

    const alertDate = new Date(today)
    alertDate.setDate(alertDate.getDate() + ALERT_WINDOW_DAYS)

    // ── Pass 1: Due-soon schedules ─────────────────────────────────────────
    const dueSchedules = await step.run('find-due-schedules', async () => {
      const { data } = await supabase
        .from('maintenance_schedules')
        .select(`
          id, name, schedule_type, frequency, estimated_cost,
          instructions, auto_create_wo, next_due_date,
          assigned_vendor_id, property_id, org_id,
          properties ( name, city, state ),
          vendors ( id, name, email, portal_enabled )
        `)
        .eq('is_active', true)
        .lte('next_due_date', alertDate.toISOString().split('T')[0])
        .gte('next_due_date', todayStr)

      return data ?? []
    })

    logger.info(`Found ${dueSchedules.length} schedules due within ${ALERT_WINDOW_DAYS} days`)

    for (const schedule of dueSchedules) {
      await step.run(`process-schedule-${schedule.id}`, async () => {
        const property = Array.isArray(schedule.properties) ? schedule.properties[0] : schedule.properties
        const vendor   = Array.isArray(schedule.vendors)   ? schedule.vendors[0]   : schedule.vendors

        const dueDate      = new Date(schedule.next_due_date!)
        const daysUntilDue = Math.round((dueDate.getTime() - today.getTime()) / 86_400_000)

        const pmEmail = await getPmEmail(supabase, schedule.org_id)

        if (schedule.auto_create_wo) {
          // Idempotency: skip if a non-terminal WO already exists for this schedule + date
          const { data: existingWO } = await supabase
            .from('work_orders')
            .select('id')
            .eq('source_schedule_id', schedule.id)
            .eq('scheduled_date', schedule.next_due_date!)
            .not('status', 'in', '("completed","cancelled")')
            .maybeSingle()

          const { data: wo } = existingWO ? { data: existingWO } : await supabase
            .from('work_orders')
            .insert({
              property_id:        schedule.property_id,
              org_id:             schedule.org_id,
              vendor_id:          schedule.assigned_vendor_id ?? null,
              title:              schedule.name,
              description:        schedule.instructions,
              priority:           daysUntilDue <= 1 ? 'urgent' : daysUntilDue <= 3 ? 'high' : 'medium',
              status:             'pending',
              source:             'maintenance_schedule',
              source_schedule_id: schedule.id,
              scheduled_date:     schedule.next_due_date,
              estimated_cost:     schedule.estimated_cost,
              portal_enabled:     vendor?.portal_enabled ?? false,
            })
            .select('id')
            .single()

          if (pmEmail && wo && !existingWO) {
            await resend.emails.send({
              from:    FROM,
              to:      pmEmail,
              subject: `Work order created — ${schedule.name} at ${property?.name}`,
              html: buildScheduleEmail({
                heading:  'Scheduled maintenance work order created',
                name:     schedule.name,
                daysText: `due in <strong>${daysUntilDue} day${daysUntilDue !== 1 ? 's' : ''}</strong>`,
                property: property?.name,
                dueDate:  dueDate.toLocaleDateString(),
                cost:     schedule.estimated_cost,
                vendor:   vendor?.name,
                url:      `${process.env.NEXT_PUBLIC_APP_URL}/maintenance`,
                cta:      'View Work Order →',
              }),
            })
          }

          if (wo && vendor?.email && vendor?.portal_enabled) {
            await inngest.send({
              name: 'work-order/created' as const,
              data: {
                work_order_id: wo.id,
                property_id:   schedule.property_id,
                org_id:        schedule.org_id,
                vendor_id:     vendor.id,
                portal_enabled: true,
              },
            })
          }
        } else {
          if (pmEmail) {
            await resend.emails.send({
              from:    FROM,
              to:      pmEmail,
              subject: `🔧 Maintenance due soon — ${schedule.name} at ${property?.name}`,
              html: buildScheduleEmail({
                heading:  'Scheduled maintenance coming up',
                name:     schedule.name,
                daysText: `due in <strong>${daysUntilDue} day${daysUntilDue !== 1 ? 's' : ''}</strong>`,
                property: property?.name,
                dueDate:  dueDate.toLocaleDateString(),
                cost:     schedule.estimated_cost,
                vendor:   vendor?.name,
                url:      `${process.env.NEXT_PUBLIC_APP_URL}/maintenance`,
                cta:      'Create Work Order →',
              }),
            })
          }
        }

        // Advance next_due_date for routine schedules
        if (schedule.schedule_type === 'routine' && schedule.frequency) {
          const nextDue = calcNextDueDate(schedule.frequency, dueDate)
          await supabase
            .from('maintenance_schedules')
            .update({ next_due_date: nextDue.toISOString().split('T')[0] })
            .eq('id', schedule.id)
        }
      })
    }

    // ── Pass 2: Overdue escalation ─────────────────────────────────────────
    const escalateBefore = new Date(today)
    escalateBefore.setDate(escalateBefore.getDate() - ESCALATE_DAYS_PAST)

    const overdueSchedules = await step.run('find-overdue-schedules', async () => {
      const { data } = await supabase
        .from('maintenance_schedules')
        .select(`
          id, name, estimated_cost, next_due_date,
          assigned_vendor_id, property_id, org_id,
          properties ( name ),
          vendors ( name )
        `)
        .eq('is_active', true)
        .lt('next_due_date', todayStr)  // past due date

      return data ?? []
    })

    logger.info(`Found ${overdueSchedules.length} overdue schedules`)

    for (const schedule of overdueSchedules) {
      await step.run(`escalate-overdue-${schedule.id}`, async () => {
        const property = Array.isArray(schedule.properties) ? schedule.properties[0] : schedule.properties
        const vendor   = Array.isArray(schedule.vendors)   ? schedule.vendors[0]   : schedule.vendors
        const dueDate  = new Date(schedule.next_due_date!)
        const daysLate = Math.round((today.getTime() - dueDate.getTime()) / 86_400_000)

        // Look for an open WO tied to this schedule
        const { data: openWO } = await supabase
          .from('work_orders')
          .select('id, priority, status')
          .eq('source_schedule_id', schedule.id)
          .not('status', 'in', '("completed","cancelled")')
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()

        const pmEmail = await getPmEmail(supabase, schedule.org_id)

        if (openWO) {
          // Escalate existing WO priority to urgent if not already
          if (openWO.priority !== 'urgent') {
            await supabase
              .from('work_orders')
              .update({ priority: 'urgent' })
              .eq('id', openWO.id)

            await supabase.from('work_order_updates').insert({
              work_order_id:             openWO.id,
              org_id:                    schedule.org_id,
              updated_via_vendor_portal: false,
              status_from:               openWO.status,
              status_to:                 openWO.status,
              notes:                     `Priority auto-escalated to Urgent — ${daysLate} day${daysLate !== 1 ? 's' : ''} past scheduled date`,
            })
          }

          if (pmEmail) {
            await resend.emails.send({
              from:    FROM,
              to:      pmEmail,
              subject: `🚨 Overdue maintenance escalated — ${schedule.name} at ${property?.name}`,
              html: buildScheduleEmail({
                heading:  `Overdue maintenance escalated to Urgent`,
                name:     schedule.name,
                daysText: `<strong>${daysLate} day${daysLate !== 1 ? 's' : ''} overdue</strong>`,
                property: property?.name,
                dueDate:  dueDate.toLocaleDateString(),
                cost:     schedule.estimated_cost,
                vendor:   vendor?.name,
                url:      `${process.env.NEXT_PUBLIC_APP_URL}/maintenance`,
                cta:      'Review Work Order →',
              }),
            })
          }
        } else {
          // No open WO — create one with urgent priority
          const { data: wo } = await supabase
            .from('work_orders')
            .insert({
              property_id:        schedule.property_id,
              org_id:             schedule.org_id,
              vendor_id:          schedule.assigned_vendor_id ?? null,
              title:              schedule.name,
              description:        `OVERDUE ${daysLate} day${daysLate !== 1 ? 's' : ''}. Original due date: ${dueDate.toLocaleDateString()}`,
              priority:           'urgent',
              status:             'pending',
              source:             'maintenance_schedule',
              source_schedule_id: schedule.id,
              scheduled_date:     schedule.next_due_date,
              estimated_cost:     schedule.estimated_cost,
              portal_enabled:     false,
            })
            .select('id')
            .single()

          if (pmEmail) {
            await resend.emails.send({
              from:    FROM,
              to:      pmEmail,
              subject: `🚨 Overdue maintenance — urgent WO created — ${schedule.name} at ${property?.name}`,
              html: buildScheduleEmail({
                heading:  'Overdue maintenance — urgent work order created',
                name:     schedule.name,
                daysText: `<strong>${daysLate} day${daysLate !== 1 ? 's' : ''} overdue</strong> — marked Urgent`,
                property: property?.name,
                dueDate:  dueDate.toLocaleDateString(),
                cost:     schedule.estimated_cost,
                vendor:   vendor?.name,
                url:      `${process.env.NEXT_PUBLIC_APP_URL}/maintenance`,
                cta:      'Assign Work Order →',
              }),
            })
          }
        }
      })
    }

    // ── Thirty-day milestone ────────────────────────────────────────────────
    await step.run('check-thirty-day-milestone', async () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000).toISOString()
      const { data: orgs } = await supabase
        .from('organizations')
        .select('id')
        .lte('created_at', thirtyDaysAgo)

      for (const org of orgs ?? []) {
        await supabase.from('org_milestones').upsert(
          { org_id: org.id, milestone: 'thirty_days' },
          { onConflict: 'org_id,milestone', ignoreDuplicates: true }
        )
      }
    })

    // ── 7.1: WO Aging Escalation ─────────────────────────────────────────────
    const agingWOs = await step.run('find-aging-work-orders', async () => {
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

    for (const wo of agingWOs) {
      await step.run(`escalate-aging-wo-${wo.id}`, async () => {
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

        await inngest.send({
          name: 'work-order/aging-escalated' as const,
          data: {
            work_order_id: wo.id,
            org_id:        wo.org_id,
            property_id:   wo.property_id,
            days_open:     daysOpen,
            new_priority:  'urgent',
          },
        })

        const pmEmail = await getPmEmail(supabase, wo.org_id)
        if (pmEmail) {
          await resend.emails.send({
            from:    FROM,
            to:      pmEmail,
            subject: `Work order escalated to Urgent — open ${daysOpen} days`,
            html:    buildScheduleEmail({
              heading:  'Work order auto-escalated to Urgent',
              name:     wo.category.replace(/_/g, ' '),
              daysText: `open for <strong>${daysOpen} day${daysOpen !== 1 ? 's' : ''}</strong> without update`,
              dueDate:  `Opened ${new Date(wo.created_at).toLocaleDateString()}`,
              url:      `${process.env.NEXT_PUBLIC_APP_URL}/work-orders`,
              cta:      'Review Work Order →',
            }),
          })
        }
      })
    }

    // ── 7.2: Repeat Issue Detection ──────────────────────────────────────────
    await step.run('detect-repeat-issues', async () => {
      const ninetyDaysAgo = new Date(today)
      ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90)

      // DB-side GROUP BY avoids PostgREST 1000-row silent truncation
      const { data: repeatGroups } = await supabase.rpc('get_repeat_issues', {
        since_date: ninetyDaysAgo.toISOString(),
      }) as { data: Array<{ org_id: string; property_id: string; category: string; wo_count: number }> | null }

      const thirtyDaysAgo = new Date(today.getTime() - 30 * 86_400_000)

      for (const group of repeatGroups ?? []) {
        const milestoneKey = `repeat_issue:${group.property_id}:${group.category}`

        const { data: existing } = await supabase
          .from('org_milestones')
          .select('created_at')
          .eq('org_id', group.org_id)
          .eq('milestone', milestoneKey)
          .maybeSingle()

        if (existing && new Date(existing.created_at) > thirtyDaysAgo) continue

        await inngest.send({
          name: 'maintenance/repeat-issue-detected' as const,
          data: {
            org_id:      group.org_id,
            property_id: group.property_id,
            wo_category: group.category,
            count:       Number(group.wo_count),
            window_days: 90,
          },
        })

        const pmEmail = await getPmEmail(supabase, group.org_id)
        if (pmEmail) {
          await resend.emails.send({
            from:    FROM,
            to:      pmEmail,
            subject: `Repeat maintenance issue — ${group.category.replace(/_/g, ' ')} (${group.wo_count}x in 90 days)`,
            html:    buildScheduleEmail({
              heading:  'Repeat maintenance issue detected',
              name:     group.category.replace(/_/g, ' '),
              daysText: `<strong>${group.wo_count} work orders</strong> in the last 90 days`,
              dueDate:  'Last 90 days',
              url:      `${process.env.NEXT_PUBLIC_APP_URL}/work-orders`,
              cta:      'View Work Orders →',
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
      }
    })

    // ── 7.4: Auto-create WOs for due maintenance schedules ───────────────────
    const autoWOSchedules = await step.run('find-auto-wo-schedules', async () => {
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

    for (const schedule of autoWOSchedules) {
      await step.run(`auto-create-wo-${schedule.id}`, async () => {
        const property = Array.isArray(schedule.properties) ? schedule.properties[0] : schedule.properties

        // Idempotency: skip if an open WO already exists for this schedule + date
        const { data: existingWO } = await supabase
          .from('work_orders')
          .select('id')
          .eq('source_schedule_id', schedule.id)
          .eq('scheduled_date', schedule.next_due_date!)
          .not('status', 'in', '("completed","cancelled")')
          .maybeSingle()

        if (existingWO) return { skipped: true }

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

        if (wo) {
          await inngest.send({
            name: 'work-order/created' as const,
            data: {
              work_order_id:  wo.id,
              property_id:    schedule.property_id,
              org_id:         schedule.org_id,
              vendor_id:      vendorId,
              portal_enabled: false,
            },
          })

          const pmEmail = await getPmEmail(supabase, schedule.org_id)
          if (pmEmail) {
            await resend.emails.send({
              from:    FROM,
              to:      pmEmail,
              subject: `Work order auto-created — ${schedule.name} at ${property?.name}`,
              html:    buildScheduleEmail({
                heading:  'Scheduled maintenance work order created',
                name:     schedule.name,
                daysText: 'due today',
                property: property?.name,
                dueDate:  new Date(schedule.next_due_date! + 'T00:00:00').toLocaleDateString(),
                cost:     schedule.estimated_cost,
                url:      `${process.env.NEXT_PUBLIC_APP_URL}/work-orders`,
                cta:      'View Work Order →',
              }),
            })
          }
        }

        return { created: true, wo_id: wo?.id }
      })
    }

    // ── 8.4: Daily Asset Health Score Recalculation ──────────────────────────
    const activeAssets = await step.run('find-assets-for-scoring', async () => {
      const { data } = await supabase
        .from('property_assets')
        .select(`
          id, org_id, property_id, asset_type,
          installation_date, expected_lifespan_years,
          estimated_replacement_cost, health_score
        `)
        .eq('is_active', true)
      return data ?? []
    })

    logger.info(`Found ${activeAssets.length} active assets to score`)

    if (activeAssets.length > 0) {
      const standards = await step.run('fetch-asset-standards', async () => {
        const { data } = await supabase
          .from('asset_type_standards')
          .select('asset_type, lifespan_min_years, lifespan_max_years, avg_replacement_cost_high')
        return data ?? []
      })

      // DB-side aggregation avoids PostgREST 1000-row silent truncation on busy orgs
      const repairByAsset = await step.run('fetch-asset-repair-history', async () => {
        const { data: rows } = await supabase.rpc('get_asset_repair_summary') as {
          data: Array<{ asset_id: string; total_repairs: number; total_repair_cost: number; last_serviced_at: string | null }> | null
        }
        const map: Record<string, { total_repairs: number; total_repair_cost: number; last_serviced_at: string | null }> = {}
        for (const row of rows ?? []) {
          map[row.asset_id] = {
            total_repairs:     Number(row.total_repairs),
            total_repair_cost: Number(row.total_repair_cost),
            last_serviced_at:  row.last_serviced_at ?? null,
          }
        }
        return map
      })

      // Group assets by org for batched updates + threshold alerts
      const assetsByOrg = activeAssets.reduce<Record<string, typeof activeAssets>>((acc, a) => {
        ;(acc[a.org_id] ??= []).push(a)
        return acc
      }, {})

      for (const [orgId, orgAssets] of Object.entries(assetsByOrg)) {
        await step.run(`score-org-assets-${orgId}`, async () => {
          type Crossing = { asset_type: string; property_id: string; oldScore: number; newScore: number }
          const crossings: Crossing[] = []
          const updates: Array<{ id: string; health_score: number; health_score_updated_at: string }> = []
          const now = new Date().toISOString()

          for (const asset of orgAssets) {
            const std = standards.find((s) => s.asset_type === asset.asset_type)
            if (!std) continue

            const repair = repairByAsset[asset.id] ?? {
              total_repairs: 0, total_repair_cost: 0, last_serviced_at: null,
            }

            const newScore = calculateHealthScore(
              {
                installation_date:          asset.installation_date,
                expected_lifespan_years:    asset.expected_lifespan_years,
                estimated_replacement_cost: asset.estimated_replacement_cost,
              },
              std,
              repair
            )

            updates.push({ id: asset.id, health_score: newScore, health_score_updated_at: now })

            // 8.5: detect threshold crossings (old > threshold >= new)
            const oldScore = asset.health_score
            if (oldScore !== null && newScore !== oldScore) {
              for (const threshold of [60, 40, 20]) {
                if (oldScore > threshold && newScore <= threshold) {
                  crossings.push({
                    asset_type:  asset.asset_type,
                    property_id: asset.property_id,
                    oldScore,
                    newScore,
                  })
                  break
                }
              }
            }
          }

          // Batch all score writes into a single round-trip
          if (updates.length > 0) {
            await supabase.from('property_assets').upsert(updates, { onConflict: 'id' })
          }

          if (crossings.length > 0) {
            const pmEmail = await getPmEmail(supabase, orgId)
            if (pmEmail) {
              for (const c of crossings) {
                const label = c.newScore < 20 ? 'Critical' : c.newScore < 40 ? 'Poor' : 'Fair'
                await resend.emails.send({
                  from:    FROM,
                  to:      pmEmail,
                  subject: `Asset health alert — ${c.asset_type.replace(/_/g, ' ')} dropped to ${label}`,
                  html: buildScheduleEmail({
                    heading:  'Asset health score dropped',
                    name:     c.asset_type.replace(/_/g, ' '),
                    daysText: `score dropped from <strong>${c.oldScore}</strong> to <strong>${c.newScore}/100 (${label})</strong>`,
                    dueDate:  'As of today',
                    url:      `${process.env.NEXT_PUBLIC_APP_URL}/properties/${c.property_id}`,
                    cta:      'View Property →',
                  }),
                })
              }
            }
          }
        })
      }
    }

    // ── 8.13: COI & License Expiry Escalation ────────────────────────────────
    // Alert thresholds (days relative to expiry): positive = before, negative = after
    const COMPLIANCE_ALERT_THRESHOLDS = [30, 14, 7, 0, -14, -30]

    const expiringDocs = await step.run('find-expiring-compliance-docs', async () => {
      const { data } = await supabase
        .from('vendor_compliance_documents')
        .select(`
          id, org_id, vendor_id, document_type, document_name, expiry_date,
          vendors ( name )
        `)
        .eq('is_active', true)
        .not('expiry_date', 'is', null)
      return data ?? []
    })

    logger.info(`Checking ${expiringDocs.length} compliance docs for expiry alerts`)

    for (const doc of expiringDocs) {
      if (!doc.expiry_date) continue

      const daysUntil = Math.floor(
        (new Date(doc.expiry_date).getTime() - today.getTime()) / 86_400_000
      )

      // Find if this doc falls within ±1 day of any alert threshold
      const hitThreshold = COMPLIANCE_ALERT_THRESHOLDS.find(
        (t) => Math.abs(daysUntil - t) <= 1
      )
      if (hitThreshold === undefined) continue

      await step.run(`compliance-alert-${doc.id}-t${hitThreshold}`, async () => {
        const thresholdKey = hitThreshold >= 0
          ? `${hitThreshold}d_before`
          : `${Math.abs(hitThreshold)}d_after`
        const milestoneKey = `compliance_warning:${doc.id}:${thresholdKey}`

        // Dedup: skip if we already sent this threshold alert for this doc
        const { data: existing } = await supabase
          .from('org_milestones')
          .select('id')
          .eq('org_id', doc.org_id)
          .eq('milestone', milestoneKey)
          .maybeSingle()

        if (existing) return { skipped: true }

        const vendor   = Array.isArray(doc.vendors) ? doc.vendors[0] : doc.vendors
        const pmEmail  = await getPmEmail(supabase, doc.org_id)

        // Record dedup FIRST — if email throws and step retries, the milestone
        // guard above prevents a double-send on the next attempt
        await supabase.from('org_milestones').insert({
          org_id:    doc.org_id,
          milestone: milestoneKey,
        })

        if (pmEmail) {
          const isPast  = hitThreshold < 0
          const daysAbs = Math.abs(hitThreshold)
          const daysText = hitThreshold === 0
            ? 'expires <strong>today</strong>'
            : isPast
            ? `expired <strong>${daysAbs} day${daysAbs !== 1 ? 's' : ''} ago</strong>`
            : `expires in <strong>${daysAbs} day${daysAbs !== 1 ? 's' : ''}</strong>`

          const subject = isPast
            ? `⛔ Compliance doc expired — ${vendor?.name} (${daysAbs}d overdue)`
            : hitThreshold === 0
            ? `⚠️ Compliance doc expires TODAY — ${vendor?.name}`
            : `⚠️ Compliance expiring in ${daysAbs}d — ${vendor?.name}`

          await resend.emails.send({
            from:    FROM,
            to:      pmEmail,
            subject,
            html: buildScheduleEmail({
              heading:  isPast ? 'Compliance document expired' : 'Compliance document expiring soon',
              name:     `${doc.document_name} (${doc.document_type.replace(/_/g, ' ')})`,
              daysText,
              vendor:   vendor?.name,
              dueDate:  doc.expiry_date,
              url:      `${process.env.NEXT_PUBLIC_APP_URL}/vendors/${doc.vendor_id}`,
              cta:      'Update Compliance Docs →',
            }),
          })
        }

        return { sent: true, threshold: hitThreshold, vendor: vendor?.name }
      })
    }

    // ── 6.14: Comms Log Retention ────────────────────────────────────────────
    const retentionOrgs = await step.run('find-comms-retention-orgs', async () => {
      const { data } = await supabase
        .from('organizations')
        .select('id, comms_log_retention_days')

      return data ?? []
    })

    let commsSoftDeleted = 0
    let commsHardPurged  = 0

    for (const org of retentionOrgs) {
      await step.run(`comms-log-retention-${org.id}`, async () => {
        // Step A — soft-delete logs older than the retention window
        const { data: softDeleted } = await supabase
          .from('communication_logs')
          .update({ deleted_at: new Date().toISOString() })
          .eq('org_id', org.id)
          .is('deleted_at', null)
          .lt('created_at', new Date(today.getTime() - org.comms_log_retention_days * 86_400_000).toISOString())
          .select('id')

        // Step B — hard purge logs soft-deleted more than 30 days ago
        const { data: hardPurged } = await supabase
          .from('communication_logs')
          .delete()
          .eq('org_id', org.id)
          .not('deleted_at', 'is', null)
          .lt('deleted_at', new Date(today.getTime() - 30 * 86_400_000).toISOString())
          .select('id')

        commsSoftDeleted += softDeleted?.length ?? 0
        commsHardPurged  += hardPurged?.length ?? 0

        return { soft_deleted: softDeleted?.length ?? 0, hard_purged: hardPurged?.length ?? 0 }
      })
    }

    logger.info(`Comms log retention — soft-deleted ${commsSoftDeleted}, hard-purged ${commsHardPurged}`)

    return {
      checked:             dueSchedules.length,
      escalated:           overdueSchedules.length,
      aging_escalated:     agingWOs.length,
      auto_wos_attempted:  autoWOSchedules.length,
      assets_scored:       activeAssets.length,
      compliance_checked:  expiringDocs.length,
      comms_soft_deleted:  commsSoftDeleted,
      comms_hard_purged:   commsHardPurged,
    }
  }
)

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildScheduleEmail(opts: {
  heading: string
  name: string
  daysText: string
  property?: string
  dueDate: string
  cost?: number | null
  vendor?: string | null
  url: string
  cta: string
}): string {
  return `
    <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
      <h2 style="margin-bottom:8px">${opts.heading}</h2>
      <p><strong>${opts.name}</strong> is ${opts.daysText}.</p>
      <table style="border-collapse:collapse;width:100%;margin:16px 0">
        ${opts.property ? `<tr><td style="padding:8px;color:#64748b">Property</td><td style="padding:8px;font-weight:600">${opts.property}</td></tr>` : ''}
        <tr><td style="padding:8px;color:#64748b">Due Date</td><td style="padding:8px;font-weight:600">${opts.dueDate}</td></tr>
        ${opts.cost ? `<tr><td style="padding:8px;color:#64748b">Est. Cost</td><td style="padding:8px;font-weight:600">$${opts.cost}</td></tr>` : ''}
        ${opts.vendor ? `<tr><td style="padding:8px;color:#64748b">Vendor</td><td style="padding:8px;font-weight:600">${opts.vendor}</td></tr>` : ''}
      </table>
      <p><a href="${opts.url}" style="background:#FCD116;color:#0a1628;padding:10px 20px;text-decoration:none;border-radius:6px;display:inline-block;font-weight:700">${opts.cta}</a></p>
    </div>
  `
}
