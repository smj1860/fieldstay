import { NextRequest, NextResponse } from 'next/server'
import { requireCrewMember, type CrewAuthContext } from '@/lib/crew-auth'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvents } from '@/lib/audit'
import { reportQueryError, unwrapList } from '@/lib/supabase/unwrap'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { UUID_RE } from '@/lib/validation/uuid'
import { isStorableQuantity } from '@/lib/inventory/quantity'

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



/** Double-tap window for clients that submit without a count id. */
const DEDUP_WINDOW_MS = 5 * 60 * 1000

/** No property holds more inventory line items than this. */
const MAX_COUNT_ITEMS = 1000

/**
 * `counts` arrives as `Record<string, number>` — a TypeScript assertion over
 * `await request.json()`, which is not a runtime check of anything.
 *
 * inventory_count_items.quantity_counted is `numeric(12,2) NOT NULL`, so a
 * string, a NaN, an Infinity or a negative does not get rejected at the
 * boundary: it reaches Postgres, raises 22P02/22003, and the route answers 500.
 * (Fractions ARE storable now — see 20260815152007.) lib/dexie/
 * net.ts treats >=500 as TRANSIENT, so that submission then retries FOREVER —
 * a poison pill that never drains, keeps the logout "unsynced work" warning
 * armed permanently, and is invisible because a transport failure never sets
 * the `failed` flag the dead-letter banner queries.
 *
 * A genuinely malformed payload is the client's fault and is terminal, so it
 * earns a 400 the outbox can surface, not a 500 it will chase indefinitely.
 */
function invalidCountsReason(counts: unknown): string | null {
  if (typeof counts !== 'object' || counts === null || Array.isArray(counts)) {
    return 'Malformed count payload'
  }
  const entries = Object.entries(counts as Record<string, unknown>)
  if (entries.length > MAX_COUNT_ITEMS) return 'Too many items in one count'

  for (const [itemId, qty] of entries) {
    if (!UUID_RE.test(itemId)) return 'Malformed count payload'
    // Fractional counts are VALID as of 20260815152007 — the column is
    // numeric(12,2) and the RPC's jsonb_to_recordset cast is `qty numeric`.
    // What stays terminal is what Postgres still cannot store: a non-number, a
    // NaN, an Infinity, a negative, or a value past the column's range.
    if (!isStorableQuantity(qty)) return 'Malformed count payload'
  }
  return null
}

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

  // ONE statement, via the RPC the PM path has used all along
  // (app/(dashboard)/inventory/actions.ts's applyCountedQuantities →
  // apply_inventory_counts, migration 20260801260000).
  //
  // This used to be `Promise.all(items.map(… one UPDATE each …))`, so a single
  // crew submission at the route's own 1,000-item cap fired up to a thousand
  // simultaneous PostgREST round trips. Promise.all is the problem rather than
  // the volume: nothing paces them, they all leave at once, and at any real
  // concurrency of submissions that saturates the worker pool for every other
  // request on the platform.
  //
  // Two things the hand-rolled version also quietly got wrong, which are fixed
  // for free by using the shared implementation:
  //
  //   - first_count_recorded_at was never set. The RPC COALESCEs it, so the PM
  //     path stamps it and the crew path did not — a crew count has never
  //     registered as an item's first count.
  //   - updated_at was never touched either, so a crew count left the row
  //     looking untouched to anything reading that column.
  //
  // The org predicate moves from a per-row `.eq('org_id', …)` into the RPC's
  // own WHERE clause — same boundary, and it is the reason the RPC takes
  // p_org_id at all: the item ids come from the client.
  const { data: applied, error: applyError } = await supabase.rpc('apply_inventory_counts', {
    p_org_id: crew.org_id,
    p_counts: items.map(({ inventory_item_id, quantity_counted }) => ({
      item_id: inventory_item_id,
      qty:     quantity_counted,
    })),
  })

  if (reportQueryError(applyError, {
    site:  'route.crew.inventoryCount.quantities',
    orgId: crew.org_id,
    extra: { count_id: items[0]!.count_id },
  })) return false

  // A short count means some ids were not this org's items (or no longer
  // exist). The count rows are already recorded, so this is reported rather
  // than failed — same stance as the PM path. The per-item loop could not tell
  // the difference at all: an id belonging to another tenant simply matched
  // zero rows and looked identical to success.
  if ((applied ?? 0) < items.length) {
    console.warn(
      '[crew:inventory-count] applied %d of %d counted items',
      applied ?? 0, items.length,
    )
  }

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
 * Every success path sends this, including the two REPLAY paths.
 *
 * They did not, and that was a hole on the whole restock flow. If the first
 * attempt committed the count and applied the quantities but then failed at
 * inngest.send() — a blip reaching Inngest is all it takes — the route threw,
 * answered 500, and the device retried. The retry hit the five-minute dedup
 * (or the countId primary-key collision) and returned success WITHOUT sending
 * anything. Net result: quantities updated, crew told it worked, and no
 * purchase order, no PM email and no cart, permanently.
 *
 * Re-sending is safe twice over: handleInventoryCountSubmitted re-applies the
 * same quantities by upsert and checks for an existing purchase order before
 * creating one, and the explicit event `id` lets Inngest collapse duplicate
 * deliveries inside its own 24h dedup window.
 */
