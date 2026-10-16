import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchDistinctOrgIds } from '@/lib/inngest/paginate'
import { sendEventsChunked, chunkArray } from '@/lib/inngest/chunk'
import { reportError } from '@/lib/observability/report-error'
import { findUnsealed, type Pointer } from '@/lib/evidence/backfill'
import { sealPhoto } from '@/lib/evidence/seal'

const SEAL_BATCH = 25

/** Daily dispatcher: one 'evidence/backfill.requested' per org with any property. */
export const evidenceBackfillCron = inngest.createFunction(
  { id: 'cron-evidence-backfill', name: 'Cron: Evidence Backfill', retries: 2 },
  { cron: '30 8 * * *' },   // 3:30am CT, after the nightly crew syncs have settled
  async ({ step, logger }) => {
    const orgIds = await step.run('find-orgs', () => {
      const supabase = createServiceClient({ system: 'inngest:evidence-backfill' })
      return fetchDistinctOrgIds(
        (from, to) => supabase.from('properties').select('org_id').eq('is_active', true)
          .order('org_id', { ascending: true }).range(from, to),
        { label: 'properties(evidence-backfill)' },
      )
    })
    await sendEventsChunked(step, 'fan-out-evidence-backfill',
      orgIds.map((orgId) => ({ name: 'evidence/backfill.requested' as const, data: { org_id: orgId } })))
    logger.info(`Evidence backfill: dispatched ${orgIds.length} org(s)`)
    return { dispatched: orgIds.length }
  },
)

/**
 * Seals this org's unsealed photo pointers. Idempotent per photo: sealPhoto()
 * collides on evidence_events_capture_unique, so a retry seals only what the
 * previous attempt did not reach. The loop uses `continue`, never `return`.
 *
 * This is also what covers PM-uploaded work order photos (the PM modal cannot
 * seal from the browser) and any crew photo whose seal request was lost.
 */
export const evidenceBackfillOrg = inngest.createFunction(
  {
    id: 'evidence-backfill-org', name: 'Evidence: Backfill (org)', retries: 2,
    concurrency: [{ limit: 5 }, { limit: 1, key: 'event.data.org_id' }],
  },
  { event: 'evidence/backfill.requested' },
  async ({ event, step }) => {
    const orgId = event.data.org_id

    const pending = await step.run('find-unsealed', () => {
      const supabase = createServiceClient({ system: 'inngest:evidence-backfill' })
      return findUnsealed(supabase, orgId, Date.now())
    })

    let sealed = 0
    let skipped = 0
    const batches = chunkArray(pending, SEAL_BATCH)
    for (let i = 0; i < batches.length; i++) {
      const result = await step.run(`seal-batch-${i}`, () => sealBatch(orgId, batches[i])) // NOSONAR -- one Inngest step per batch, run in order so each batch is its own retry boundary
      sealed += result.sealed
      skipped += result.skipped
    }
    return { found: pending.length, sealed, skipped }
  },
)

async function sealBatch(orgId: string, batch: readonly Pointer[]): Promise<{ sealed: number; skipped: number }> {
  const supabase = createServiceClient({ system: 'inngest:evidence-backfill' })
  let sealed = 0
  let skipped = 0
  for (const p of batch) {
    try {
      const res = await sealPhoto(supabase, { // NOSONAR -- sequential by design: each seal downloads and hashes a photo, so one at a time bounds memory
        orgId, propertyId: p.propertyId, bucket: p.bucket, storagePath: p.path,
        sourceTable: p.sourceTable, sourceId: p.sourceId,
        claimedSha256: null, byteSize: null,
        deviceCapturedAt: null, deviceNow: null, observedAt: p.observedAt,
        lat: null, lng: null, gpsAccuracyM: null,
        capturedBy: { kind: 'system', id: null, label: 'backfill' },
        turnoverId: p.turnoverId, workOrderId: p.workOrderId, inspectionId: p.inspectionId,
        metadata: { backfill: true },
      })
      if (res.ok) sealed++; else skipped++
    } catch (err) {
      reportError(err, { site: 'inngest.evidence-backfill.seal', orgId })
      skipped++
    }
  }
  return { sealed, skipped }
}
