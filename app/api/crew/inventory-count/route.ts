import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { propertyId, counts, notes, itemNotes, submitAsDraft } = await request.json() as {
    propertyId: string
    counts: Record<string, number>
    notes: string
    itemNotes?: Record<string, string>
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
    // Idempotency — same as the legacy commit path below: a double-tap submit or a
    // PowerSync/Dexie retry after a connectivity blip must not create a second draft.
    const draftWindowStart = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const { data: recentDraft } = await supabase
      .from('inventory_count_drafts')
      .select('id')
      .eq('property_id', propertyId)
      .eq('submitted_by', crew.id)
      .gte('created_at', draftWindowStart)
      .maybeSingle()

    if (recentDraft) {
      return NextResponse.json({ success: true, draftId: recentDraft.id })
    }

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
        org_id:      crew.org_id,
        property_id: propertyId,
        submitted_by: crew.id,
        status:      'pending_review',
        notes:       notes || null,
      })
      .select('id')
      .single()

    if (!draft) return NextResponse.json({ error: 'Failed to create draft' }, { status: 500 })

    // Column names match the live schema (item_id / counted_qty), not the
    // legacy inventory_item_id / submitted_quantity referenced elsewhere.
    const draftItems = Object.entries(counts).map(([id, qty]) => ({
      draft_id:          draft.id,
      item_id:           id,
      previous_quantity: prevMap[id] ?? 0,
      counted_qty:       qty,
      notes:             itemNotes?.[id]?.trim() || null,
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

    await Promise.all(
      items.map(({ inventory_item_id, quantity_counted }) =>
        supabase
          .from('inventory_items')
          .update({ current_quantity: quantity_counted })
          .eq('id', inventory_item_id)
          .eq('org_id', crew.org_id)
      )
    )
  }

  await inngest.send({
    name: 'inventory/count-submitted',
    data: { count_id: count.id, property_id: propertyId, org_id: crew.org_id },
  })

  return NextResponse.json({ success: true })
}
