import { NextRequest, NextResponse } from 'next/server'
import { requireCrewMember } from '@/lib/crew-auth'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvents } from '@/lib/audit'

export async function POST(request: NextRequest) {
  const auth = await requireCrewMember()
  if (!auth.ok) return auth.response
  const { user, supabase, crew } = auth

  const { draftId, propertyId, counts, notes, itemNotes, submitAsDraft } = await request.json() as {
    // Client-generated (crypto.randomUUID) draft id from the crew PWA's
    // offline outbox. Used as the row's primary key so an outbox replay —
    // which can arrive hours later, well outside the 5-minute window check
    // below — collides on the PK instead of creating a duplicate draft.
    draftId?: string
    propertyId: string
    counts: Record<string, number>
    notes: string
    itemNotes?: Record<string, string>
    submitAsDraft?: boolean
  }

  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (draftId !== undefined && !UUID_RE.test(draftId)) {
    return NextResponse.json({ error: 'Invalid draft id' }, { status: 400 })
  }

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
    // Primary idempotency: the client-supplied draft id. An offline outbox
    // replay can land arbitrarily long after the original attempt, so the
    // 5-minute window below is not sufficient on its own for that path.
    if (draftId) {
      const { data: existing } = await supabase
        .from('inventory_count_drafts')
        .select('id')
        .eq('id', draftId)
        .eq('org_id', crew.org_id)
        .maybeSingle()
      if (existing) {
        return NextResponse.json({ success: true, draftId: existing.id })
      }
    }

    // Secondary idempotency — same as the legacy commit path below: a
    // double-tap submit from a client that didn't supply a draft id.
    const draftWindowStart = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const { data: recentDraft } = await supabase
      .from('inventory_count_drafts')
      .select('id')
      .eq('property_id', propertyId)
      .eq('submitted_by', crew.id)
      .gte('created_at', draftWindowStart)
      .maybeSingle()

    if (recentDraft && !draftId) {
      return NextResponse.json({ success: true, draftId: recentDraft.id })
    }

    // Fetch previous quantities for the diff
    const itemIds = Object.keys(counts)
    const { data: currentItems } = await supabase
      .from('inventory_items')
      .select('id, current_quantity')
      .in('id', itemIds)

    const prevMap = Object.fromEntries((currentItems ?? []).map(i => [i.id, i.current_quantity]))

    const { data: draft, error: draftError } = await supabase
      .from('inventory_count_drafts')
      .insert({
        ...(draftId ? { id: draftId } : {}),
        org_id:      crew.org_id,
        property_id: propertyId,
        submitted_by: crew.id,
        status:      'pending_review',
        notes:       notes || null,
      })
      .select('id')
      .single()

    if (draftError) {
      // 23505 — two replays of the same queued draft raced each other. The
      // winner already created it, so this is a success, not a failure.
      if (draftError.code === '23505' && draftId) {
        return NextResponse.json({ success: true, draftId })
      }
      console.error('[crew/inventory-count] draft insert failed:', draftError.message)
      return NextResponse.json({ error: 'Failed to create draft' }, { status: 500 })
    }
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
      const { error: itemsError } = await supabase
        .from('inventory_count_draft_items')
        .insert(draftItems)
      if (itemsError) {
        // A draft header with no items is worse than no draft at all — the
        // PM would review an empty count. Surface it so the crew outbox
        // retries instead of reporting success.
        console.error('[crew/inventory-count] draft items insert failed:', itemsError.message)
        return NextResponse.json({ error: 'Failed to save counted items' }, { status: 500 })
      }
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

    await logAuditEvents(
      items.map(({ inventory_item_id, quantity_counted }) => ({
        actorId:    user.id,
        orgId:      crew.org_id,
        action:     'inventory.count_committed' as const,
        targetType: 'inventory_item',
        targetId:   inventory_item_id,
        metadata:   { new_quantity: quantity_counted },
      }))
    )
  }

  await inngest.send({
    name: 'inventory/count-submitted',
    data: { count_id: count.id, property_id: propertyId, org_id: crew.org_id },
  })

  return NextResponse.json({ success: true })
}
