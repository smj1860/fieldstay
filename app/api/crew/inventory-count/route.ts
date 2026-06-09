import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { propertyId, counts, notes, submitAsDraft } = await request.json() as {
    propertyId: string
    counts: Record<string, number>
    notes: string
    submitAsDraft?: boolean
  }

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, org_id')
    .eq('user_id', user.id)
    .single()

  if (!crew) return NextResponse.json({ error: 'Not a crew member' }, { status: 403 })

  // Verify the property belongs to this crew member's org — never trust a client-supplied propertyId
  const { data: property } = await supabase
    .from('properties')
    .select('id')
    .eq('id', propertyId)
    .eq('org_id', crew.org_id)
    .single()

  if (!property) {
    return NextResponse.json({ error: 'Property not found' }, { status: 404 })
  }

  if (submitAsDraft) {
    // Fetch previous quantities for the diff
    const itemIds = Object.keys(counts)
    const { data: currentItems } = await supabase
      .from('inventory_items')
      .select('id, current_quantity')
      .in('id', itemIds)

    const prevMap = Object.fromEntries((currentItems ?? []).map(i => [i.id, i.current_quantity]))

    const { data: draft } = await supabase
      .from('inventory_count_drafts')
      .insert({
        org_id:         crew.org_id,
        property_id:    propertyId,
        crew_member_id: crew.id,
        status:         'pending_review',
        submitted_at:   new Date().toISOString(),
        notes:          notes || null,
      })
      .select('id')
      .single()

    if (!draft) return NextResponse.json({ error: 'Failed to create draft' }, { status: 500 })

    const draftItems = Object.entries(counts).map(([id, qty]) => ({
      draft_id:           draft.id,
      inventory_item_id:  id,
      previous_quantity:  prevMap[id] ?? 0,
      submitted_quantity: qty,
    }))

    if (draftItems.length > 0) {
      await supabase.from('inventory_count_draft_items').insert(draftItems)
    }

    return NextResponse.json({ success: true, draftId: draft.id })
  }

  // Legacy direct-commit path — de-duplicate double-tap submits within a 5-minute window
  const windowStart = new Date(Date.now() - 5 * 60 * 1000).toISOString()
  const { data: recentCount } = await supabase
    .from('inventory_counts')
    .select('id')
    .eq('property_id', propertyId)
    .eq('submitted_by_crew_id', crew.id)
    .gte('created_at', windowStart)
    .maybeSingle()

  if (recentCount) {
    return NextResponse.json({ success: true })
  }

  const { data: count } = await supabase
    .from('inventory_counts')
    .insert({
      property_id:           propertyId,
      org_id:                crew.org_id,
      submitted_by_crew_id:  crew.id,
      notes: notes || null,
    })
    .select('id')
    .single()

  if (!count) return NextResponse.json({ error: 'Failed to create count' }, { status: 500 })

  const items = Object.entries(counts).map(([id, qty]) => ({
    count_id:           count.id,
    inventory_item_id:  id,
    quantity_counted:   qty,
  }))

  if (items.length > 0) {
    await supabase.from('inventory_count_items').insert(items)

    for (const { inventory_item_id, quantity_counted } of items) {
      await supabase
        .from('inventory_items')
        .update({ current_quantity: quantity_counted })
        .eq('id', inventory_item_id)
        .eq('org_id', crew.org_id)
    }
  }

  await inngest.send({
    name: 'inventory/count-submitted',
    data: { count_id: count.id, property_id: propertyId, org_id: crew.org_id },
  })

  return NextResponse.json({ success: true })
}
