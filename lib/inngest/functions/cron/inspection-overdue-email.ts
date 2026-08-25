// lib/inngest/functions/cron/inspection-overdue-email.ts
//
// §9's overdue-inspection email. A MONTHLY DIGEST, one per ORG, sent on the 1st
// and covering every inspection due in a prior month that has not been walked.
//
// Monthly rather than per-due-date because inspection dates cluster by MONTH:
// applySafetyTemplate seeds every property with the 1st of the template's
// month, and from the second occurrence onward nudgeDueDateIntoVacancy moves
// each to a different day inside roughly that month, chosen from that
// property's own booking gaps. A "three days after due" rule therefore
// trickles emails across the month — 29 on one morning for a portfolio's first
// occurrence, then a scatter of ones and twos forever after.
//
// WHO IT GOES TO. §2 said "Email the assignee. No escalation path — they are
// the responsible party." Amended 2026-08-24: it goes to the PM / org owner.
// Every safety schedule the onboarding template generates is deliberately
// unassigned (`assigned_to_user_id: null` in apply-safety-template.ts —
// guessing one would notify somebody who never agreed to walk 29 properties),
// so "the assignee" resolved to nobody in the case that will make up nearly all
// of them.
//
// WHAT IT SAYS is not this file's business. lib/inspections/overdue-email-copy.ts
// holds the approved wording and carries the sign-off note.
//
// ─────────────────────────────────────────────────────────────────────────────
// A DISPATCHER AND A HANDLER, NOT ONE LOOP
//
// The cron scans the platform and fans out ONE event per tenant; the handler
// does that tenant's work. Emailing every org inside a single run would put the
// step count on the platform's growth curve and make one org's bounced address
// retry everybody else's email. Same shape as cron/daily-wrapup.ts and the six
// crons converted alongside it; enforced by
// unit/guardrails/unbounded-fanout-loops.test.ts.

import { inngest }              from '@/lib/inngest/client'
import { createServiceClient }  from '@/lib/supabase/server'
import { fetchAllRows }         from '@/lib/inngest/paginate'
import { getPmMembers }         from '@/lib/inngest/helpers'
import { resend, FROM }         from '@/lib/resend/client'
import { renderPmAlert }        from '@/lib/resend/emails/pm-alert'
import { reportError }          from '@/lib/observability/report-error'
import { todayISO }             from '@/lib/inspections/due-schedules'
import {
  firstOfMonth,
  selectOverdueForDigest,
  type OverdueCandidate,
} from '@/lib/inspections/overdue-email'
import {
  bulkOverdueCopy,
  singleOverdueCopy,
  type OverdueLine,
} from '@/lib/inspections/overdue-email-copy'

const SYSTEM = 'inngest:inspection-overdue-email'

/**
 * Rows listed in a bulk email's table.
 *
 * Truncation is STATED, not silent: the subject and heading carry the full
 * count and a "Not listed above: N more" line sits under the table. A list that
 * quietly shows 20 of 27 reads as 27 being 20, which is the difference between
 * a bounded list and a wrong one.
 */
const MAX_LISTED = 20

/** Bound on one org's overdue set. Well past the 50-property plan ceiling. */
const MAX_SCHEDULES_PER_ORG = 500

interface ScheduleRow extends OverdueCandidate {
  name:     string
  property: { name: string }[] | { name: string } | null
}

const SELECT =
  'id, org_id, property_id, name, next_due_date, overdue_notified_month, property:properties(name)'

// ── Dispatcher ───────────────────────────────────────────────────────────────

