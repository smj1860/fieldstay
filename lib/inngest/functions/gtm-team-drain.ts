import type { GetStepTools } from 'inngest'
import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import type { WorkerTeam }     from '@/lib/gtm/constants'
import { workOne, type HandlerRegistry, type WorkResult } from '@/lib/gtm/worker'

// ============================================================================
// The shared drain every GTM team runs.
//
// Three triggers, one body. A task being created or approved wakes the team at
// once; a 15 minute cron is the correctness backstop, because those events are
// hints and a hint can be lost (the queue, not the event, is the source of
// truth). Every trigger does the same thing: take up to MAX_TASKS_PER_RUN units
// of work, one step each, and stop at the first empty claim.
//
// Each unit is its own step.run() so a failure retries that unit and not the
// ones already finished, and a run stays well inside Inngest's per-run step
// ceiling no matter how deep the queue is. The queue drains across runs.
//
// concurrency 1 per team: the claim is atomic so two workers could never take
// the same task, but one worker per team keeps a slow external read (Lead Gen
// fetches company websites) from running several at once against the same host.
// ============================================================================

type Step = GetStepTools<typeof inngest>

/** Units of work per run. The queue drains across runs, so this is a pace, not a ceiling. */
export const MAX_TASKS_PER_RUN = 5

const DRAIN_CRON = '*/15 * * * *'

export async function drainTeam(step: Step, team: WorkerTeam, registry: HandlerRegistry): Promise<{ processed: number; stoppedBecause: string }> {
  let processed = 0
  for (let i = 0; i < MAX_TASKS_PER_RUN; i++) {
    const result: WorkResult = await step.run(`work-${i}`, () => {
      const supabase = createServiceClient({ system: `inngest:gtm-${team}` })
      return workOne(supabase, team, registry)
    })
    if (!result.worked) return { processed, stoppedBecause: result.reason }
    processed += 1
  }
  return { processed, stoppedBecause: 'run_limit' }
}

export function createTeamDrain(config: { id: string; name: string; team: WorkerTeam; registry: HandlerRegistry }) {
  const mine = `event.data.team == '${config.team}'`
  return inngest.createFunction(
    { id: config.id, name: config.name, retries: 1, concurrency: [{ limit: 1 }] },
    [
      { event: 'gtm/task.created',  if: mine },
      { event: 'gtm/task.approved', if: mine },
      { cron: DRAIN_CRON },
    ],
    ({ step }) => drainTeam(step, config.team, config.registry),
  )
}
