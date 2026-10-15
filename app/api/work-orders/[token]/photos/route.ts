import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { workOrderRatelimit, checkLimit } from '@/lib/rate-limit'
import { extractClientIp } from '@/lib/integrations/webhook-verification'
import { isRealQueryError, throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'
import { reportError } from '@/lib/observability/report-error'
import { sealPhoto } from '@/lib/evidence/seal'
import { createHash } from 'node:crypto'

/**
 * POST /api/work-orders/[token]/photos — upload completion photos, one call
 * per file. Uploaded eagerly as the vendor selects each photo (not bundled
 * into the completion submission), so photos land in storage regardless of
 * whether the final "mark complete" tap happens to be queued offline.
 *
 * DELETE /api/work-orders/[token]/photos — remove a photo the vendor
 * decided to take back before completing.
 *
 * Public endpoint — no auth required, same token-gate shape as .../complete.
 */

const MAX_PHOTOS      = 5
/**
 * Photos EVER uploaded to one work order, withdrawn ones included. A vendor
 * delete keeps the Storage object (evidence is never deleted), so counting only
 * live rows against MAX_PHOTOS would let a public-token holder upload and delete
 * in a loop and grow the bucket without bound.
 */
const MAX_LIFETIME_PHOTOS = 15
const MAX_PHOTO_BYTES = 10 * 1024 * 1024  // 10 MB
const ALLOWED_MIME    = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
}

// Abuse/enumeration limiter → fails OPEN: a degraded Redis must never block
// a legitimate contractor's photo upload on a public token route.
async function checkPhotoRateLimit(request: NextRequest): Promise<NextResponse | null> {
  const decision = await checkLimit(workOrderRatelimit, `wo-photo:${extractClientIp(request) ?? 'unknown'}`, {
    onError: 'allow',
    site:    'route.work-orders.photos.checkPhotoRateLimit',
  })
  if (!decision.allowed) {
    return NextResponse.json({ error: 'Too many requests. Please try again in a minute.' }, { status: 429 })
  }
  return null
}

async function loadOpenWorkOrder(token: string) {
  const supabase = createServiceClient({ publicSurface: 'api-work-orders--token--photos' })

  const { data: workOrder, error } = await supabase
    .from('work_orders')
    .select('id, org_id, property_id, vendor_id, status, portal_enabled, completion_token_expires_at')
    .eq('completion_token', token)
    .single()

  if (isRealQueryError(error)) {
    throwIfAnyQueryFailed({ site: 'route.work-orders.photos.loadOpenWorkOrder' }, error)
  }
  if (!workOrder) return { error: NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 }) }
  if (!workOrder.portal_enabled) {
    return { error: NextResponse.json({ error: 'Vendor portal not enabled for this work order' }, { status: 403 }) }
  }
  if (workOrder.status === 'completed' || workOrder.status === 'cancelled') {
    return { error: NextResponse.json({ error: 'Work order already closed' }, { status: 409 }) }
  }
  if (
    workOrder.completion_token_expires_at &&
    new Date(workOrder.completion_token_expires_at) < new Date()
  ) {
    return { error: NextResponse.json({ error: 'Link has expired' }, { status: 410 }) }
  }

  return { supabase, workOrder }
}

type PortalClient = ReturnType<typeof createServiceClient>
interface PortalWorkOrder { id: string; org_id: string; property_id: string; vendor_id: string | null }

/**
 * Seals a just-uploaded vendor photo with server-only provenance: the vendor's
 * browser gave us no device clock and no hash, recorded honestly as
 * captured_at_source = 'server'. Never throws; a failed seal is reported.
 */
async function sealVendorPhoto(
  supabase:  PortalClient,
  workOrder: PortalWorkOrder,
  photo:     { path: string; uploadedBy: string; photoId: string; file: File },
): Promise<void> {
  const bytes = await photo.file.arrayBuffer()
  const sealResult = await sealPhoto(supabase, {
    orgId:            workOrder.org_id,
    propertyId:       workOrder.property_id,
    bucket:           'work-order-photos',
    storagePath:      photo.path,
    sourceTable:      'work_order_photos',
    sourceId:         photo.photoId,
    claimedSha256:    createHash('sha256').update(Buffer.from(bytes)).digest('hex'),
    byteSize:         bytes.byteLength,
    deviceCapturedAt: null,
    deviceNow:        null,
    lat: null, lng: null, gpsAccuracyM: null,
    capturedBy:       { kind: 'vendor', id: workOrder.vendor_id ?? null, label: photo.uploadedBy },
    turnoverId:       null,
    workOrderId:      workOrder.id,
    inspectionId:     null,
  })
  if (!sealResult.ok) {
    reportError(new Error(`vendor photo seal failed: ${sealResult.reason}`), {
      site: 'api.work-orders.photos.seal', orgId: workOrder.org_id,
    })
  }
}

