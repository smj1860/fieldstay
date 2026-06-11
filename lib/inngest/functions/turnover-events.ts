import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM } from '@/lib/resend/client'
import { getPmEmail } from '@/lib/inngest/helpers'
import { formatDateTime } from '@/lib/utils'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'

// Durations beyond this are treated as tracking errors (e.g. a checklist item
// completed a day late) and excluded from the auto-assignment learning loop.
const MAX_PLAUSIBLE_DURATION_MINUTES = 8 * 60

/**
 * Triggered when a new turnover is created (from iCal sync or manual).
 *
 * Steps:
 *  1. Fetch turnover + property details
 *  2. (Future) Auto-assign if default crew set
 *  3. Sleep until 24 hours before checkout
 *  4. If still unassigned, send urgent warning to PM
 */
export const handleTurnoverCreated = inngest.createFunction(
  {
    id:      'turnover-created',
    name:    'Handle New Turnover',
    retries: 2,
  },
  { event: 'turnover/created' as const },
  async ({ event, step, logger }) => {
    const { turnover_id, property_id, org_id, checkout_datetime } = event.data

    // ── Fetch turnover data ──────────────────────────────────────────────────

    const { turnover, property, pmEmail } = await step.run('fetch-turnover-data', async () => {
      const supabase = createServiceClient()

      const [{ data: turnover }, { data: property }, pmEmail] = await Promise.all([
        supabase
          .from('turnovers')
          .select(`
            id, checkout_datetime, checkin_datetime, window_minutes, status, priority,
            turnover_assignments ( crew_member_id, crew_members ( name, email, phone, preferred_contact ) )
          `)
          .eq('id', turnover_id)
          .single(),
        supabase
          .from('properties')
          .select('name, city, state')
          .eq('id', property_id)
          .single(),
        getPmEmail(supabase, org_id),
      ])

      return { turnover, property, pmEmail }
    })

    if (!turnover || !property) return

    const checkoutDT    = new Date(checkout_datetime)
    const windowHours   = Math.round((turnover.window_minutes ?? 0) / 60)
    const isUrgent      = turnover.priority === 'urgent' || turnover.priority === 'high'

    // ── Notify already-assigned crew (if any) ───────────────────────────────

    const assignments = Array.isArray(turnover.turnover_assignments)
      ? turnover.turnover_assignments
      : turnover.turnover_assignments
        ? [turnover.turnover_assignments]
        : []

    if (assignments.length > 0) {
      await step.run('notify-assigned-crew', async () => {
        for (const assignment of assignments) {
          const crew = Array.isArray(assignment.crew_members)
            ? assignment.crew_members[0]
            : assignment.crew_members

          if (!crew?.email) continue

          await resend.emails.send({
            from:    FROM,
            to:      crew.email,
            subject: `Turnover assigned — ${property.name} on ${checkoutDT.toLocaleDateString()}`,
            html: await renderPmAlert({
              heading:  "You've been assigned a turnover",
              body:     `You're on the schedule for a turnover at ${property.name}.`,
              details: [
                { label: 'Property',      value: property.name },
                { label: 'Checkout',      value: formatDateTime(turnover.checkout_datetime) },
                { label: 'Next Check-in', value: formatDateTime(turnover.checkin_datetime) },
                { label: 'Window',        value: `${windowHours}h ${(turnover.window_minutes ?? 0) % 60}m` },
                { label: 'Priority',      value: turnover.priority.toUpperCase() },
              ],
              ctaLabel: 'View Turnover →',
              ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/turnovers`,
            }),
          }, { idempotencyKey: `turnover-assigned-${turnover_id}-${assignment.crew_member_id}` })
        }
      })

      // Crew is assigned — schedule completion check, then done
      return { turnover_id, crewNotified: assignments.length }
    }

    // ── No crew assigned — schedule 24h warning ──────────────────────────────

    // Warn 24 hours before checkout (or immediately if urgent)
    const warnAt = new Date(checkoutDT)
    warnAt.setHours(warnAt.getHours() - (isUrgent ? 4 : 24))

    await step.sleepUntil('wait-for-assignment-deadline', warnAt)

    // Re-check assignment status
    const stillUnassigned = await step.run('check-assignment-status', async () => {
      const supabase = createServiceClient()
      const { data } = await supabase
        .from('turnovers')
        .select('status, turnover_assignments(id)')
        .eq('id', turnover_id)
        .single()

      const assigned = Array.isArray(data?.turnover_assignments)
        ? data.turnover_assignments.length > 0
        : !!data?.turnover_assignments

      return data?.status !== 'cancelled' && !assigned
    })

    if (stillUnassigned && pmEmail) {
      await step.run('send-unassigned-warning', async () => {
        const hoursUntil = Math.round(
          (checkoutDT.getTime() - Date.now()) / 3_600_000
        )

        await resend.emails.send({
          from:    FROM,
          to:      pmEmail!,
          subject: `⚠️ Turnover needs crew — ${property.name} in ${hoursUntil}h`,
          html: await renderPmAlert({
            heading:  'Turnover needs crew assigned',
            body:     `${property.name} has a turnover in ${hoursUntil} hours with no crew assigned.`,
            details: [
              { label: 'Checkout',  value: formatDateTime(turnover.checkout_datetime) },
              { label: 'Check-in',  value: formatDateTime(turnover.checkin_datetime) },
              { label: 'Window',    value: `${windowHours}h ${(turnover.window_minutes ?? 0) % 60}m` },
              { label: 'Priority',  value: turnover.priority.toUpperCase() },
            ],
            ctaLabel: 'Assign Crew →',
            ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/turnovers`,
          }),
        }, { idempotencyKey: `turnover-unassigned-warning-${turnover_id}` })
      })
    }

    return { turnover_id, warned: stillUnassigned }
  }
)

/**
 * Triggered when a turnover is marked complete by crew.
 * Sends a brief "turnover complete" notification to the PM.
 */
export const handleTurnoverCompleted = inngest.createFunction(
  {
    id:      'turnover-completed',
    name:    'Handle Turnover Completed',
    retries: 2,
  },
  { event: 'turnover/completed' as const },
  async ({ event, step, logger }) => {
    const { turnover_id, property_id, org_id } = event.data
    const workflowId = crypto.randomUUID()

    logger.info('turnover-completed start', { workflowId, turnover_id })

    await step.run('notify-pm-of-completion', async () => {
      const supabase = createServiceClient()

      const [{ data: property }, pmEmail] = await Promise.all([
        supabase.from('properties').select('name').eq('id', property_id).single(),
        getPmEmail(supabase, org_id),
      ])

      if (!pmEmail) return

      await resend.emails.send({
        from:    FROM,
        to:      pmEmail,
        subject: `✅ Turnover complete — ${property?.name}`,
        html: await renderPmAlert({
          heading:  'Turnover marked complete',
          body:     `${property?.name} is ready for guests.`,
          ctaLabel: 'View Turnover →',
          ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/turnovers/${turnover_id}`,
        }),
      }, { idempotencyKey: `turnover-completed-pm-${turnover_id}` })
    })

    await step.run('record-completion-milestones', async () => {
      const supabase = createServiceClient()

      const { count } = await supabase
        .from('turnovers')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', org_id)
        .eq('status', 'completed')

      const n = count ?? 0

      const milestones: string[] = []
      if (n === 1)  milestones.push('first_turnover_complete')
      if (n === 10) milestones.push('turnover_milestone_10')
      if (n === 50) milestones.push('turnover_milestone_50')

      for (const milestone of milestones) {
        await supabase.from('org_milestones').upsert(
          { org_id, milestone },
          { onConflict: 'org_id,milestone', ignoreDuplicates: true }
        )
      }
    })

    await step.run('post-cleaning-fee-expense', async () => {
      const supabase = createServiceClient()

      const { data: existing } = await supabase
        .from('owner_transactions')
        .select('id')
        .eq('source_reference_id', turnover_id)
        .eq('source', 'cleaning_fee')
        .maybeSingle()

      if (existing) return { skipped: true }

      const [{ data: property }, { data: turnover }] = await Promise.all([
        supabase
          .from('properties')
          .select('cleaning_cost, same_day_premium_pct')
          .eq('id', property_id)
          .single(),
        supabase
          .from('turnovers')
          .select('is_same_day_turnover')
          .eq('id', turnover_id)
          .single(),
      ])

      if (!property?.cleaning_cost) return { skipped: true }

      const base    = property.cleaning_cost
      const premium = (turnover?.is_same_day_turnover && property.same_day_premium_pct)
        ? base * (property.same_day_premium_pct / 100)
        : 0
      const amount  = parseFloat((base + premium).toFixed(2))

      await supabase.from('owner_transactions').insert({
        property_id,
        org_id,
        source:               'cleaning_fee',
        source_reference_id:  turnover_id,
        transaction_type:     'expense',
        category:             'cleaning_fee',
        amount,
        description:          (premium > 0)
          ? `Cleaning fee + ${property.same_day_premium_pct}% same-day premium`
          : 'Cleaning fee',
        transaction_date:     new Date().toISOString().split('T')[0],
        visible_to_owner:     false,
      })

      return { posted: amount }
    })

    await step.run('record-crew-duration', async () => {
      const supabase = createServiceClient()

      const { data: instance } = await supabase
        .from('checklist_instances')
        .select('id')
        .eq('turnover_id', turnover_id)
        .maybeSingle()

      if (!instance) return { skipped: 'no_checklist_instance' }

      const { data: items } = await supabase
        .from('checklist_instance_items')
        .select('completed_at')
        .eq('instance_id', instance.id)
        .not('completed_at', 'is', null)
        .order('completed_at', { ascending: true })

      if (!items?.length) return { skipped: 'no_completed_items' }

      const startedAt   = items[0]!.completed_at!
      const completedAt = items[items.length - 1]!.completed_at!

      const durationMinutes = (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 60_000

      if (durationMinutes > MAX_PLAUSIBLE_DURATION_MINUTES) {
        console.warn(`[record-crew-duration] Anomalous duration ${durationMinutes}m for turnover ${turnover_id} — skipping`)
        return { skipped: 'anomalous_duration', duration_minutes: durationMinutes }
      }

      const { data: updatedRows } = await supabase
        .from('assignment_outcomes')
        .update({ started_at: startedAt, completed_at: completedAt, duration_minutes: Math.round(durationMinutes) })
        .eq('turnover_id', turnover_id)
        .select('id')

      return { updated_rows: updatedRows?.length ?? 0, duration_minutes: Math.round(durationMinutes) }
    })

    logger.info('turnover-completed done', { workflowId, turnover_id })

    return { turnover_id, notified: true }
  }
)
