import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { unwrapJoin }          from '@/lib/utils/supabase-joins'
import type { TablesInsert }   from '@/types/database'
import { unwrapList }          from '@/lib/supabase/unwrap'

const ALPHA_PRIOR = 2  // prior: assume "probably clean"
const BETA_PRIOR  = 1  // prior: with small upward bias on flag probability
const PHOTO_THRESHOLD = 0.20  // flag probability >= 20% → require photo

// Rolling observation window. The original pass fetched ALL completed items
// ever ("Bayesian models work better with full history") — but with
// cumulative counts old observations are never actually down-weighted, they
// accumulate forever: a task that was messy a year ago and clean for six
// months would keep requiring photos, and the unbounded fetch grows with
// platform age × turnover volume (an OOM/step-payload time bomb, and
// silently truncated by PostgREST's max-rows cap anyway). 180 days keeps
// the signal responsive and the working set bounded; the priors still
// smooth low-history groups.
const OBSERVATION_WINDOW_DAYS = 180
const FETCH_PAGE_SIZE = 1000


/** One completed checklist row, as the windowed read returns it. */
interface CompletionRow {
  section_name:        string
  task:                string
  crew_notes:          string | null
  photo_storage_path:  string | null
  requires_photo:      boolean
  checklist_instances: unknown
}

/**
 * A completion counts as flagged when the crew left a note on it, or when it
 * required a photo and none was attached.
 */
function isFlagged(item: CompletionRow): boolean {
  return Boolean(item.crew_notes?.trim()) || (item.requires_photo && !item.photo_storage_path)
}

/** Groups completions by property + section + task + org. */
function groupCompletions(items: CompletionRow[]): Map<string, CompletionRow[]> {
  const groups = new Map<string, CompletionRow[]>()

  for (const item of items) {
    const inst = unwrapJoin(item.checklist_instances) as { turnovers?: unknown } | null
    if (!inst) continue

    const tvo = unwrapJoin(inst.turnovers) as { org_id?: string; property_id?: string } | null
    if (!tvo?.org_id || !tvo.property_id) continue

    const key   = `${tvo.property_id}|${item.section_name}|${item.task}|${tvo.org_id}`
    const group = groups.get(key)
    if (group) group.push(item)
    else groups.set(key, [item])
  }

  return groups
}

/** Flags from the most recent completion backwards — for the reason string. */
function consecutiveFlags(completions: CompletionRow[]): number {
  let consecutive = 0
  for (const c of completions) {
    if (!isFlagged(c)) break
    consecutive++
  }
  return consecutive
}

/**
 * The human-readable reason shown to crew and PM, or null when the item is
 * below the photo threshold and needs no explanation.
 */
function signalReason(
  { flagProb, completions }: { flagProb: number; completions: CompletionRow[] },
): string | null {
  if (flagProb < PHOTO_THRESHOLD) return null

  const consecutive = consecutiveFlags(completions)
  if (consecutive >= 3) return `Flagged on ${consecutive} consecutive turnovers`

  const total = completions.length
  const flags = completions.filter(isFlagged).length
  if (total < 5) return `Flagged ${flags} of ${total} completions (limited history)`

  return `Flagged in ~${Math.round(flagProb * 100)}% of completions`
}

/**
 * The Bayesian posterior for every property+section+task group.
 *
 * `dynamic_photo_required` and `flag_probability` are GENERATED columns and
 * are deliberately absent from the payload — Postgres computes them, and
 * naming one here would make Postgres reject the whole statement.
 */
function computeSignalUpserts(
  items: CompletionRow[],
): { upserts: TablesInsert<'checklist_item_signals'>[]; required: number } {
  const upserts: TablesInsert<'checklist_item_signals'>[] = []
  let required = 0

  for (const [key, completions] of groupCompletions(items)) {
    const [property_id, section_name, task, org_id] = key.split('|') as [string, string, string, string]

    const total_completions = completions.length
    const total_flags       = completions.filter(isFlagged).length

    // Bayesian update: posterior = prior + observations
    const alpha = ALPHA_PRIOR + (total_completions - total_flags)
    const beta  = BETA_PRIOR  + total_flags

    // flag_probability = beta / (alpha + beta) — same formula as the
    // GENERATED column in Postgres, computed here only for the reason string
    const flagProb = beta / (alpha + beta)
    if (flagProb >= PHOTO_THRESHOLD) required++

    upserts.push({
      org_id, property_id, section_name, task,
      alpha, beta,
      reason: signalReason({ flagProb, completions }),
      total_completions,
      total_flags,
      computed_at: new Date().toISOString(),
    })
  }

  return { upserts, required }
}

export const computeChecklistSignals = inngest.createFunction(
  {
    id:      'cron-checklist-signals',
    name:    'Cron: Bayesian Checklist Signal Update',
    retries: 1,
  },
  { cron: '0 4 * * *' }, // 11pm CT, before the 8am asset health run
  async ({ step, logger }) => {
    // Fetch completed checklist items within the rolling window, with their
    // property and org context. Paginated explicitly — a single unpaginated
    // select is silently capped at PostgREST's max-rows limit, which would
    // truncate history without any error. completed_at DESC ordering is
    // load-bearing for streak detection below.
    const items = await step.run('fetch-windowed-completions', async () => {
      const supabase = createServiceClient({ system: 'inngest:checklist-signals' })
      const windowStart = new Date(Date.now() - OBSERVATION_WINDOW_DAYS * 86_400_000).toISOString()

      type Page = Awaited<ReturnType<typeof fetchPage>>
      async function fetchPage(offset: number) {
        // The discarded error on this read is exactly what hid the
        // checklist_instances.property_id bug: PostgREST rejected the whole
        // select on the unknown column, `data` came back null, `data ?? []`
        // turned that into "no completions", and the cron reported success
        // while computing nothing for months. unwrapList throws instead.
        const res = await supabase
          .from('checklist_instance_items')
          .select(`
            id, section_name, task,
            crew_notes, photo_storage_path, requires_photo,
            is_completed, completed_at,
            checklist_instances!inner (
              turnovers!inner ( org_id, property_id )
            )
          `)
          .eq('is_completed', true)
          .gte('completed_at', windowStart)
          .order('completed_at', { ascending: false })
          .range(offset, offset + FETCH_PAGE_SIZE - 1)

        return unwrapList(res, { site: 'inngest.checklist-signals.fetch-windowed-completions' })
      }

      const all: Page = []
      for (let offset = 0; ; offset += FETCH_PAGE_SIZE) {
        const page = await fetchPage(offset)
        all.push(...page)
        if (page.length < FETCH_PAGE_SIZE) break
      }
      return all
    })

    logger.info(`[checklistSignals] Processing ${items.length} completed items`)

    const { upserts, required } = computeSignalUpserts(items)

    // Upsert in chunks of 200 to stay well under Supabase's payload limits.
    // Wrapped in a single step so it's memoized — a mid-loop failure won't
    // force re-running the expensive read + grouping pass above.
    await step.run('persist-signals', async () => {
      const supabase = createServiceClient({ system: 'inngest:checklist-signals' })
      const CHUNK = 200
      for (let i = 0; i < upserts.length; i += CHUNK) {
        const { error } = await supabase
          .from('checklist_item_signals')
          .upsert(upserts.slice(i, i + CHUNK), {
            onConflict: 'property_id,section_name,task',
          })
        if (error) throw new Error(`checklist_item_signals upsert failed: ${error.message}`)
      }
    })

    logger.info(`[checklistSignals] Upserted ${upserts.length} signals, ${required} requiring photo`)
    return { computed: upserts.length, photo_required: required }
  }
)
