import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { reportError } from '@/lib/observability/report-error'
import { sealPhoto } from '@/lib/evidence/seal'

const MAX_ITEMS = 1_000   // inspection_items per inspection; the form caps are far below this

/**
 * Seals every photo on a just-completed inspection into the evidence ledger.
 *
 * Runs on 'inspection/completed' alongside inspection-completed.ts (which
 * creates remediation work orders); the two are independent and must stay
 * that way, so a seal failure never blocks remediation or vice versa.
 *
 * Idempotent per photo: sealPhoto() collides on
 * evidence_events_capture_unique, so a retry seals only what the previous
 * attempt did not reach. The loop uses `continue`, never `return`.
 */
export const evidenceSealInspection = inngest.createFunction(
  {
    id:   'evidence-seal-inspection',
    name: 'Evidence: Seal Inspection Photos',
    retries: 3,
    concurrency: [{ limit: 10 }, { limit: 1, key: 'event.data.org_id' }],
  },
  { event: 'inspection/completed' },
  async ({ event, step }) => {
    const { org_id: orgId, inspection_id: inspectionId } = event.data

    const sealed = await step.run('seal-photos', async () => {
      const supabase = createServiceClient({ system: 'inngest:evidence-seal-inspection' })

      const { data: inspection, error: iErr } = await supabase
        .from('inspections')
        .select('id, org_id, property_id, completed_by_user_id, inspector_name, device_clock_offset_seconds')
        .eq('id', inspectionId)
        .eq('org_id', orgId)
        .maybeSingle()
      if (iErr || !inspection) {
        if (iErr) reportError(iErr, { site: 'inngest.evidence-seal-inspection.load', orgId })
        return { sealed: 0, skipped: 0 }
      }

      const { data: items, error: itErr } = await supabase
        .from('inspection_items')
        .select('id, photo_path, answered_at')
        .eq('inspection_id', inspectionId)
        .eq('org_id', orgId)
        .not('photo_path', 'is', null)
        .limit(MAX_ITEMS)
      if (itErr) {
        reportError(itErr, { site: 'inngest.evidence-seal-inspection.items', orgId })
        throw itErr   // transient read failure: let the step retry
      }

      let count = 0
      let skipped = 0
      for (const item of items ?? []) {
        if (!item.photo_path) { skipped++; continue }
        // answered_at is the device clock at answer time. The inspection
        // carries the skew measured at start (server minus device, seconds);
        // reuse it so captured_at is corrected the same way started_at was.
        // resolveCapturedAt() recovers that offset as serverNow - deviceNow,
        // so hand it a deviceNow that sits `offset` seconds behind the server.
        const offset = inspection.device_clock_offset_seconds
        const deviceNow = item.answered_at && offset !== null
          ? new Date(Date.now() - offset * 1000).toISOString()
          : null
        const res = await sealPhoto(supabase, { // NOSONAR -- sequential by design: each seal downloads and hashes a photo, so one at a time bounds memory
          orgId,
          propertyId:       inspection.property_id,
          bucket:           'inspection-photos',
          storagePath:      item.photo_path,
          sourceTable:      'inspection_items',
          sourceId:         item.id,
          claimedSha256:    null,
          byteSize:         null,
          deviceCapturedAt: item.answered_at,
          deviceNow,
          lat: null, lng: null, gpsAccuracyFt: null,
          capturedBy:       { kind: 'pm', id: inspection.completed_by_user_id ?? null, label: inspection.inspector_name ?? null },
          turnoverId:       null,
          workOrderId:      null,
          inspectionId:     inspection.id,
        })
        if (res.ok) count++; else skipped++
      }
      return { sealed: count, skipped }
    })

    return sealed
  }
)