export const inspectionOverdueEmailCron = inngest.createFunction(
  {
    id:      'inspection-overdue-email-cron',
    name:    'Inspections: Overdue Email Dispatcher',
    retries: 2,
    concurrency: { limit: 1, key: '"inspection-overdue-email-cron"' },
  },
  // The 1st of each month at 13:30 UTC — mid-morning US, and deliberately NOT
  // on the hour. The :00 slot already carries the hourly token refresh plus
  // several daily crons, and a 2026-08-24 incident traced to two of them
  // colliding there.
  //
  // Monthly rather than daily because the digest covers a month: a daily run
  // would find the same outstanding set every morning and be suppressed by the
  // month key on 30 of 31 days, which is a scan doing nothing.
  { cron: '30 13 1 * *' },
  async ({ step, logger }) => {
    const today = todayISO()

    const orgIds = await step.run('find-orgs-with-overdue', async () => {
      // Everything due before this month started — the month just ended, plus
      // anything still outstanding from before it.
      const supabase = createServiceClient({ system: SYSTEM })

      // Paginated: a platform-wide scan, and `max_rows = 1000` truncates with a
      // 200 and no signal. A short read here does not error — it silently drops
      // whole tenants, and the symptom is an email that never arrives, which
      // nobody reports as a bug.
      const rows = await fetchAllRows<ScheduleRow>(
        (from, to) => supabase
          .from('maintenance_schedules')
          .select(SELECT)
          .eq('creates', 'inspection')
          .eq('is_active', true)
          .not('next_due_date', 'is', null)
          .lt('next_due_date', firstOfMonth(today))
          .order('id')
          .range(from, to),
        { label: 'maintenance_schedules(overdue-inspection-dispatch)' },
      )

      return [...new Set(selectOverdueForDigest(rows, today).map((r) => r.org_id))]
    })

    if (orgIds.length === 0) {
      logger.info('[InspectionOverdue] nothing overdue past the delay')
      return { orgs: 0 }
    }

    // ONE sendEvent with an array, not a loop of sends — a single call whose
    // cost does not scale with tenant count.
    await step.sendEvent('dispatch-overdue-emails', orgIds.map((org_id) => ({
      name: 'inspection/overdue.email.requested' as const,
      data: { org_id },
    })))

    logger.info(`[InspectionOverdue] dispatched ${orgIds.length} org(s)`)
    return { orgs: orgIds.length }
  },
)

// ── Per-org handler ──────────────────────────────────────────────────────────

export const inspectionOverdueEmailHandler = inngest.createFunction(
  {
    id:      'inspection-overdue-email-handler',
    name:    'Inspections: Overdue Email (per org)',
    retries: 2,
    concurrency: { limit: 4, key: 'event.data.org_id' },
  },
  { event: 'inspection/overdue.email.requested' as const },
  async ({ event, step, logger }) => {
    const { org_id } = event.data
    const today = todayISO()

    // RE-SELECTED here rather than carried on the event. Between dispatch and
    // delivery the walk may have been completed, which advances next_due_date
    // and takes the schedule out of the set — and an email saying a finished
    // inspection is overdue is worse than no email at all.
    const rows = await step.run('load-org-overdue', async () => {
      const supabase = createServiceClient({ system: SYSTEM })
      const { data, error } = await supabase
        .from('maintenance_schedules')
        .select(SELECT)
        .eq('org_id', org_id)
        .eq('creates', 'inspection')
        .eq('is_active', true)
        .not('next_due_date', 'is', null)
        .lt('next_due_date', firstOfMonth(today))
        .order('next_due_date', { ascending: true })
        .limit(MAX_SCHEDULES_PER_ORG)

      if (error) throw new Error(`[InspectionOverdue] load failed for org ${org_id}: ${error.message}`)
      return selectOverdueForDigest((data ?? []) as unknown as ScheduleRow[], today)
    })

    if (rows.length === 0) {
      logger.info(`[InspectionOverdue] org ${org_id}: nothing left overdue`)
      return { sent: false }
    }

    const recipient = await step.run('resolve-recipient', () => resolvePmRecipient(org_id))
    if (!recipient) {
      // No owner/admin who has accepted their invite. Nothing is marked, so the
      // email goes out the moment one exists rather than the occurrence having
      // been silently consumed.
      logger.warn(`[InspectionOverdue] org ${org_id}: no PM recipient — skipping`)
      return { sent: false }
    }

    const lines = rows.map(toLine)
    const copy  = lines.length === 1 && lines[0]
      ? singleOverdueCopy(recipient.name, lines[0])
      : bulkOverdueCopy(recipient.name, lines)

    // SEND, THEN MARK — the opposite order to the reconnect email's, on purpose.
    //
    // integration-token-refresh-handler claims BEFORE sending because its
    // failure mode was mailing the same PM every day forever: there an
    // unclaimed retry is unbounded. Here the flag is per-occurrence, so dying
    // between send and mark costs ONE duplicate tomorrow and self-corrects.
    // Claiming first would trade that for the opposite failure — an occurrence
    // consumed with no email ever sent, silently, on a feature whose whole job
    // is not being silent.
    await step.run('send-email', () => sendOverdueEmail(org_id, copy, lines, recipient.email))

    // A separate step so a failed mark retries without re-sending.
    await step.run('mark-notified', () => markNotified(org_id, rows, today))

    logger.info(`[InspectionOverdue] org ${org_id}: ${rows.length} overdue, 1 email`)
    return { sent: true, schedules: rows.length }
  },
)

