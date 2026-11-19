import type { GetStepTools } from 'inngest'
import type { Json }           from '@/types/database.generated'
import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { reportError }         from '@/lib/observability/report-error'
import { loadTeamSettings, recordUsage } from '@/lib/gtm/tasks'
import { fetchRollup, spentTodayCents }  from '@/lib/gtm/rollup'
import type { ManagerRunKind }           from '@/lib/gtm/constants'
import { centralDateKey, centralDayStart, isTeamRunnable, settingFor } from '@/lib/gtm/policy'
import { buildMetrics, mayNarrate, renderBrief, type ManagerMetrics } from '@/lib/gtm/manager/brief'
import { narrateBrief, type NarrationResult } from '@/lib/gtm/manager/narrate'

// ============================================================================
// The GTM manager agent, in observe-only mode.
//
// Three triggers share one runner: a morning plan and an evening review on a
// schedule, and a "run now" from the Agents dashboard. It READS the pipeline,
// the queues and the spend, then writes a brief to manager_decisions. It
// creates no tasks and touches no account: autonomy = propose_only is the only
// mode this file implements, so there is nothing for the setting to unlock yet.
// Routing comes later, once these briefs have shown whether its reading of the
// pipeline is any good.
//
// Two rules decide whether a model is involved:
//   - A SCHEDULED run does nothing at all unless the master switch and the
//     manager are both on. Switching the agents off stops the spend, full stop.
//   - A MANUAL run always produces the deterministic facts, even with
//     everything off, because that costs nothing and is how you judge the
//     dashboard before turning anything on. It adds the model's paragraph only
//     when the manager is on, under its daily cap, and a key is configured.
//
// Every time-dependent value is computed once inside the first step and passed
// along. Inngest re-runs this function body from the top for each step, so a
// `new Date()` out here would be a different instant on every pass.
// ============================================================================

type Step = GetStepTools<typeof inngest>

export interface RunRequest {
  kind:        ManagerRunKind
  /** a scheduled run honours the switches; a manual one is explicitly asked for */
  scheduled:   boolean
  requestedBy: string | null
  /** the replay key for a manual run, which has no calendar slot to key on */
  replayKey:   string
}

export interface Gathered {
  skip:     boolean
  metrics:  ManagerMetrics
  autonomy: string
  narrate:  boolean
  dateKey:  string
}

const SEVEN_DAYS_MS = 7 * 24 * 3_600_000

async function gather(req: RunRequest): Promise<Gathered> {
  const supabase = createServiceClient({ system: 'inngest:gtm-manager.gather' })
  const now = new Date()

  const settings = await loadTeamSettings(supabase)
  const rolled = await fetchRollup(supabase, {
    touchesSince: new Date(now.getTime() - SEVEN_DAYS_MS),
    spendSince:   centralDayStart(now),
  })
  if (!rolled.ok) throw new Error(`gtm_dashboard_counts failed: ${rolled.error}`)

  const metrics = buildMetrics(rolled.rollup, settings, now)
  const manager = settingFor(settings, 'manager')

  return {
    skip:     req.scheduled && !isTeamRunnable(settings, 'manager'),
    metrics,
    autonomy: manager?.autonomy ?? 'propose_only',
    narrate:  mayNarrate({
      managerRunnable: isTeamRunnable(settings, 'manager'),
      spentCents:      spentTodayCents(rolled.rollup, 'manager'),
      capCents:        manager?.daily_cost_cap_cents ?? 0,
      hasApiKey:       Boolean(process.env.ANTHROPIC_API_KEY),
    }),
    dateKey: centralDateKey(now),
  }
}

export async function writeBrief(
  req: RunRequest,
  gathered: Gathered,
  narration: NarrationResult | null,
): Promise<{ written: boolean }> {
  const supabase = createServiceClient({ system: 'inngest:gtm-manager.write' })
  const slot = req.scheduled ? `${req.kind}:${gathered.dateKey}` : `manual:${req.replayKey}`
  const used = narration?.ok ? narration : null

  const { error } = await supabase.from('manager_decisions').insert({
    kind:            req.kind,
    autonomy_at_run: gathered.autonomy,
    brief:           renderBrief(req.kind, gathered.metrics, used?.text ?? null),
    metrics:         gathered.metrics as unknown as Json,
    actions:         [],
    model:           used?.model ?? null,
    requested_by:    req.requestedBy,
    dedupe_key:      slot,
  })

  // 23505: this slot already has its brief, from an earlier attempt of this very
  // step. That is not a reason to stop. The attempt that wrote the brief may
  // have died before it recorded the spend, and returning here would lose that
  // row for good, which understates the bill (the unsafe direction for a cap).
  // So fall through: the usage row carries its own dedupe key and a second
  // write of it is a no-op.
  const alreadyWritten = error?.code === '23505'
  if (error && !alreadyWritten) {
    reportError(error, { site: 'inngest.gtm-manager.write-brief', extra: { kind: req.kind } })
    throw error
  }

  if (used) {
    await recordUsage(supabase, {
      team:         'manager',
      model:        used.model,
      inputTokens:  used.inputTokens,
      outputTokens: used.outputTokens,
      dedupeKey:    `manager:${slot}`,
    })
  }
  return { written: !alreadyWritten }
}

async function runManager(step: Step, req: RunRequest) {
  const gathered = await step.run('gather', () => gather(req))
  if (gathered.skip) return { skipped: true as const }

  const narration = gathered.narrate
    ? await step.run('narrate', () => narrateBrief(gathered.metrics))
    : null

  const { written } = await step.run('write-brief', () => writeBrief(req, gathered, narration))
  return { skipped: false as const, written, narrated: narration?.ok === true }
}

export const gtmManagerMorning = inngest.createFunction(
  { id: 'cron-gtm-manager-morning', name: 'Cron: GTM Manager Morning Plan', retries: 2 },
  { cron: '0 12 * * *' },  // 7am CT (UTC-5)
  ({ step }) => runManager(step, { kind: 'morning_plan', scheduled: true, requestedBy: null, replayKey: '' }),
)

export const gtmManagerEvening = inngest.createFunction(
  { id: 'cron-gtm-manager-evening', name: 'Cron: GTM Manager Evening Review', retries: 2 },
  { cron: '0 23 * * *' },  // 6pm CT (UTC-5)
  ({ step }) => runManager(step, { kind: 'evening_review', scheduled: true, requestedBy: null, replayKey: '' }),
)

export const gtmManagerManual = inngest.createFunction(
  { id: 'gtm-manager-manual', name: 'GTM Manager: Run on Request', retries: 1 },
  { event: 'gtm/manager.run.requested' },
  ({ event, step }) => runManager(step, {
    kind:        'manual',
    scheduled:   false,
    requestedBy: event.data.requested_by,
    replayKey:   event.id ?? event.data.requested_by,
  }),
)
