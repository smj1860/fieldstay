'use server'

import { requireOrgRole } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { reportError } from '@/lib/observability/report-error'
import { sealPhoto } from '@/lib/evidence/seal'
import { isUuid } from '@/lib/validation/uuid'

/**
 * Seals a work order photo the PM just uploaded from the New Work Order modal.
 *
 * The modal uploads straight from the browser, which cannot hash against the
 * stored object or measure clock skew, so the seal happens here on the server
 * with server-only provenance (no device claim). It is also what makes these
 * photos count as the "before" record in a claim packet and on the vendor's
 * portal. Best effort: the nightly evidence backfill seals anything this misses.
 *
 * IDOR: the work order must be this org's, and the photo row must exist on that
 * work order at exactly that path, before anything is sealed.
 */
export async function sealWorkOrderPhoto(input: {
  workOrderId: string
  photoId:     string
  storagePath: string
}): Promise<{ success: boolean }> {
  try {
    const { user, supabase, membership } = await requireOrgRole(['admin', 'manager'])
    const orgId = membership.org_id
    if (!isUuid(input.workOrderId) || !isUuid(input.photoId)) return { success: false }

    const { data: wo, error: woErr } = await supabase
      .from('work_orders').select('id, property_id')
      .eq('id', input.workOrderId).eq('org_id', orgId).maybeSingle()
    if (woErr) { reportError(woErr, { site: 'action.maintenance.sealWorkOrderPhoto.workOrder', orgId }); return { success: false } }
    if (!wo) return { success: false }

    const { data: photo, error: photoErr } = await supabase
      .from('work_order_photos').select('id')
      .eq('id', input.photoId).eq('work_order_id', wo.id).eq('storage_path', input.storagePath).maybeSingle()
    if (photoErr) { reportError(photoErr, { site: 'action.maintenance.sealWorkOrderPhoto.photo', orgId }); return { success: false } }
    if (!photo) return { success: false }

    const result = await sealPhoto(createServiceClient({ authorizedBy: membership }), {
      orgId, propertyId: wo.property_id, bucket: 'work-order-photos', storagePath: input.storagePath,
      sourceTable: 'work_order_photos', sourceId: photo.id,
      claimedSha256: null, byteSize: null, deviceCapturedAt: null, deviceNow: null,
      lat: null, lng: null, gpsAccuracyFt: null,
      capturedBy: { kind: 'pm', id: user.id, label: null },
      turnoverId: null, workOrderId: wo.id, inspectionId: null,
    })
    return { success: result.ok }
  } catch (err) {
    reportError(err, { site: 'action.maintenance.sealWorkOrderPhoto' })
    return { success: false }
  }
}
