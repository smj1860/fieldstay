import { NextRequest, NextResponse } from 'next/server'
import { requireCrewMember, type CrewAuthContext } from '@/lib/crew-auth'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvents } from '@/lib/audit'

/**
 * POST /api/crew/inventory-count
 *
 * A crew inventory count, applied on submission.
 *
 * ⚠️ This endpoint currently has NO caller. It is the seam the turnover
 * inventory tab will post to once that surface is converted from per-item
 * `inventory_items:PATCH` writes to a submitted count; it is deliberately kept
 * rather than deleted-and-recreated. Do not add behaviour here on the
 * assumption that something exercises it — nothing does yet.
 *
 * It previously had a second `submitAsDraft` branch that wrote
 * `inventory_count_drafts` for PM approval. That whole path was unreachable
 * (its only caller was a crew page nothing ever linked to), had processed zero
 * counts in production, and gated crew counts behind a review step that — per
 * product — was never wanted. Removed along with the draft tables.
 */

type CrewSupabase = CrewAuthContext['supabase']
type Crew         = CrewAuthContext['crew']

interface CountSubmission {
  /**
   * Client-generated (crypto.randomUUID) id from the crew PWA's offline
   * outbox, used as the count row's primary key so a replay — which can arrive
   * hours later, well outside the double-tap window below — collides on the PK
   * instead of recording the same physical count twice.
   */
  countId?:   string
  propertyId: string
  counts:     Record<string, number>
  notes:      string
  itemNotes?: Record<string, string>
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Double-tap window for clients that submit without a count id. */
const DEDUP_WINDOW_MS = 5 * 60 * 1000

/** Applies a submitted count to inventory_items and records the audit trail. */
async function applyCommittedCounts(
  supabase: CrewSupabase,
  crew:     Crew,
  userId:   string,
  items:    { count_id: string; inventory_item_id: string; quantity_counted: number }[],
): Promise<void> {
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
      actorId:    userId,
      orgId:      crew.org_id,
      action:     'inventory.count_committed' as const,
      targetType: 'inventory_item',
      targetId:   inventory_item_id,
      metadata:   { new_quantity: quantity_counted },
    }))
  )
}

/**
 * Records the count and applies it, de-duplicating a double-tap submit within
 * a five-minute window for clients that don't supply their own id.
 */
async function commitCount(
  supabase: CrewSupabase,
  crew:     Crew,
  userId:   string,
  { countId, propertyId, counts, notes }: CountSubmission,
): Promise<NextResponse> {
  const windowStart = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString()
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
      ...(countId ? { id: countId } : {}),
      property_id:          propertyId,
      org_id:               crew.org_id,
      submitted_by_crew_id: crew.id,
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
    await applyCommittedCounts(supabase, crew, userId, items)
  }

  await inngest.send({
    name: 'inventory/count-submitted',
    data: { count_id: count.id, property_id: propertyId, org_id: crew.org_id },
  })

  return NextResponse.json({ success: true })
}

export async function POST(request: NextRequest) {
  const auth = await requireCrewMember()
  if (!auth.ok) return auth.response
  const { user, supabase, crew } = auth

  const body = await request.json() as CountSubmission

  if (body.countId !== undefined && !UUID_RE.test(body.countId)) {
    return NextResponse.json({ error: 'Invalid count id' }, { status: 400 })
  }

  // Verify the property belongs to this crew member's org — never trust a client-supplied propertyId
  const { data: property } = await supabase
    .from('properties')
    .select('id')
    .eq('id', body.propertyId)
    .eq('org_id', crew.org_id)
    .single()

  if (!property) {
    return NextResponse.json({ error: 'Property not found' }, { status: 404 })
  }

  return commitCount(supabase, crew, user.id, body)
}
