import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchDistinctOrgIds } from '@/lib/inngest/paginate'
import { sendEventsChunked, chunkArray, IN_CLAUSE_CHUNK_SIZE } from '@/lib/inngest/chunk'
import { unwrapList } from '@/lib/supabase/unwrap'
import { bracketEvidenceEvent } from '@/lib/evidence/bracket'

/** Turnover date changes older than this are assumed already re-bracketed by a previous run. */
const REBRACKET_LOOKBACK_DAYS = 3
const MAX_TURNOVERS_PER_RUN = 500
const MAX_EVENTS_PER_RUN = 1_000

export const evidenceRebracketCron = inngest.createFunction(
  { id: 'cron-evidence-rebracket', name: 'Cron: Evidence Re-bracket', retries: 2 },
  { cron: '45 8 * * *' },
  async ({ step, logger }) => {
    const orgIds = await step.run('find-orgs', async () => {
      const supabase = createServiceClient({ system: 'inngest:evidence-rebracket' })
      return fetchDistinctOrgIds(
        (from, to) => supabase.from('properties').select('org_id').eq('is_active', true)
          .order('org_id', { ascending: true }).range(from, to),
        { label: 'properties(evidence-rebracket)' },
      )
    })
    await sendEventsChunked(step, 'fan-out-evidence-rebracket',
      orgIds.map((orgId) => ({ name: 'evidence/rebracket.requested' as const, data: { org_id: orgId } })))
    logger.info(`Evidence re-bracket: dispatched ${orgIds.length} org(s)`)
    return { dispatched: orgIds.length }
  },
)

interface StaleCheck { eventId: string }

/** Stale events among one chunk of turnovers: sealed after the fact, or bracketed before the dates moved. */
async function staleInChunk(
  supabase: ReturnType<typeof createServiceClient>, orgId: string,
  turnoverIds: readonly string[], changedAt: ReadonlyMap<string, string>,
): Promise<StaleCheck[]> {
  const evRes = await supabase
    .from('evidence_events').select('id, turnover_id')
    .eq('org_id', orgId).eq('kind', 'photo_sealed').in('turnover_id', turnoverIds as string[]).limit(MAX_EVENTS_PER_RUN)
  const events = unwrapList(evRes, { site: 'inngest.evidence-rebracket.events', orgId })
  if (events.length === 0) return []

  const brRes = await supabase
    .from('evidence_stay_brackets').select('evidence_event_id, bracketed_at')
    .eq('org_id', orgId).in('evidence_event_id', events.map((e) => e.id)).limit(events.length * 4)
  const newest = new Map<string, string>()
  for (const b of unwrapList(brRes, { site: 'inngest.evidence-rebracket.brackets', orgId })) {
    const cur = newest.get(b.evidence_event_id)
    if (!cur || b.bracketed_at > cur) newest.set(b.evidence_event_id, b.bracketed_at)
  }
  return events
    .filter((e) => {
      const moved = e.turnover_id ? changedAt.get(e.turnover_id) : undefined
      const bracketed = newest.get(e.id)
      return moved !== undefined && (!bracketed || bracketed < moved)
    })
    .map((e) => ({ eventId: e.id }))
}

/**
 * Evidence whose turnover's dates moved AFTER it was last bracketed. A turnover
 * photo brackets the stays that surround the turnover; when a booking is
 * extended or cancelled the surrounding stays change and the old bracket rows
 * point at the wrong ones. Brackets are derived and recomputable on purpose.
 */
async function findStaleEvents(orgId: string, nowMs: number): Promise<StaleCheck[]> {
  const supabase = createServiceClient({ system: 'inngest:evidence-rebracket' })
  const since = new Date(nowMs - REBRACKET_LOOKBACK_DAYS * 86_400_000).toISOString()

  const turnoverRes = await supabase
    .from('turnovers').select('id, dates_changed_at')
    .eq('org_id', orgId).gte('dates_changed_at', since).limit(MAX_TURNOVERS_PER_RUN)
  const changedAt = new Map(unwrapList(turnoverRes, { site: 'inngest.evidence-rebracket.turnovers', orgId })
    .map((t) => [t.id, t.dates_changed_at as string]))

  const stale: StaleCheck[] = []
  for (const chunk of chunkArray([...changedAt.keys()], IN_CLAUSE_CHUNK_SIZE)) {
    stale.push(...await staleInChunk(supabase, orgId, chunk, changedAt))
  }
  return stale
}

/** Finds the stale evidence for one org and hands each to the single-event handler below. */
export const evidenceRebracketOrg = inngest.createFunction(
  {
    id: 'evidence-rebracket-org', name: 'Evidence: Re-bracket (org)', retries: 2,
    concurrency: [{ limit: 5 }, { limit: 1, key: 'event.data.org_id' }],
  },
  { event: 'evidence/rebracket.requested' },
  async ({ event, step }) => {
    const orgId = event.data.org_id
    const stale = await step.run('find-stale', () => findStaleEvents(orgId, Date.now()))
    await sendEventsChunked(step, 'fan-out-bracket',
      stale.map((s) => ({ name: 'evidence/bracket.requested' as const, data: { org_id: orgId, event_id: s.eventId } })))
    return { stale: stale.length }
  },
)

/** Recomputes the brackets for one evidence event. bracketEvidenceEvent is delete-then-upsert, so a replay is harmless. */
export const evidenceBracketOne = inngest.createFunction(
  {
    id: 'evidence-bracket-one', name: 'Evidence: Bracket One', retries: 3,
    concurrency: [{ limit: 10 }, { limit: 5, key: 'event.data.org_id' }],
  },
  { event: 'evidence/bracket.requested' },
  async ({ event, step }) => {
    const { org_id: orgId, event_id: eventId } = event.data
    await step.run('bracket', async () => {
      const supabase = createServiceClient({ system: 'inngest:evidence-rebracket' })
      await bracketEvidenceEvent(supabase, { orgId, eventId })
    })
    return { ok: true }
  },
)