async function resolvePmRecipient(orgId: string): Promise<{ email: string; name: string } | null> {
  const supabase = createServiceClient({ system: SYSTEM })
  const [primary] = await getPmMembers(supabase, orgId, { roles: ['owner', 'admin'], limit: 1 })
  if (!primary) return null

  const { data: profile, error } = await supabase
    .from('profiles')
    .select('full_name')
    .eq('id', primary.userId)
    .maybeSingle()

  // Not fatal — the email still goes out under a generic greeting, which beats
  // not going out — but never silent: a PM addressed as "there" rather than by
  // name is a visible quality problem.
  if (error) reportError(error, { site: `${SYSTEM}.profile`, orgId })

  return { email: primary.email, name: profile?.full_name ?? 'there' }
}

async function sendOverdueEmail(
  orgId: string,
  copy:  ReturnType<typeof singleOverdueCopy>,
  lines: OverdueLine[],
  to:    string,
): Promise<void> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL

  const html = await renderPmAlert({
    heading:  copy.heading,
    body:     copy.body,
    ctaLabel: copy.ctaLabel,
    // The LIST page, not a per-inspection URL. An overdue schedule has no
    // inspection row yet — §7 is explicit that a cron must not create one,
    // because `started_at` would then record a cron run rather than somebody
    // arriving at the property, and §12.3 presents that duration as evidence.
    // This is the page the walk is started from.
    ctaUrl:   `${appUrl}/maintenance/inspections`,
    note:     copy.note,
    ...(lines.length > 1 ? { table: overdueTable(lines) } : {}),
    ...(lines.length > MAX_LISTED
      ? { details: [{ label: 'Not listed above', value: `${lines.length - MAX_LISTED} more overdue inspections` }] }
      : {}),
  })

  const { error } = await resend.emails.send({
    from:    FROM,
    to,
    replyTo: 'support@fieldstay.app',
    subject: copy.subject,
    html,
  }, {
    // Keyed on the org and the digest month, so the step's own retries cannot
    // turn one digest into several emails. Resend's window is 24h, which covers
    // the retries and deliberately not next month's run — the
    // overdue_notified_month flag is what makes this once per month.
    idempotencyKey: `inspection-overdue-${orgId}-${firstOfMonth(todayISO())}`,
  })

  if (error) {
    // Thrown, not swallowed: nothing is marked yet, so a transient failure
    // retries and a terminal one reaches the dead-letter handler rather than
    // vanishing.
    throw new Error(`[InspectionOverdue] send failed for org ${orgId}: ${JSON.stringify(error)}`)
  }
}

/**
 * EACH SCHEDULE MARKED WITH ITS OWN DUE DATE.
 *
 * A bulk email covers schedules whose due dates can differ, so stamping them
 * all with the first row's date would mark the rest against a date they were
 * never due on — and `IS DISTINCT FROM` would then re-send for them on the very
 * next run, and every run after it. Grouped by date, which is a single
 * statement in the ordinary case because applySafetyTemplate gives a whole
 * portfolio one shared first due date.
 */
async function markNotified(
  orgId:   string,
  rows:    { id: string }[],
  runDate: string,
): Promise<void> {
  const supabase = createServiceClient({ system: SYSTEM })

  // ONE statement, and one value: the digest's month. This used to group by
  // each schedule's own due date, which was right when the key WAS the
  // occurrence — a bulk email spans schedules due on different days, and
  // stamping them all with the first row's date would have re-sent for the rest
  // forever. Keyed on the month, they all share the same value by definition.
  const { error } = await supabase
    .from('maintenance_schedules')
    .update({ overdue_notified_month: firstOfMonth(runDate) })
    .eq('org_id', orgId)
    .in('id', rows.map((r) => r.id))

  // The email HAS gone by now. Reported rather than thrown so the run is not
  // re-driven into a second send; next month's digest reports these again,
  // which is the bounded, self-correcting failure.
  if (error) reportError(error, { site: `${SYSTEM}.mark`, orgId })
}

function toLine(row: {
  name: string
  next_due_date: string
  daysOverdue: number
  property?: ScheduleRow['property']
}): OverdueLine {
  return {
    propertyName: propertyNameOf(row.property) ?? 'this property',
    formLabel:    row.name || 'Inspection',
    dueDate:      formatDate(row.next_due_date),
    daysOverdue:  row.daysOverdue,
  }
}

function overdueTable(lines: readonly OverdueLine[]) {
  return {
    headers: ['Property', 'Inspection', 'Overdue'],
    rows: lines.slice(0, MAX_LISTED).map((l) => [
      l.propertyName,
      l.formLabel,
      l.daysOverdue === 1 ? '1 day' : `${l.daysOverdue} days`,
    ]),
  }
}

/** PostgREST returns a nested join as an array or an object, per relationship. */
function propertyNameOf(property: ScheduleRow['property'] | undefined): string | null {
  if (!property) return null
  return Array.isArray(property) ? property[0]?.name ?? null : property.name
}

function formatDate(iso: string): string {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  })
}
