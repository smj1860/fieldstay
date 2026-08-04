import { NextRequest, NextResponse } from 'next/server'
import { requireCrewMember, type CrewAuthContext } from '@/lib/crew-auth'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvents } from '@/lib/audit'
import { reportQueryError, unwrapList } from '@/lib/supabase/unwrap'

/**
 * POST /api/crew/inventory-count
 *
 * A crew inventory count, applied on submission. Called by the crew PWA's
 * offline outbox (`uploadInventoryCount` in lib/dexie/syncService.ts), so
 * every request here can arrive more than once and hours late — see the
 * replay handling in commitCount().
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

/**
 * Applies a submitted count to inventory_items and records the audit trail.
 * Returns false when a write failed, so the caller answers 500 and the crew
 * device's outbox retries — rather than reporting a count as applied when
 * neither the count items nor the quantities ever landed.
 */
async function applyCommittedCounts(
  supabase: CrewSupabase,
  crew:     Crew,
  userId:   string,
  items:    { count_id: string; inventory_item_id: string; quantity_counted: number }[],
): Promise<boolean> {
  const { error: itemsError } = await supabase.from('inventory_count_items').insert(items)
  if (reportQueryError(itemsError, {
    site:  'route.crew.inventoryCount.items',
    orgId: crew.org_id,
    extra: { count_id: items[0]!.count_id, item_count: items.length },
  })) return false

  const updates = await Promise.all(
    items.map(({ inventory_item_id, quantity_counted }) =>
      supabase
        .from('inventory_items')
        .update({ current_quantity: quantity_counted })
        .eq('id', inventory_item_id)
        .eq('org_id', crew.org_id)
    )
  )
  const updateError = updates.find((r) => r.error)?.error ?? null
  if (reportQueryError(updateError, {
    site:  'route.crew.inventoryCount.quantities',
    orgId: crew.org_id,
    extra: { count_id: items[0]!.count_id },
  })) return false

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
  return true
}

/**
 * A replayed submission whose count row already exists. The first attempt got
 * as far as inserting the count; whether it got as far as applying the items
 * is exactly what the response the device never saw would have told us, so
 * check rather than assume.
 *
 * Reading before writing is safe here specifically because the only writer is
 * one device's outbox, which drains serially — two of these cannot be in
 * flight for the same countId at once.
 */
async function alreadyApplied(
  supabase: CrewSupabase,
  crew:     Crew,
  countId:  string,
): Promise<boolean> {
  const existingRes = await supabase
    .from('inventory_count_items')
    .select('id')
    .eq('count_id', countId)
    .limit(1)

  const existing = unwrapList(existingRes, {
    site:  'route.crew.inventoryCount.replay',
    orgId: crew.org_id,
  })
  return existing.length > 0
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
  const { data: recentCount, error: recentError } = await supabase
    .from('inventory_counts')
    .select('id')
    .eq('property_id', propertyId)
    .eq('submitted_by_crew_id', crew.id)
    .gte('created_at', windowStart)
    .maybeSingle()

  // A failed dedup read must not fall through to the insert: that turns a
  // transient DB error into a second physical count for the same property.
  if (reportQueryError(recentError, {
    site:  'route.crew.inventoryCount.dedup',
    orgId: crew.org_id,
  })) {
    return NextResponse.json({ error: 'Failed to record count' }, { status: 500 })
  }

  if (recentCount) {
    return NextResponse.json({ success: true })
  }

  const { data: count, error: countError } = await supabase
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

  // 23505 on the primary key means the client-supplied countId is a replay —
  // the dedup working, not a failure. Answering 500 here would dead-letter a
  // count that HAD reached the server, so resume the submission instead.
  const isReplay = countError?.code === '23505' && countId !== undefined
  if (isReplay && await alreadyApplied(supabase, crew, countId!)) {
    return NextResponse.json({ success: true, duplicate: true })
  }

  const countIdToApply = isReplay ? countId! : count?.id
  if (!countIdToApply) {
    reportQueryError(countError, {
      site:  'route.crew.inventoryCount.insert',
      orgId: crew.org_id,
    })
    return NextResponse.json({ error: 'Failed to create count' }, { status: 500 })
  }

  const items = Object.entries(counts).map(([id, qty]) => ({
    count_id:           countIdToApply,
    inventory_item_id:  id,
    quantity_counted:   qty,
  }))

  if (items.length > 0 && !await applyCommittedCounts(supabase, crew, userId, items)) {
    return NextResponse.json({ error: 'Failed to apply count' }, { status: 500 })
  }

  await inngest.send({
    name: 'inventory/count-submitted',
    data: { count_id: countIdToApply, property_id: propertyId, org_id: crew.org_id },
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
  const { data: property, error: propertyError } = await supabase
    .from('properties')
    .select('id')
    .eq('id', body.propertyId)
    .eq('org_id', crew.org_id)
    .maybeSingle()

  // 404 is the answer for "not yours"; a failed lookup is not the same thing,
  // and reporting it as 404 dead-letters the count on a transient outage.
  if (reportQueryError(propertyError, {
    site:  'route.crew.inventoryCount.property',
    orgId: crew.org_id,
  })) {
    return NextResponse.json({ error: 'Failed to verify property' }, { status: 500 })
  }
  if (!property) {
    return NextResponse.json({ error: 'Property not found' }, { status: 404 })
  }

  return commitCount(supabase, crew, user.id, body)
}
