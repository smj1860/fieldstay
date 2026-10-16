import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { createPmNotification } from '@/lib/inngest/helpers'
import { reportError } from '@/lib/observability/report-error'
import { MIN_PROOF_PHOTOS } from '@/lib/evidence/freeze-watch'

/**
 * When a freeze_watch work order completes with enough photos, writes ONE
 * proof_of_care row to the evidence ledger that points at the sealed photo
 * events. That row, plus the photos it references, is what a PM hands an
 * insurer: dated proof the property was winterised before the loss.
 *
 * Listens on work-order/completed like work-order-events.ts does; ignores any
 * source other than freeze_watch. Idempotent on evidence_events_capture_unique:
 * (org, bucket 'work-order-photos', storage_path '<wo-id>/proof-of-care',
 * kind 'proof_of_care') is one row per work order.
 */
export const evidenceProofOfCare = inngest.createFunction(
  {
    id:   'evidence-proof-of-care',
    name: 'Evidence: Proof of Care',
    retries: 3,
    concurrency: { limit: 1, key: 'event.data.work_order_id' },
  },
  { event: 'work-order/completed' },
  ({ event, step }) => {
    const { org_id: orgId, work_order_id: workOrderId, property_id: propertyId } = event.data

    return step.run('write-proof-of-care', async () => {
      const supabase = createServiceClient({ system: 'inngest:evidence-proof-of-care' })

      const { data: wo, error: wErr } = await supabase
        .from('work_orders')
        .select('id, source, vendor_id, needed_by_date, completed_date')
        .eq('id', workOrderId)
        .eq('org_id', orgId)
        .maybeSingle()
      if (wErr) { reportError(wErr, { site: 'inngest.evidence-proof-of-care.load', orgId }); throw wErr }
      if (wo?.source !== 'freeze_watch') return { written: false, reason: 'not_freeze_watch' }

      const { data: seals, error: sErr } = await supabase
        .from('evidence_events')
        .select('id, storage_path')
        .eq('org_id', orgId)
        .eq('work_order_id', workOrderId)
        .eq('kind', 'photo_sealed')
        .limit(100)
      if (sErr) { reportError(sErr, { site: 'inngest.evidence-proof-of-care.seals', orgId }); throw sErr }

      const sealed = seals ?? []
      if (sealed.length < MIN_PROOF_PHOTOS) {
        await createPmNotification(supabase, {
          orgId,
          type:      'evidence_incomplete',
          title:     'Freeze prep completed without enough photos',
          subtitle:  `${sealed.length} of ${MIN_PROOF_PHOTOS} required photos were recorded. The proof of care record was not written.`,
          href:      `/maintenance?wo=${workOrderId}`,
          severity:  'amber',
          dedupeKey: `proof-of-care-short-${workOrderId}`,
        })
        return { written: false, reason: 'insufficient_photos', count: sealed.length }
      }

      const { error: insErr } = await supabase.from('evidence_events').insert({
        org_id:             orgId,
        property_id:        propertyId,
        kind:               'proof_of_care',
        source_table:       'work_order_photos',
        source_id:          workOrderId,
        bucket:             'work-order-photos',
        storage_path:       `${orgId}/work-orders/${workOrderId}/proof-of-care`,
        sha256:             '0'.repeat(64),   // a proof row carries no bytes; the photos it cites carry theirs
        // completed_date is a bare date; the instant that matters is when the
        // completion event reached us, which is moments after the PM or vendor tapped it.
        captured_at:        new Date().toISOString(),
        captured_at_source: 'server',
        captured_by_kind:   'system',
        captured_by_id:     null,
        captured_by_label:  'freeze_watch',
        work_order_id:      workOrderId,
        metadata: {
          needed_by_date:   wo.needed_by_date,
          completed_date:   wo.completed_date,
          vendor_id:        wo.vendor_id,
          photo_event_ids:  sealed.map((s) => s.id),
          photo_count:      sealed.length,
        },
      })
      if (insErr && insErr.code !== '23505') {
        reportError(insErr, { site: 'inngest.evidence-proof-of-care.insert', orgId })
        throw insErr
      }

      await createPmNotification(supabase, {
        orgId,
        type:      'evidence_proof_of_care',
        title:     'Proof of care recorded',
        subtitle:  `Freeze prep documented with ${sealed.length} sealed photos.`,
        href:      `/properties/${propertyId}/evidence`,
        severity:  'green',
        dedupeKey: `proof-of-care-${workOrderId}`,
      })
      return { written: insErr?.code !== '23505', count: sealed.length }
    })
  },
)
