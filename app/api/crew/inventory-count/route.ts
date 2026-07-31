import { NextRequest, NextResponse } from 'next/server'
import { requireCrewMember, type CrewAuthContext } from '@/lib/crew-auth'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvents } from '@/lib/audit'

type CrewSupabase = CrewAuthContext['supabase']
type Crew         = CrewAuthContext['crew']

interface CountSubmission {
  // Client-generated (crypto.randomUUID) draft id from the crew PWA's
  // offline outbox. Used as the row's primary key so an outbox replay —
  // which can arrive hours later, well outside the 5-minute window check
  // below — collides on the PK instead of creating a duplicate draft.
  draftId?:       string
  propertyId:     string
  counts:         Record<string, number>
  notes:          string
  itemNotes?:     Record<string, string>
  submitAsDraft?: boolean
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Double-tap window for clients that submit without a draft id. */
const DEDUP_WINDOW_MS = 5 * 60 * 1000

/**
 * Resolves an already-recorded draft for this submission, if any.
 *
 * Two layers, deliberately not both applied to the same request:
 *  • the client-supplied draft id is the primary key of the row, so an
 *    offline outbox replay landing hours later still collides;
 *  • clients that don't supply one only get the 5-minute double-tap window.
 *
 * A client that DID supply a draft id must not be short-circuited by the
 * window — its legitimate retry carries the same id and is settled by the
 * primary key (or by the 23505 branch on insert).
 */
async function findPriorDraftId(
  supabase: CrewSupabase,
  crew:     Crew,
  { draftId, propertyId }: CountSubmission,
): Promise<string | null> {
  if (draftId) {
    const { data: existing } = await supabase
      .from('inventory_count_drafts')
      .select('id')
      .eq('id', draftId)
      .eq('org_id', crew.org_id)
      .maybeSingle()
    return existing?.id ?? null
  }

  const windowStart = new Date(Date.now() - DEDUP_WINDOW_MS).toISOString()
  const { data: recentDraft } = await supabase
    .from('inventory_count_drafts')
    .select('id')
    .eq('property_id', propertyId)
    .eq('submitted_by', crew.id)
    .gte('created_at', windowStart)
    .maybeSingle()

  return recentDraft?.id ?? null
}

/** Current on-record quantities, so the PM reviews a diff and not just a total. */
async function loadPreviousQuantities(
  supabase: CrewSupabase,
  itemIds:  string[],
): Promise<Record<string, number>> {
  const { data: currentItems } = await supabase
    .from('inventory_items')
    .select('id, current_quantity')
    .in('id', itemIds)

  return Object.fromEntries((currentItems ?? []).map((i) => [i.id, i.current_quantity]))
}

// Column names match the live schema (item_id / counted_qty), not the
// legacy inventory_item_id / submitted_quantity referenced elsewhere.
function buildDraftItems(
  draftRowId: string,
  { counts, itemNotes }: CountSubmission,
  prevMap: Record<string, number>,
) {
  return Object.entries(counts).map(([id, qty]) => ({
    draft_id:          draftRowId,
    item_id:           id,
    previous_quantity: prevMap[id] ?? 0,
    counted_qty:       qty,
    notes:             itemNotes?.[id]?.trim() || null,
  }))
}

/** Crew PWA draft path — the count lands as pending_review for the PM. */
async function submitDraft(
  supabase: CrewSupabase,
  crew:     Crew,
  body:     CountSubmission,
): Promise<NextResponse> {
  const { draftId, propertyId, counts, notes } = body

  const priorDraftId = await findPriorDraftId(supabase, crew, body)
  if (priorDraftId) {
    return NextResponse.json({ success: true, draftId: priorDraftId })
  }

  const prevMap = await loadPreviousQuantities(supabase, Object.keys(counts))

  const { data: draft, error: draftError } = await supabase
    .from('inventory_count_drafts')
    .insert({
      ...(draftId ? { id: draftId } : {}),
      org_id:       crew.org_id,
      property_id:  propertyId,
      submitted_by: crew.id,
      status:       'pending_review',
      notes:        notes || null,
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

  const draftItems = buildDraftItems(draft.id, body, prevMap)
  if (draftItems.length === 0) {
    return NextResponse.json({ success: true, draftId: draft.id })
  }

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

  return NextResponse.json({ success: true, draftId: draft.id })
}

/** Applies a committed count to inventory_items and records the audit trail. */
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
 * Legacy direct-commit path — writes straight through to inventory_items,
 * de-duplicating double-tap submits within a 5-minute window.
 */
async function commitCountDirectly(
  supabase: CrewSupabase,
  crew:     Crew,
  userId:   string,
  { propertyId, counts, notes }: CountSubmission,
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

  if (body.draftId !== undefined && !UUID_RE.test(body.draftId)) {
    return NextResponse.json({ error: 'Invalid draft id' }, { status: 400 })
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

  if (body.submitAsDraft) {
    return submitDraft(supabase, crew, body)
  }

  return commitCountDirectly(supabase, crew, user.id, body)
}