async function sendCountSubmitted(countId: string, propertyId: string, orgId: string): Promise<void> {
  await inngest.send({
    id:   `inventory-count-submitted:${countId}`,
    name: 'inventory/count-submitted',
    data: { count_id: countId, property_id: propertyId, org_id: orgId },
  })
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
    // See sendCountSubmitted: this return used to be the end of the story, so
    // a first attempt that died at the send lost the restock for good.
    await sendCountSubmitted(recentCount.id as string, propertyId, crew.org_id)
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
    await sendCountSubmitted(countId!, propertyId, crew.org_id)
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

  // Resolve the counted ids against inventory_items THIS org owns at THIS
  // property, and drop anything that no longer resolves.
  //
  // inventory_count_items.inventory_item_id carries a real FK, so an id the
  // crew staged before the PM deleted the item raises 23503 — which the route
  // answered with a 500, which lib/dexie/net.ts retries forever. One removed
  // item made the whole count a poison pill in the outbox: never drains, keeps
  // the logout "unsynced work" warning armed, and invisible to the dead-letter
  // banner because a transport-level failure never sets the `failed` flag.
  //
  // Dropping the stale ids lets the REST of the count — the part that is still
  // meaningful — land. The property scope also means a client cannot attach
  // another property's items to this count; the quantity UPDATE was already
  // org-scoped, but the count_items INSERT was not scoped at all.
  const knownItems = await fetchAllRows<{ id: string }>(
    (from, to) => supabase
      .from('inventory_items')
      .select('id')
      .eq('org_id', crew.org_id)
      .eq('property_id', propertyId)
      .in('id', Object.keys(counts))
      .order('id')
      .range(from, to),
    { label: `inventory_items(count-resolve)[property=${propertyId}]` },
  )
  const knownIds = new Set(knownItems.map((i) => i.id))

  const items = Object.entries(counts)
    .filter(([id]) => knownIds.has(id))
    .map(([id, qty]) => ({
      count_id:           countIdToApply,
      inventory_item_id:  id,
      quantity_counted:   qty,
    }))

  const droppedCount = Object.keys(counts).length - items.length
  if (droppedCount > 0) {
    console.warn(
      `[crew.inventoryCount] count ${countIdToApply}: dropped ${droppedCount} counted item(s) ` +
      `no longer present at property ${propertyId}`,
    )
  }

  if (items.length > 0 && !await applyCommittedCounts(supabase, crew, userId, items)) {
    return NextResponse.json({ error: 'Failed to apply count' }, { status: 500 })
  }

  await sendCountSubmitted(countIdToApply, propertyId, crew.org_id)

  // droppedItems is reported rather than swallowed. fetchAllRows() throws on a
  // failed read, so reaching here with everything dropped means every counted
  // item is genuinely gone from this property — terminal, so the device must
  // NOT retry, but "recorded nothing" must not look identical to "recorded
  // everything" in the response or the logs.
  return NextResponse.json(droppedCount > 0 ? { success: true, droppedItems: droppedCount } : { success: true })
}

export async function POST(request: NextRequest) {
  const auth = await requireCrewMember()
  if (!auth.ok) return auth.response
  const { user, supabase, crew } = auth

  const body = await request.json() as CountSubmission

  if (body.countId !== undefined && !UUID_RE.test(body.countId)) {
    return NextResponse.json({ error: 'Invalid count id' }, { status: 400 })
  }

  const countsProblem = invalidCountsReason(body.counts)
  if (countsProblem) {
    return NextResponse.json({ error: countsProblem }, { status: 400 })
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
