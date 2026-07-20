import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { unwrapJoin }          from '@/lib/utils/supabase-joins'

const ALPHA_PRIOR = 2  // prior: assume "probably clean"
const BETA_PRIOR  = 1  // prior: with small upward bias on flag probability
const PHOTO_THRESHOLD = 0.20  // flag probability >= 20% → require photo

export const computeChecklistSignals = inngest.createFunction(
  {
    id:      'cron-checklist-signals',
    name:    'Cron: Bayesian Checklist Signal Update',
    retries: 1,
  },
  { cron: '0 4 * * *' }, // 11pm CT, before the 8am asset health run
  async ({ step, logger }) => {
    // Fetch all completed checklist items with their property and org context.
    // No rolling window — Bayesian models work better with full history (old
    // data is naturally down-weighted by the prior's relative strength vs
    // total observation count). Use completed_at ordering for streak detection.
    const items = await step.run('fetch-all-completions', async () => {
      const supabase = createServiceClient()
      const { data } = await supabase
        .from('checklist_instance_items')
        .select(`
          id, section_name, task,
          crew_notes, photo_storage_path, requires_photo,
          is_completed, completed_at,
          checklist_instances!inner (
            property_id,
            turnovers!inner ( org_id )
          )
        `)
        .eq('is_completed', true)
        .order('completed_at', { ascending: false })

      return data ?? []
    })

    logger.info(`[checklistSignals] Processing ${items.length} completed items`)

    // Group by property + section + task
    type ItemRow = (typeof items)[number]
    const groups = new Map<string, ItemRow[]>()

    for (const item of items) {
      const inst = unwrapJoin(item.checklist_instances)
      if (!inst) continue

      const turnoversRaw = (inst as unknown as { turnovers: { org_id: string } | { org_id: string }[] }).turnovers
      const tvo = unwrapJoin(turnoversRaw)
      if (!tvo?.org_id) continue

      const key = `${(inst as { property_id: string }).property_id}|${item.section_name}|${item.task}|${tvo.org_id}`
      if (!groups.has(key)) groups.set(key, [])
      groups.get(key)!.push(item)
    }

    const upserts: object[] = []

    for (const [key, completions] of groups) {
      const [property_id, section_name, task, org_id] = key.split('|') as [string, string, string, string]

      const isFlagged = (item: ItemRow): boolean =>
        Boolean(item.crew_notes?.trim()) ||
        (item.requires_photo && !item.photo_storage_path)

      const total_completions = completions.length
      const total_flags       = completions.filter(isFlagged).length

      // Bayesian update: posterior = prior + observations
      const alpha = ALPHA_PRIOR + (total_completions - total_flags)
      const beta  = BETA_PRIOR  + total_flags

      // flag_probability = beta / (alpha + beta) — same formula as the
      // GENERATED column in Postgres, computed here only for the reason string
      const flagProb = beta / (alpha + beta)

      // Consecutive flags from most-recent: for the reason string only
      let consecutive = 0
      for (const c of completions) {
        if (isFlagged(c)) consecutive++
        else break
      }

      // Human-readable reason — shown to crew + PM so they understand why
      let reason: string | null = null
      if (flagProb >= PHOTO_THRESHOLD) {
        if (consecutive >= 3) {
          reason = `Flagged on ${consecutive} consecutive turnovers`
        } else if (total_completions < 5) {
          reason = `Flagged ${total_flags} of ${total_completions} completions (limited history)`
        } else {
          reason = `Flagged in ~${Math.round(flagProb * 100)}% of completions`
        }
      }

      upserts.push({
        org_id, property_id, section_name, task,
        alpha, beta,
        // dynamic_photo_required and flag_probability are GENERATED columns —
        // do NOT include them in the upsert payload, Postgres computes them
        reason,
        total_completions,
        total_flags,
        computed_at: new Date().toISOString(),
      })
    }

    // Upsert in chunks of 200 to stay well under Supabase's payload limits.
    // Wrapped in a single step so it's memoized — a mid-loop failure won't
    // force re-running the expensive read + grouping pass above.
    await step.run('persist-signals', async () => {
      const supabase = createServiceClient()
      const CHUNK = 200
      for (let i = 0; i < upserts.length; i += CHUNK) {
        await supabase
          .from('checklist_item_signals')
          .upsert(upserts.slice(i, i + CHUNK), {
            onConflict: 'property_id,section_name,task',
          })
      }
    })

    const required = upserts.filter((u) => {
      const typed = u as { alpha: number; beta: number }
      return typed.beta / (typed.alpha + typed.beta) >= PHOTO_THRESHOLD
    }).length

    logger.info(`[checklistSignals] Upserted ${upserts.length} signals, ${required} requiring photo`)
    return { computed: upserts.length, photo_required: required }
  }
)
