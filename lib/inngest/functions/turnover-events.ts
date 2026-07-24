import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM } from '@/lib/resend/client'
import { getPmEmails, createPmNotification } from '@/lib/inngest/helpers'
import { formatPropertyDateTime } from '@/lib/utils/timezone'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'
import { assetTypeDisplayName, missingAssetTypesFromDiscoveredSet } from '@/lib/asset-discovery/config'
import type { AssetType } from '@/types/database'
import { logAuditEvent } from '@/lib/audit'
import { incrementCounter } from '@/lib/observability/metrics'
import { unwrapJoin, unwrapJoinArray } from '@/lib/utils/supabase-joins'

// Durations beyond this are treated as tracking errors (e.g. a checklist item
// completed a day late) and excluded from the auto-assignment learning loop.
const MAX_PLAUSIBLE_DURATION_MINUTES = 8 * 60

/**
 * Triggered when a new turnover is created (from iCal sync or manual).
 *
 * Fetches turnover + property details and, if crew is already assigned,
 * notifies them. Unassigned turnovers are no longer tracked here — the
 * daily wrap-up digest (cron-daily-wrapup, section 9) surfaces them fresh
 * every day instead of this function sleeping until a fixed deadline.
 */
export const handleTurnoverCreated = inngest.createFunction(
  {
    id:      'turnover-created',
    name:    'Handle New Turnover',
    retries: 2,
  },
  { event: 'turnover/created' as const },
  async ({ event, step }) => {
    const { turnover_id, property_id, org_id, checkout_datetime } = event.data

    // ── Fetch turnover data ──────────────────────────────────────────────────

    const { turnover, property } = await step.run('fetch-turnover-data', async () => {
      const supabase = createServiceClient({ system: 'inngest:turnover-events' })

      const [{ data: turnover }, { data: property }] = await Promise.all([
        supabase
          .from('turnovers')
          .select(`
            id, checkout_datetime, checkin_datetime, window_minutes, status, priority,
            turnover_assignments ( crew_member_id, crew_members ( name, email, phone, preferred_contact ) )
          `)
          .eq('id', turnover_id)
          .eq('org_id', org_id)
          .single(),
        supabase
          .from('properties')
          .select('name, city, state, timezone')
          .eq('id', property_id)
          .eq('org_id', org_id)
          .single(),
      ])

      return { turnover, property }
    })

    if (!turnover || !property) return

    const checkoutDT    = new Date(checkout_datetime)
    const windowHours   = Math.round((turnover.window_minutes ?? 0) / 60)

    // ── Notify already-assigned crew (if any) ───────────────────────────────

    const assignments = unwrapJoinArray(turnover.turnover_assignments)

    if (assignments.length > 0) {
      await step.run('notify-assigned-crew', async () => {
        await Promise.all(
          assignments.map(async (assignment) => {
            const crew = unwrapJoin(assignment.crew_members)

            if (!crew?.email) return

            await resend.emails.send({
              from:    FROM,
              to:      crew.email,
              subject: `Turnover assigned — ${property.name} on ${checkoutDT.toLocaleDateString()}`,
              html: await renderPmAlert({
                heading:  "You've been assigned a turnover",
                body:     `You're on the schedule for a turnover at ${property.name}.`,
                details: [
                  { label: 'Property',      value: property.name },
                  { label: 'Checkout',      value: formatPropertyDateTime(turnover.checkout_datetime, property.timezone ?? 'America/Chicago') },
                  { label: 'Next Check-in', value: formatPropertyDateTime(turnover.checkin_datetime, property.timezone ?? 'America/Chicago') },
                  { label: 'Window',        value: `${windowHours}h ${(turnover.window_minutes ?? 0) % 60}m` },
                  { label: 'Priority',      value: turnover.priority.toUpperCase() },
                ],
                ctaLabel: 'View Turnover →',
                ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/turnovers`,
              }),
            }, { idempotencyKey: `turnover-assigned-${turnover_id}-${assignment.crew_member_id}` })
          })
        )
      })

      // Crew is assigned — schedule completion check, then done
      return { turnover_id, crewNotified: assignments.length }
    }

    // No crew assigned — the daily wrap-up digest catches this fresh every
    // day (see cron-daily-wrapup, section 9) rather than this function
    // sleeping until a fixed per-turnover deadline.
    return { turnover_id, warned: false }
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

    await step.run('emit-completion-metric', async () => {
      await incrementCounter('fieldstay_turnovers_completed_total', { org_id })
    })

    await step.run('notify-pm-of-completion', async () => {
      const supabase = createServiceClient({ system: 'inngest:turnover-events' })

      const { data: property } = await supabase
        .from('properties').select('name').eq('id', property_id).eq('org_id', org_id).single()

      await createPmNotification(supabase, {
        orgId:     org_id,
        type:      'turnover_complete',
        title:     `✓ Turnover complete — ${property?.name}`,
        subtitle:  `${property?.name} is ready for guests`,
        href:      `/turnovers/${turnover_id}`,
        severity:  'green',
        dedupeKey: `turnover-completed-pm-${turnover_id}`,
      })
    })

    await step.run('notify-pm-of-open-mandatory-items', async () => {
      const supabase = createServiceClient({ system: 'inngest:turnover-events' })

      const { data: assets } = await supabase
        .from('property_assets')
        .select('asset_type, make, model, photo_url, is_na')
        .eq('property_id', property_id)
        .eq('org_id', org_id)
        .eq('is_active', true)

      const discoveredTypes = new Set(
        (assets ?? [])
          .filter((a) => a.is_na === true || a.make !== null || a.model !== null || a.photo_url !== null)
          .map((a) => a.asset_type as AssetType)
      )
      const missingTypes = missingAssetTypesFromDiscoveredSet(discoveredTypes)

      if (!missingTypes.length) return { skipped: 'none_missing' }

      const [{ data: property }, pmEmails] = await Promise.all([
        supabase.from('properties').select('name').eq('id', property_id).eq('org_id', org_id).single(),
        getPmEmails(supabase, org_id),
      ])
      const [pmEmail] = pmEmails

      if (!pmEmail) return { skipped: 'no_pm_email' }

      await resend.emails.send({
        from:    FROM,
        to:      pmEmail,
        subject: `⚠️ ${missingTypes.length} asset${missingTypes.length !== 1 ? 's' : ''} still need discovery — ${property?.name}`,
        html: await renderPmAlert({
          heading:  'Asset discovery still incomplete',
          body:     `The crew marked this turnover complete, but ${missingTypes.length} required asset${missingTypes.length !== 1 ? 's haven\'t' : ' hasn\'t'} been discovered yet at ${property?.name}.`,
          details:  missingTypes.map((t) => ({ label: assetTypeDisplayName(t), value: 'Not yet captured' })),
          ctaLabel: 'View Property Assets →',
          ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/assets`,
        }),
      }, { idempotencyKey: `turnover-completed-mandatory-open-${turnover_id}` })

      return { notified: true, missing_count: missingTypes.length }
    })

    await step.run('record-completion-milestones', async () => {
      const supabase = createServiceClient({ system: 'inngest:turnover-events' })

      const { count } = await supabase
        .from('turnovers')
        .select('id', { count: 'exact', head: true })
        .eq('org_id', org_id)
        .eq('status', 'completed')

      const n = count ?? 0

      const milestones: string[] = []
      if (n >= 1)  milestones.push('first_turnover_complete')
      if (n >= 10) milestones.push('turnover_milestone_10')
      if (n >= 50) milestones.push('turnover_milestone_50')

      for (const milestone of milestones) {
        await supabase.from('org_milestones').upsert(
          { org_id, milestone },
          { onConflict: 'org_id,milestone', ignoreDuplicates: true }
        )
      }
    })

    await step.run('post-cleaning-fee-expense', async () => {
      const supabase = createServiceClient({ system: 'inngest:turnover-events' })

      const [{ data: property }, { data: turnover }] = await Promise.all([
        supabase.from('properties').select('cleaning_cost, same_day_premium_pct').eq('id', property_id).eq('org_id', org_id).single(),
        supabase.from('turnovers').select('is_same_day_turnover').eq('id', turnover_id).eq('org_id', org_id).single(),
      ])

      if (!property?.cleaning_cost) return { skipped: true }

      const base    = property.cleaning_cost
      const premium = (turnover?.is_same_day_turnover && property.same_day_premium_pct)
        ? base * (property.same_day_premium_pct / 100)
        : 0
      const amount  = parseFloat((base + premium).toFixed(2))

      // Atomic upsert — ON CONFLICT (source_reference_id, source) DO NOTHING
      const { data: txn, error } = await supabase.from('owner_transactions').upsert(
        {
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
        },
        { onConflict: 'source_reference_id,source', ignoreDuplicates: true }
      ).select('id').maybeSingle()

      if (error) throw error

      if (txn) {
        await logAuditEvent({
          orgId:      org_id,
          action:     'owner.transaction.created',
          targetType: 'owner_transaction',
          targetId:   txn.id,
          metadata:   { source: 'turnover_completion', turnover_id },
        })
      }

      return { posted: amount }
    })

    await step.run('record-crew-duration', async () => {
      const supabase = createServiceClient({ system: 'inngest:turnover-events' })

      const { data: instance } = await supabase
        .from('checklist_instances')
        .select('id')
        .eq('turnover_id', turnover_id)
        .eq('org_id', org_id)
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
        logger.warn('Anomalous turnover duration detected — skipping', { flag: 'duration_anomaly' })
        return { skipped: 'anomalous_duration', duration_minutes: durationMinutes }
      }

      const { data: updatedRows } = await supabase
        .from('assignment_outcomes')
        .update({ started_at: startedAt, completed_at: completedAt, duration_minutes: Math.round(durationMinutes) })
        .eq('turnover_id', turnover_id)
        .eq('org_id', org_id)
        .select('id')

      return { updated_rows: updatedRows?.length ?? 0, duration_minutes: Math.round(durationMinutes) }
    })

    logger.info('turnover-completed done', { workflowId, turnover_id })

    return { turnover_id, notified: true }
  }
)