/**
 * Per-request AND lifetime photo ceilings for one work order. Returns the
 * rejecting response, or null when the upload may proceed.
 */
async function checkUploadAllowance(
  supabase: PortalClient, workOrder: PortalWorkOrder, incoming: number,
): Promise<NextResponse | null> {
  // Count against the running total for this WO, not just this request:
  // a vendor uploading one-at-a-time could otherwise exceed MAX_PHOTOS
  // across several calls.
  const { count: existingCount } = await supabase
    .from('work_order_photos')
    .select('id', { count: 'exact', head: true })
    .eq('work_order_id', workOrder.id)
  if ((existingCount ?? 0) + incoming > MAX_PHOTOS) {
    return NextResponse.json({ error: `Maximum ${MAX_PHOTOS} photos allowed per work order` }, { status: 400 })
  }

  const { count: everSealed, error: everErr } = await supabase
    .from('evidence_events')
    .select('id', { count: 'exact', head: true })
    .eq('org_id', workOrder.org_id)
    .eq('work_order_id', workOrder.id)
    .eq('kind', 'photo_sealed')
  if (everErr) {
    reportError(everErr, { site: 'api.work-orders.photos.lifetimeCount', orgId: workOrder.org_id })
    return NextResponse.json({ error: 'Failed to upload photo. Please try again.' }, { status: 500 })
  }
  if (Math.max(existingCount ?? 0, everSealed ?? 0) + incoming > MAX_LIFETIME_PHOTOS) {
    return NextResponse.json({ error: 'This work order has reached its photo upload limit. Contact the property manager.' }, { status: 400 })
  }
  return null
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  const rateLimited = await checkPhotoRateLimit(request)
  if (rateLimited) return rateLimited

  const loaded = await loadOpenWorkOrder(token)
  if ('error' in loaded) return loaded.error
  const { supabase, workOrder } = loaded

  const formData = await request.formData().catch(() => null)
  if (!formData) return NextResponse.json({ error: 'Invalid upload' }, { status: 400 })

  const files = formData.getAll('photos').filter((v): v is File => v instanceof File)
  if (files.length === 0) return NextResponse.json({ error: 'No photos provided' }, { status: 400 })
  if (files.length > MAX_PHOTOS) {
    return NextResponse.json({ error: `Maximum ${MAX_PHOTOS} photos allowed` }, { status: 400 })
  }

  const uploadedBy = (formData.get('uploadedBy') as string | null)?.trim() || 'vendor-portal'

  const blocked = await checkUploadAllowance(supabase, workOrder, files.length)
  if (blocked) return blocked

  const uploaded: Array<{ id: string; storage_path: string }> = []

  for (const file of files) {
    if (file.size > MAX_PHOTO_BYTES) {
      return NextResponse.json({ error: 'Each photo must be under 10 MB' }, { status: 400 })
    }
    if (!ALLOWED_MIME.has(file.type)) {
      return NextResponse.json({ error: 'Only JPEG, PNG, WebP, or HEIC photos are accepted' }, { status: 400 })
    }

    // Client-generated UUID path — work_order_photos.storage_path has a
    // global unique index (not scoped per WO), so a naive scheme risks a
    // real collision across concurrently-uploaded photos.
    // Path MUST start with the owning org's id: the work-order-photos bucket
    // moves from public=true to private + org-scoped storage RLS policies,
    // which key off `(storage.foldername(name))[1] = org_id`. A path without
    // that leading segment is unreachable by every policy and by every signed
    // URL request.
    const ext  = EXT_BY_MIME[file.type] ?? 'jpg'
    const path = `${workOrder.org_id}/work-orders/${workOrder.id}/completion/${crypto.randomUUID()}.${ext}`

    const { error: uploadErr } = await supabase.storage
      .from('work-order-photos')
      .upload(path, file, { contentType: file.type, upsert: false })

    if (uploadErr) {
      console.error('[work-orders/photos] upload failed', uploadErr)
      return NextResponse.json({ error: 'Failed to upload photo. Please try again.' }, { status: 500 })
    }

    const { data: inserted, error: insertErr } = await supabase
      .from('work_order_photos')
      .insert({
        work_order_id: workOrder.id,
        storage_path:  path,
        uploaded_by:   uploadedBy,
      })
      .select('id, storage_path')
      .single()

    if (insertErr || !inserted) {
      console.error('[work-orders/photos] insert failed', insertErr)
      // Clean up the now-orphaned storage object rather than leaving a
      // file with no DB row pointing at it.
      await supabase.storage.from('work-order-photos').remove([path])
      return NextResponse.json({ error: 'Failed to save photo. Please try again.' }, { status: 500 })
    }

    // Non-fatal to the vendor: the photo is stored and the row exists; the
    // backfill cron seals anything with a row and no ledger entry.
    await sealVendorPhoto(supabase, workOrder, { path, uploadedBy, photoId: inserted.id, file })

    uploaded.push(inserted)
  }

  return NextResponse.json({ success: true, uploaded })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  const rateLimited = await checkPhotoRateLimit(request)
  if (rateLimited) return rateLimited

  const loaded = await loadOpenWorkOrder(token)
  if ('error' in loaded) return loaded.error
  const { supabase, workOrder } = loaded

  const body = await request.json().catch(() => ({}))
  const photoId = typeof body.photoId === 'string' ? body.photoId : null
  if (!photoId) return NextResponse.json({ error: 'photoId required' }, { status: 400 })

  const { data: photo, error: photoError } = await supabase
    .from('work_order_photos')
    .select('id, storage_path, work_order_id')
    .eq('id', photoId)
    .single()

  if (isRealQueryError(photoError)) {
    throwIfAnyQueryFailed({ site: 'route.work-orders.photos.DELETE' }, photoError)
  }

  // Ownership check — the token proves access to workOrder.id, not to any
  // photo id a caller might supply, so confirm the photo actually belongs
  // to this work order before deleting anything.
  if (!photo || photo.work_order_id !== workOrder.id) {
    return NextResponse.json({ error: 'Photo not found' }, { status: 404 })
  }

  // The object is KEPT. Evidence is never deleted by this feature; the
  // vendor's withdrawal is a new ledger row pointing at the original seal,
  // and the work_order_photos pointer row goes away so the UI stops
  // showing it. A withdrawn photo still appears, marked withdrawn, in a
  // claim packet's chain of custody.
  const { data: original, error: originalErr } = await supabase
    .from('evidence_events')
    .select('id')
    .eq('org_id', workOrder.org_id)
    .eq('bucket', 'work-order-photos')
    .eq('storage_path', photo.storage_path)
    .eq('kind', 'photo_sealed')
    .maybeSingle()
  if (originalErr) {
    reportError(originalErr, { site: 'api.work-orders.photos.withdrawLookup', orgId: workOrder.org_id })
    return NextResponse.json({ error: 'Could not remove photo' }, { status: 500 })
  }
  if (original) {
    const { error: wErr } = await supabase.from('evidence_events').insert({
      org_id:             workOrder.org_id,
      property_id:        workOrder.property_id,
      kind:               'photo_withdrawn',
      source_table:       'work_order_photos',
      source_id:          photo.id,
      bucket:             'work-order-photos',
      storage_path:       photo.storage_path,
      sha256:             '0'.repeat(64),   // a withdrawal carries no bytes; the original row has the hash
      captured_at:        new Date().toISOString(),
      captured_at_source: 'server',
      captured_by_kind:   'vendor',
      captured_by_id:     workOrder.vendor_id ?? null,
      work_order_id:      workOrder.id,
      refers_to_event_id: original.id,
    })
    if (wErr && wErr.code !== '23505') {
      reportError(wErr, { site: 'api.work-orders.photos.withdraw', orgId: workOrder.org_id })
      return NextResponse.json({ error: 'Could not remove photo' }, { status: 500 })
    }
  }

  const { error: deleteErr } = await supabase.from('work_order_photos').delete().eq('id', photo.id)
  if (deleteErr) {
    console.error('[work-orders/photos] failed to delete photo row', deleteErr)
    return NextResponse.json({ error: 'Failed to delete photo. Please try again.' }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
