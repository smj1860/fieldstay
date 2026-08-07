import { inngest } from '@/lib/inngest/client'
import { reportError } from '@/lib/observability/report-error'
import { createServiceClient } from '@/lib/supabase/server'
import { resend, FROM } from '@/lib/resend/client'
import { createPmNotification } from '@/lib/inngest/helpers'
import { formatPropertyDateTime } from '@/lib/utils/timezone'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'
import { logAuditEvent } from '@/lib/audit'
import { incrementCounter } from '@/lib/observability/metrics'
import { unwrapJoin, unwrapJoinArray } from '@/lib/utils/supabase-joins'
import { throwIfAnyQueryFailed, isRealQueryError, unwrap } from '@/lib/supabase/unwrap'

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
    // Burst-exposed AND sends through an external provider. Resend's default
    // is 2 req/s, so throttle to 1/s: this handler receives a BATCH of events
    // (see the sender), and without a cap the whole batch lands at once.
    concurrency: { limit: 5 },
    throttle:    { limit: 60, period: '1m' },
  },
  { event: 'turnover/created' as const },
  async ({ event, step }) => {
    const { turnover_id, property_id, org_id, checkout_datetime } = event.data

    // ── Fetch turnover data ──────────────────────────────────────────────────

    const { turnover, property } = await step.run('fetch-turnover-data', async () => {
      const supabase = createServiceClient({ system: 'inngest:turnover-events' })

      const [
        { data: turnover, error: turnoverError },
        { data: property, error: propertyError },
      ] = await Promise.all([
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
      throwIfAnyQueryFailed(
        { site: 'inngest.turnover-events.fetch-turnover-data', orgId: org_id },
        isRealQueryError(turnoverError) ? turnoverError : null,
        isRealQueryError(propertyError) ? propertyError : null,
      )

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

type TurnoverServiceClient = ReturnType<typeof createServiceClient>

/**
 * The earliest and latest checklist item completion, or [] if none.
 *
 * Only the extremes matter — the duration is MAX - MIN — so the database is
 * asked for exactly those two rows rather than every item. That also removes
 * an unbounded read: a checklist runs 30-60 items today, but nothing in the
 * schema caps it, and PostgREST would silently truncate at max_rows and skew
 * the result.
 */
async function checklistCompletionRange(
  supabase:   TurnoverServiceClient,
  turnoverId: string,
  orgId:      string,
): Promise<string[]> {
  const { data: instance, error: instanceError } = await supabase
    .from('checklist_instances')
    .select('id')
    .eq('turnover_id', turnoverId)
    .eq('org_id', orgId)
    .maybeSingle()
  if (instanceError) throw instanceError
  if (!instance) return []

  const end = (ascending: boolean) => supabase
    .from('checklist_instance_items')
    .select('completed_at')
    .eq('instance_id', instance.id)
    .not('completed_at', 'is', null)
    .order('completed_at', { ascending })
    .limit(1)
    .maybeSingle()

  const ends = await Promise.all([end(true), end(false)])

  const endsError = ends.find((r) => r.error)?.error
  if (endsError) throw endsError

  return ends.map((r) => r.data?.completed_at).filter((t): t is string => Boolean(t))
}

/**
 * Inventory's single completion signal, or null.
 *
 * Unlike checklist, inventory has no per-item timestamps (see the crew-facing
 * InventoryView flow): the explicit "Confirm Inventory Complete" press if it
 * happened, else the last inventory quantity edit after this turnover's
 * inventory work began, as a fallback for crew who forgot to press it.
 * inventory_started_at itself is NOT a signal — it marks when work began, not
 * when something was completed.
 */
async function inventoryCompletionSignal(
  supabase:   TurnoverServiceClient,
  turnoverId: string,
  orgId:      string,
): Promise<string | null> {
  const { data: turnover, error: turnoverError } = await supabase
    .from('turnovers')
    .select('property_id, inventory_started_at, inventory_confirmed_complete_at')
    .eq('id', turnoverId)
    .eq('org_id', orgId)
    .maybeSingle()
  if (turnoverError) throw turnoverError

  if (turnover?.inventory_confirmed_complete_at) return turnover.inventory_confirmed_complete_at
  if (!turnover?.inventory_started_at) return null

  const { data: lastEdited, error: lastEditedError } = await supabase
    .from('inventory_items')
    .select('updated_at')
    .eq('property_id', turnover.property_id)
    .gt('updated_at', turnover.inventory_started_at)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (lastEditedError) throw lastEditedError

  return lastEdited?.updated_at ?? null
}

/** Every completion-type timestamp for a turnover: checklist plus inventory. */
async function collectCompletionTimestamps(
  supabase:   TurnoverServiceClient,
  turnoverId: string,
  orgId:      string,
): Promise<string[]> {
  const timestamps = await checklistCompletionRange(supabase, turnoverId, orgId)

  const inventorySignal = await inventoryCompletionSignal(supabase, turnoverId, orgId)
  if (inventorySignal) timestamps.push(inventorySignal)

  return timestamps
}

interface DurationWrite {
  what:  string
  site:  string
  error: { message: string } | null
}

/**
 * Logs and reports the first failed write of the crew-duration pair.
 *
 * Extracted so the step body carries one branch instead of one per write —
 * both go to the same place, and the step is already at the cognitive
 * complexity ceiling.
 */
function reportDurationWriteFailure(
  logger:  { error: (msg: string, meta?: Record<string, unknown>) => void },
  orgId:   string,
  results: readonly DurationWrite[],
): boolean {
  const failed = results.find((r) => r.error !== null)
  if (!failed?.error) return false

  logger.error(`${failed.what} update failed`, { error: failed.error.message })
  reportError(failed.error, { site: `inngest.turnover-events.${failed.site}`, orgId })
  return true
}

/**
 * Triggered when a turnover is marked complete by crew.
 * Sends a brief "turnover complete" notification to the PM.
 */
export const handleTurnoverCompleted = inngest.createFunction(
  {
    id:      'turnover-completed',
    name:    'Handle Turnover Completed',
    retries: 2,
    // Burst-exposed AND sends through an external provider. Resend's default
    // is 2 req/s, so throttle to 1/s: this handler receives a BATCH of events
    // (see the sender), and without a cap the whole batch lands at once.
    concurrency: { limit: 5 },
    throttle:    { limit: 60, period: '1m' },
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

      const propertyRes = await supabase
        .from('properties').select('name').eq('id', property_id).eq('org_id', org_id).single()
      const property = unwrap(propertyRes, { site: 'inngest.turnover-events.notify-pm-of-completion', orgId: org_id })

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

    // REMOVED: the per-turnover "N assets still need discovery" email.
    //
    // It fired immediately on every completed turnover, to the first PM email,
    // whenever any required asset type was still undiscovered at that property.
    // The daily wrap-up already reports exactly this: cron/daily-wrapup.ts
    // builds `checklistSection` from the SAME predicate over the SAME columns
    // (missingAssetTypesFromDiscoveredSet over the is_na/make/model/photo_url
    // filter), per property, once a day.
    //
    // So this was the same number delivered twice — but the per-turnover copy
    // arrived on a trigger the PM cannot act on differently (asset discovery is
    // not a turnover task) and at a rate set by turnover volume, which is
    // exactly the shape that trains people to filter a sender. Deleted rather
    // than made conditional: there is no threshold at which a duplicate of the
    // wrap-up's own content is worth its own send.

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
        const { error: milestoneError } = await supabase.from('org_milestones').upsert(
          { org_id, milestone },
          { onConflict: 'org_id,milestone', ignoreDuplicates: true }
        )
        if (milestoneError) {
          logger.error('org_milestones upsert failed', { milestone, error: milestoneError.message })
          reportError(milestoneError, {
            site:  'inngest.turnover-events.record-completion-milestones',
            orgId: org_id,
            extra: { milestone },
          })
        }
      }
    })

    await step.run('post-cleaning-fee-expense', async () => {
      const supabase = createServiceClient({ system: 'inngest:turnover-events' })

      const [
        { data: property, error: propertyError },
        { data: turnover, error: turnoverError },
      ] = await Promise.all([
        supabase.from('properties').select('cleaning_cost, same_day_premium_pct').eq('id', property_id).eq('org_id', org_id).single(),
        supabase.from('turnovers').select('is_same_day_turnover').eq('id', turnover_id).eq('org_id', org_id).single(),
      ])
      throwIfAnyQueryFailed(
        { site: 'inngest.turnover-events.post-cleaning-fee-expense', orgId: org_id },
        isRealQueryError(propertyError) ? propertyError : null,
        isRealQueryError(turnoverError) ? turnoverError : null,
      )

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

      const timestamps = await collectCompletionTimestamps(supabase, turnover_id, org_id)

      if (timestamps.length === 0) return { skipped: 'no_completion_signals' }

      timestamps.sort((a, b) => new Date(a).getTime() - new Date(b).getTime())
      const startedAt   = timestamps[0]!
      const completedAt = timestamps[timestamps.length - 1]!

      const durationMinutes = (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 60_000

      if (durationMinutes > MAX_PLAUSIBLE_DURATION_MINUTES) {
        logger.warn('Anomalous turnover duration detected — skipping', { flag: 'duration_anomaly' })
        return { skipped: 'anomalous_duration', duration_minutes: durationMinutes }
      }

      const roundedMinutes = Math.round(durationMinutes)

      // ONE calculation feeds both consumers — assignment_outcomes (the
      // crew-scoring learning loop) and turnovers.crew_duration_minutes (the
      // PM-facing board display) — so the two numbers cannot drift apart.
      //
      // But they are written differently, and the asymmetry is not an
      // oversight. assignment_outcomes.duration_minutes is GENERATED ALWAYS,
      // derived from started_at/completed_at with its own 480-minute
      // plausibility cap (the same bound as MAX_PLAUSIBLE_DURATION_MINUTES
      // above), so it must NOT be named in the payload: doing so raised 428C9
      // "cannot insert a non-DEFAULT value into column", which failed the
      // WHOLE update — started_at and completed_at were never written either,
      // and the learning loop that feeds crew scoring recorded nothing at all.
      // turnovers.crew_duration_minutes is an ordinary integer column and IS
      // written here.
      const [assignmentResult, turnoverResult] = await Promise.all([
        supabase
          .from('assignment_outcomes')
          .update({ started_at: startedAt, completed_at: completedAt })
          .eq('turnover_id', turnover_id)
          .eq('org_id', org_id)
          .select('id'),
        supabase
          .from('turnovers')
          .update({ crew_duration_minutes: roundedMinutes })
          .eq('id', turnover_id)
          .eq('org_id', org_id),
      ])

      // Reported, not thrown, and never discarded: destructuring `data`
      // without `error` is what let the 428C9 above surface as
      // `updated_rows: 0` and read like "no matching rows" for weeks.
      const writeFailed = reportDurationWriteFailure(logger, org_id, [
        { what: 'assignment_outcomes duration', site: 'assignmentOutcomeDuration', error: assignmentResult.error },
        { what: 'turnovers crew_duration_minutes', site: 'turnoverCrewDuration', error: turnoverResult.error },
      ])

      const updatedRows = assignmentResult.data?.length ?? 0
      if (writeFailed) return { updated_rows: updatedRows, duration_minutes: roundedMinutes, error: true }

      return { updated_rows: updatedRows, duration_minutes: roundedMinutes }
    })

    logger.info('turnover-completed done', { workflowId, turnover_id })

    return { turnover_id, notified: true }
  }
)
