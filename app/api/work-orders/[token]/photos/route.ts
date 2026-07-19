import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { workOrderRatelimit } from '@/lib/rate-limit'
import { extractClientIp } from '@/lib/integrations/webhook-verification'

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
const MAX_PHOTO_BYTES = 10 * 1024 * 1024  // 10 MB
const ALLOWED_MIME    = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic'])
const EXT_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png':  'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
}

async function loadOpenWorkOrder(token: string) {
  const supabase = createServiceClient()

  const { data: workOrder } = await supabase
    .from('work_orders')
    .select('id, status, portal_enabled, completion_token_expires_at')
    .eq('completion_token', token)
    .single()

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

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  try {
    const ip = extractClientIp(request) ?? 'unknown'
    const { success } = await workOrderRatelimit.limit(`wo-photo:${ip}`)
    if (!success) {
      return NextResponse.json({ error: 'Too many requests. Please try again in a minute.' }, { status: 429 })
    }
  } catch (rlErr) {
    console.error('[work-orders/photos] rate limit check failed', rlErr)
  }

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

  // Count against the running total for this WO, not just this request —
  // a vendor uploading one-at-a-time could otherwise exceed MAX_PHOTOS
  // across several calls.
  const { count: existingCount } = await supabase
    .from('work_order_photos')
    .select('id', { count: 'exact', head: true })
    .eq('work_order_id', workOrder.id)

  if ((existingCount ?? 0) + files.length > MAX_PHOTOS) {
    return NextResponse.json({ error: `Maximum ${MAX_PHOTOS} photos allowed per work order` }, { status: 400 })
  }

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
    const ext  = EXT_BY_MIME[file.type] ?? 'jpg'
    const path = `work-orders/${workOrder.id}/completion/${crypto.randomUUID()}.${ext}`

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
        uploaded_by:   'vendor-portal',
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

    uploaded.push(inserted)
  }

  return NextResponse.json({ success: true, uploaded })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  const loaded = await loadOpenWorkOrder(token)
  if ('error' in loaded) return loaded.error
  const { supabase, workOrder } = loaded

  const body = await request.json().catch(() => ({}))
  const photoId = typeof body.photoId === 'string' ? body.photoId : null
  if (!photoId) return NextResponse.json({ error: 'photoId required' }, { status: 400 })

  const { data: photo } = await supabase
    .from('work_order_photos')
    .select('id, storage_path, work_order_id')
    .eq('id', photoId)
    .single()

  // Ownership check — the token proves access to workOrder.id, not to any
  // photo id a caller might supply, so confirm the photo actually belongs
  // to this work order before deleting anything.
  if (!photo || photo.work_order_id !== workOrder.id) {
    return NextResponse.json({ error: 'Photo not found' }, { status: 404 })
  }

  await supabase.storage.from('work-order-photos').remove([photo.storage_path])
  await supabase.from('work_order_photos').delete().eq('id', photo.id)

  return NextResponse.json({ success: true })
}
