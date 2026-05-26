import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'

/**
 * POST /api/work-orders/[token]/complete
 *
 * Public endpoint — no auth required.
 * Vendor submits completion via their tokenized portal link.
 *
 * Body: FormData
 *   notes:  string (optional)
 *   photos: File[] (optional, uploaded to Supabase Storage)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const supabase = createServiceClient()

  // Validate token
  const { data: workOrder } = await supabase
    .from('work_orders')
    .select('id, org_id, property_id, status, portal_enabled, completion_token_expires_at')
    .eq('completion_token', token)
    .single()

  if (!workOrder) {
    return NextResponse.json({ error: 'Invalid or expired link' }, { status: 404 })
  }

  if (!workOrder.portal_enabled) {
    return NextResponse.json({ error: 'Vendor portal not enabled for this work order' }, { status: 403 })
  }

  if (workOrder.status === 'completed' || workOrder.status === 'cancelled') {
    return NextResponse.json({ error: 'Work order already closed' }, { status: 409 })
  }

  if (
    workOrder.completion_token_expires_at &&
    new Date(workOrder.completion_token_expires_at) < new Date()
  ) {
    return NextResponse.json({ error: 'Link has expired' }, { status: 410 })
  }

  // Parse form data
  const formData    = await request.formData()
  const notes       = formData.get('notes') as string | null
  const photoFiles  = formData.getAll('photos') as File[]
  const photosPaths: string[] = []

  // Upload photos to Supabase Storage
  for (const file of photoFiles) {
    if (!(file instanceof File)) continue
    const ext  = file.name.split('.').pop() ?? 'jpg'
    const path = `work-orders/${workOrder.id}/vendor-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`

    const { error: uploadError } = await supabase.storage
      .from('work-order-photos')
      .upload(path, file, { contentType: file.type })

    if (!uploadError) {
      photosPaths.push(path)
    }
  }

  // Record photo rows
  if (photosPaths.length > 0) {
    await supabase.from('work_order_photos').insert(
      photosPaths.map((path) => ({
        work_order_id: workOrder.id,
        storage_path:  path,
        uploaded_by:   'vendor_portal',
      }))
    )
  }

  // Mark work order complete
  await supabase
    .from('work_orders')
    .update({
      status:           'completed',
      completed_date:   new Date().toISOString().split('T')[0],
      completion_notes: notes,
    })
    .eq('id', workOrder.id)

  // Record status update
  await supabase.from('work_order_updates').insert({
    work_order_id:             workOrder.id,
    org_id:                    workOrder.org_id,
    updated_via_vendor_portal: true,
    status_from:               workOrder.status as 'pending' | 'assigned' | 'in_progress',
    status_to:                 'completed',
    notes,
  })

  // Fire Inngest event so PM gets notified
  await inngest.send({
    name: 'work-order/completed-via-portal',
    data: {
      work_order_id:    workOrder.id,
      completion_token: token,
      notes:            notes ?? null,
      photo_paths:      photosPaths,
    },
  })

  return NextResponse.json({ success: true })
}

/**
 * GET /api/work-orders/[token]/complete
 *
 * Returns basic work order info so the vendor portal UI
 * can render the form before submission.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params
  const supabase = createServiceClient()

  const { data: workOrder } = await supabase
    .from('work_orders')
    .select(`
      id, title, description, status, portal_enabled,
      completion_token_expires_at,
      properties (name, city, state)
    `)
    .eq('completion_token', token)
    .single()

  if (!workOrder || !workOrder.portal_enabled) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 })
  }

  return NextResponse.json({ workOrder })
}
