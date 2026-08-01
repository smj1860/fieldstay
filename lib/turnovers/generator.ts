import type { DBClient } from '@/lib/supabase/server'
import type { PriorityLevel } from '@/types/database'
import { getMissingAssetDiscoveryTypes, buildAssetDiscoveryItems } from '@/lib/asset-discovery/engine'
import { propertyLocalToUtc } from '@/lib/utils/timezone'
import { unwrapJoinArray } from '@/lib/utils/supabase-joins'
import { fetchAllRows } from '@/lib/inngest/paginate'

export interface GeneratedTurnover {
  id:                string
  property_id:       string
  checkout_datetime: string
  checkin_datetime:  string
  window_minutes:    number
  isNew:             boolean
}

interface GeneratorContext {
  propertyCheckinTime:  string | null
  propertyCheckoutTime: string | null
  timezone:             string
  checklistTemplateId:  string | null
  existingPairs:        Set<string>
  existingStandalones:  Set<string>
  /** Booking ids that already have a turnover with a prev_booking_id set. */
  alreadyPaired:        Set<string>
}

type BookingRow = {
  id:            string
  checkin_date:  string
  checkout_date: string
  checkin_time:  string | null
  checkout_time: string | null
}

/**
 * Loads everything Pass 1 and Pass 2 need in one place: the property's
 * default times/timezone, its default checklist template, and the set of
 * turnovers that already exist for it. Extracted so generateTurnoversForProperty
 * reads as "load context, run pass 1, run pass 2".
 */
async function loadGeneratorContext(
  supabase:   DBClient,
  propertyId: string,
): Promise<GeneratorContext> {
  const [propertyRes, templateRes, existingTurnovers] = await Promise.all([
    // maybeSingle() — .single() errors when 0 rows, causing the step to throw
    supabase
      .from('properties')
      .select('checkin_time, checkout_time, timezone')
      .eq('id', propertyId)
      .maybeSingle(),
    supabase
      .from('checklist_templates')
      .select('id')
      .eq('property_id', propertyId)
      .eq('is_default', true)
      .maybeSingle(),
    // This is the DEDUPE set — every turnover already generated for this
    // property, over its whole history. Two failure modes were open here:
    //
    //   - Truncation. A property accumulates turnovers indefinitely, and at
    //     max_rows = 1000 PostgREST returns the first 1000 with a 200 and no
    //     signal. Every turnover past the cap looks absent, so the generator
    //     re-creates it — silently duplicating turnovers on an established
    //     property, which is exactly the property that can least afford it.
    //   - The error was never checked. `existingRes.data ?? []` turned a
    //     FAILED read into an EMPTY dedupe set, which regenerates the
    //     property's entire turnover history at once. fetchAllRows throws.
    fetchAllRows<{ booking_id: string | null; prev_booking_id: string | null }>(
      (from, to) => supabase
        .from('turnovers')
        .select('booking_id, prev_booking_id')
        .eq('property_id', propertyId)
        .order('id')
        .range(from, to),
      { label: 'generator.existingTurnovers' },
    ),
  ])

  if (propertyRes.error) {
    console.error('[generator] property fetch failed', { propertyId, error: propertyRes.error.message })
  }

  return {
    propertyCheckinTime:  propertyRes.data?.checkin_time  ?? null,
    propertyCheckoutTime: propertyRes.data?.checkout_time ?? null,
    timezone:             propertyRes.data?.timezone ?? 'America/New_York',
    checklistTemplateId:  templateRes.data?.id ?? null,
    existingPairs: new Set(
      existingTurnovers
        .filter(t => t.prev_booking_id !== null)
        .map(t => `${t.prev_booking_id}:${t.booking_id}`)
    ),
    existingStandalones: new Set(
      existingTurnovers
        .filter(t => t.prev_booking_id === null && t.booking_id !== null)
        .map(t => t.booking_id as string)
    ),
    alreadyPaired: new Set(
      existingTurnovers
        .filter(t => t.prev_booking_id !== null && t.booking_id !== null)
        .map(t => t.booking_id as string)
    ),
  }
}

function priorityForWindow(windowMinutes: number): PriorityLevel {
  if (windowMinutes < 120) return 'urgent'
  if (windowMinutes < 240) return 'high'
  if (windowMinutes < 480) return 'medium'
  return 'low'
}

/**
 * PASS 1 — a standalone turnover for every checkout, so every booking gets a
 * clean regardless of whether a next booking exists. Pass 2 upgrades these to
 * precise pairs. Mutates ctx.existingStandalones as it goes.
 */
async function runStandalonePass(
  supabase:   DBClient,
  orgId:      string,
  propertyId: string,
  bookings:   BookingRow[],
  ctx:        GeneratorContext,
): Promise<string[]> {
  const created: string[] = []

  for (const booking of bookings) {
    if (ctx.existingStandalones.has(booking.id)) continue
    if (ctx.alreadyPaired.has(booking.id)) continue

    const newTurnoverId = await insertStandaloneTurnover(supabase, {
      orgId, propertyId, booking,
      propertyCheckoutTime: ctx.propertyCheckoutTime,
      propertyTimezone:     ctx.timezone,
      checklistTemplateId:  ctx.checklistTemplateId,
    })
    if (!newTurnoverId) continue

    created.push(newTurnoverId)
    ctx.existingStandalones.add(booking.id)
    await snapshotChecklist(supabase, newTurnoverId, orgId, propertyId, ctx.checklistTemplateId)
  }

  return created
}

interface BookingPairWindow {
  checkoutDT:    Date
  checkinDT:     Date
  windowMinutes: number
  priority:      PriorityLevel
}

/**
 * Resolves the real UTC checkout/checkin window between two consecutive
 * bookings, or null when the pair doesn't produce a valid turnover window
 * (unparseable dates, or a check-in at or before the check-out).
 */
function resolvePairWindow(
  propertyId: string,
  outgoing:   BookingRow,
  incoming:   BookingRow,
  ctx:        GeneratorContext,
): BookingPairWindow | null {
  // Slice to 5 chars ('HH:MM') to handle both 'HH:MM' and 'HH:MM:SS' storage formats
  const checkoutTimeStr = (outgoing.checkout_time ?? ctx.propertyCheckoutTime ?? '11:00').slice(0, 5)
  const checkinTimeStr  = (incoming.checkin_time  ?? ctx.propertyCheckinTime  ?? '15:00').slice(0, 5)
  // Both datetimes converted from local wall-clock to true UTC.
  const checkoutDT = propertyLocalToUtc(outgoing.checkout_date, checkoutTimeStr, ctx.timezone)
  const checkinDT  = propertyLocalToUtc(incoming.checkin_date,  checkinTimeStr,  ctx.timezone)

  if (isNaN(checkoutDT.getTime()) || isNaN(checkinDT.getTime())) {
    console.error('[generator] invalid date constructed', {
      propertyId, checkout_date: outgoing.checkout_date, checkoutTimeStr,
      checkin_date: incoming.checkin_date, checkinTimeStr,
    })
    return null
  }
  if (checkinDT <= checkoutDT) return null

  const windowMinutes = Math.round((checkinDT.getTime() - checkoutDT.getTime()) / 60_000)
  return { checkoutDT, checkinDT, windowMinutes, priority: priorityForWindow(windowMinutes) }
}

/**
 * PASS 2 — upgrade a standalone to a precise pair once a next booking exists,
 * or refresh an existing pair whose dates have since drifted (guest extended/
 * shortened their stay, PM corrected a time). See
 * CLAUDE_HOSPITABLE_DEXIE_AUDIT_FIXES_1.md Task 3.
 */
async function runPairPass(
  supabase:   DBClient,
  orgId:      string,
  propertyId: string,
  bookings:   BookingRow[],
  ctx:        GeneratorContext,
): Promise<string[]> {
  const created: string[] = []

  for (let i = 0; i < bookings.length - 1; i++) {
    const outgoing = bookings[i]!
    const incoming = bookings[i + 1]!
    const pairKey  = `${outgoing.id}:${incoming.id}`

    const window = resolvePairWindow(propertyId, outgoing, incoming, ctx)
    if (!window) continue

    const pairParams = {
      propertyId,
      outgoingBookingId: outgoing.id,
      incomingBookingId: incoming.id,
      ...window,
    }

    if (ctx.existingPairs.has(pairKey)) {
      await refreshExistingPairDates(supabase, pairParams)
      continue
    }

    if (ctx.existingStandalones.has(outgoing.id)) {
      await upgradeStandaloneToPair(supabase, pairParams)
      ctx.existingPairs.add(pairKey)
      continue
    }

    const newTurnoverId = await insertPairTurnover(supabase, {
      orgId,
      ...pairParams,
      checklistTemplateId: ctx.checklistTemplateId,
    })
    if (!newTurnoverId) continue

    created.push(newTurnoverId)
    await snapshotChecklist(supabase, newTurnoverId, orgId, propertyId, ctx.checklistTemplateId)
  }

  return created
}

export async function generateTurnoversForProperty(
  propertyId: string,
  orgId:       string,
  supabase:    DBClient
): Promise<string[]> {
  // Every booking for this property, over its whole history — the input the
  // pair pass walks to find consecutive stays. Truncation at max_rows = 1000
  // would silently drop the tail, so no turnover is generated for any booking
  // past the cap and the pair straddling the boundary is missed too. The
  // discarded error was the worse half: a failed read returned [] and this
  // function reported "nothing to generate" rather than failing.
  //
  // The secondary sort on id is required by the pagination: checkin_date is
  // not unique (two bookings can start the same day across a property's
  // history), and range() over a non-unique sort key can skip or repeat rows
  // across page boundaries.
  const bookings = await fetchAllRows<{
    id: string; checkin_date: string; checkout_date: string
    checkin_time: string | null; checkout_time: string | null
  }>(
    (from, to) => supabase
      .from('bookings')
      .select('id, checkin_date, checkout_date, checkin_time, checkout_time')
      .eq('property_id', propertyId)
      .eq('is_block', false)
      .in('status', ['confirmed', 'tentative'])
      .order('checkin_date', { ascending: true })
      .order('id')
      .range(from, to),
    { label: 'generator.bookings' },
  )
  if (!bookings.length) return []

  const ctx = await loadGeneratorContext(supabase, propertyId)

  const standaloneIds = await runStandalonePass(supabase, orgId, propertyId, bookings, ctx)
  const pairIds       = await runPairPass(supabase, orgId, propertyId, bookings, ctx)

  return [...standaloneIds, ...pairIds]
}

const DEFAULT_STANDALONE_WINDOW_HOURS = 4

/**
 * Inserts a Pass 1 standalone turnover for a single booking's checkout.
 * Returns the new turnover's id, or null if the insert was skipped (a
 * concurrent worker already created it — 23505 unique_violation, safe to
 * ignore) or a date failed to parse.
 */
async function insertStandaloneTurnover(
  supabase: DBClient,
  params: {
    orgId:                string
    propertyId:            string
    booking:               { id: string; checkout_date: string; checkout_time: string | null }
    propertyCheckoutTime:  string | null
    propertyTimezone:      string
    checklistTemplateId:   string | null
  }
): Promise<string | null> {
  const { orgId, propertyId, booking, propertyCheckoutTime, propertyTimezone, checklistTemplateId } = params

  const checkoutTimeStr = (booking.checkout_time ?? propertyCheckoutTime ?? '11:00').slice(0, 5)
  // Convert local wall-clock checkout to UTC using property timezone.
  // Without this, "11:00 AM CDT" is stored as 11:00 UTC = 6:00 AM local — wrong.
  const checkoutDT = propertyLocalToUtc(booking.checkout_date, checkoutTimeStr, propertyTimezone)
  if (isNaN(checkoutDT.getTime())) {
    console.error('[generator] invalid date in Pass 1', {
      propertyId, checkout_date: booking.checkout_date, checkoutTimeStr,
    })
    return null
  }

  const checkinDT     = new Date(checkoutDT.getTime() + DEFAULT_STANDALONE_WINDOW_HOURS * 3_600_000)
  const windowMinutes = DEFAULT_STANDALONE_WINDOW_HOURS * 60

  const { data: turnover, error } = await supabase
    .from('turnovers')
    .insert({
      property_id:           propertyId,
      org_id:                orgId,
      booking_id:            booking.id,
      prev_booking_id:       null,
      checkout_datetime:     checkoutDT.toISOString(),
      checkin_datetime:      checkinDT.toISOString(),
      window_minutes:        windowMinutes,
      status:                'pending_assignment',
      priority:              'medium' as const,
      auto_generated:        true,
      checklist_template_id: checklistTemplateId,
    })
    .select('id')
    .single()

  if (error) {
    // 23505 = unique_violation: concurrent worker already inserted this standalone.
    // The new turnovers_standalone_unique partial index makes this safe to ignore.
    if (error.code !== '23505') {
      console.error('[generator] Pass 1 insert error', { propertyId, bookingId: booking.id, code: error.code, msg: error.message })
    }
    return null
  }

  return turnover?.id ?? null
}

/**
 * Upgrades an existing Pass 1 standalone turnover to a precise pair once a
 * next booking is known. checkout_datetime is included here too — a prior
 * version of this update only touched checkin_datetime/window_minutes/
 * priority on upgrade, silently dropping any checkout_time correction that
 * arrived between Pass 1 creating the standalone and this upgrade running.
 */
async function upgradeStandaloneToPair(
  supabase: DBClient,
  params: {
    propertyId:         string
    outgoingBookingId:  string
    incomingBookingId:  string
    checkoutDT:         Date
    checkinDT:          Date
    windowMinutes:      number
    priority:           PriorityLevel
  }
): Promise<void> {
  const { propertyId, outgoingBookingId, incomingBookingId, checkoutDT, checkinDT, windowMinutes, priority } = params

  await supabase
    .from('turnovers')
    .update({
      booking_id:         incomingBookingId,
      prev_booking_id:    outgoingBookingId,
      checkout_datetime:  checkoutDT.toISOString(),
      checkin_datetime:   checkinDT.toISOString(),
      window_minutes:     windowMinutes,
      priority,
    })
    .eq('booking_id',      outgoingBookingId)
    .is('prev_booking_id', null)
    .eq('property_id',     propertyId)
}

/**
 * Inserts a fresh Pass 2 pair turnover for a booking pair that has neither
 * an existing pair nor an upgradeable standalone. Returns the new
 * turnover's id, or null if the insert was skipped (a concurrent worker
 * already inserted this pair — 23505 unique_violation, safe to ignore).
 */
async function insertPairTurnover(
  supabase: DBClient,
  params: {
    orgId:                string
    propertyId:            string
    outgoingBookingId:     string
    incomingBookingId:     string
    checkoutDT:            Date
    checkinDT:             Date
    windowMinutes:         number
    priority:              PriorityLevel
    checklistTemplateId:   string | null
  }
): Promise<string | null> {
  const {
    orgId, propertyId, outgoingBookingId, incomingBookingId,
    checkoutDT, checkinDT, windowMinutes, priority, checklistTemplateId,
  } = params

  const { data: turnover, error } = await supabase
    .from('turnovers')
    .insert({
      property_id:           propertyId,
      org_id:                orgId,
      booking_id:            incomingBookingId,
      prev_booking_id:       outgoingBookingId,
      checkout_datetime:     checkoutDT.toISOString(),
      checkin_datetime:      checkinDT.toISOString(),
      window_minutes:        windowMinutes,
      status:                'pending_assignment',
      priority,
      auto_generated:        true,
      checklist_template_id: checklistTemplateId,
    })
    .select('id')
    .single()

  if (error) {
    // 23505 = unique_violation: concurrent worker already inserted this pair
    // (covered by the existing turnovers_booking_pair_unique partial index).
    if (error.code !== '23505') {
      console.error('[generator] Pass 2 insert error', { propertyId, code: error.code, msg: error.message })
    }
    return null
  }

  return turnover?.id ?? null
}

/**
 * Refreshes an already-paired turnover's dates when the underlying bookings'
 * checkout/checkin have changed since the pair was formed (guest extended/
 * shortened their stay, PM corrected a time, etc.).
 *
 * pending_assignment / assigned: no crew has started work — safe to update
 * the real checkout_datetime/checkin_datetime/window_minutes/priority
 * directly, same as any other regeneration.
 *
 * in_progress: a crew member is actively working against the CURRENT
 * window. Silently rewriting it out from under them is worse than leaving
 * it stale — instead, stage the new values on pending_checkout_datetime /
 * pending_checkin_datetime and stamp dates_changed_at, which the crew PWA
 * surfaces as a "checkout time changed" banner (see helpers.ts
 * acknowledgeDatesChanged() and the crew turnover page). The real
 * checkout_datetime/checkin_datetime are left untouched — this function
 * never applies a pending change automatically. A newer detected change
 * re-arms the banner (clears dates_change_acknowledged_at) even if a prior
 * one was already dismissed.
 *
 * completed / cancelled: historical record — never touched.
 */
async function refreshExistingPairDates(
  supabase: DBClient,
  params: {
    propertyId: string
    outgoingBookingId: string
    incomingBookingId: string
    checkoutDT: Date
    checkinDT: Date
    windowMinutes: number
    priority: PriorityLevel
  }
): Promise<void> {
  const { propertyId, outgoingBookingId, incomingBookingId, checkoutDT, checkinDT, windowMinutes, priority } = params

  const { data: existing, error: fetchErr } = await supabase
    .from('turnovers')
    .select('id, status, checkout_datetime, checkin_datetime')
    .eq('property_id', propertyId)
    .eq('booking_id', incomingBookingId)
    .eq('prev_booking_id', outgoingBookingId)
    .maybeSingle()

  if (fetchErr) {
    console.error('[generator] pair date-refresh lookup failed', {
      propertyId, outgoingBookingId, incomingBookingId, msg: fetchErr.message,
    })
    return
  }
  if (!existing) return // pair not found — shouldn't happen given the existingPairs check, but don't throw over it

  const newCheckoutIso = checkoutDT.toISOString()
  const newCheckinIso  = checkinDT.toISOString()
  if (existing.checkout_datetime === newCheckoutIso && existing.checkin_datetime === newCheckinIso) {
    return // genuinely unchanged — don't touch dates_changed_at over a no-op
  }

  if (existing.status === 'pending_assignment' || existing.status === 'assigned') {
    const { error } = await supabase
      .from('turnovers')
      .update({
        checkout_datetime: newCheckoutIso,
        checkin_datetime:  newCheckinIso,
        window_minutes:    windowMinutes,
        priority,
      })
      .eq('id', existing.id)
    if (error) {
      console.error('[generator] pair date-refresh update failed', { propertyId, turnoverId: existing.id, msg: error.message })
    } else {
      console.log('[generator] refreshed turnover dates for changed booking pair', { propertyId, turnoverId: existing.id })
    }
    return
  }

  if (existing.status === 'in_progress') {
    const { error } = await supabase
      .from('turnovers')
      .update({
        pending_checkout_datetime:    newCheckoutIso,
        pending_checkin_datetime:     newCheckinIso,
        dates_changed_at:             new Date().toISOString(),
        dates_change_acknowledged_at: null, // re-arm the banner even if a prior change was already acknowledged
      })
      .eq('id', existing.id)
    if (error) {
      console.error('[generator] pair pending-date-stage failed', { propertyId, turnoverId: existing.id, msg: error.message })
    } else {
      console.log('[generator] staged pending date change for in-progress turnover', { propertyId, turnoverId: existing.id })
    }
    return
  }

  // completed / cancelled — historical record, never touched.
}

export async function snapshotChecklist(
  supabase:   DBClient,
  turnoverID: string,
  orgId:      string,
  propertyId: string,
  templateId: string | null
): Promise<void> {
  if (!templateId) return
  const { data: sections } = await supabase
    .from('checklist_template_sections')
    .select(`id, name, sort_order,
      checklist_template_items ( id, task, requires_photo, notes, sort_order )`)
    .eq('template_id', templateId)
    .order('sort_order', { ascending: true })
  if (!sections?.length) return
  const { data: instance } = await supabase
    .from('checklist_instances')
    .insert({ turnover_id: turnoverID, org_id: orgId, template_id: templateId,
              template_snapshot: sections, status: 'not_started' })
    .select('id').single()
  if (!instance) return

  // Dynamic photo requirements from the nightly Bayesian signal cron.
  // Minimum completions gate: with zero history, the prior alone puts a
  // brand-new item at alpha=2/beta=1 → 33% flag probability, which would
  // require a photo before any real evidence exists. Require at least 3
  // real completions before trusting the signal.
  const { data: signals } = await supabase
    .from('checklist_item_signals')
    .select('section_name, task, reason')
    .eq('property_id', propertyId)
    .eq('dynamic_photo_required', true)
    .gte('total_completions', 3)
  const signalMap = new Map(
    (signals ?? []).map((s: { section_name: string; task: string; reason: string | null }) =>
      [`${s.section_name}|${s.task}`, s])
  )

  const items = sections.flatMap((section) =>
    (section.checklist_template_items ?? []).map((item: {
      task: string; requires_photo: boolean; notes: string | null; sort_order: number
    }) => {
      const signal = signalMap.get(`${section.name}|${item.task}`)
      const dynamicRequired = !!signal
      return {
        instance_id: instance.id, turnover_id: turnoverID, section_name: section.name,
        task: item.task,
        requires_photo: item.requires_photo || dynamicRequired,
        photo_reason: !item.requires_photo && dynamicRequired ? signal!.reason : null,
        notes: item.notes, sort_order: item.sort_order, is_completed: false,
        // Explicit (not omitted) so this object's key set exactly matches
        // buildAssetDiscoveryItems' below — PostgREST's bulk insert derives
        // its column list from the union of keys across every object in
        // the array, and any object missing a key another object supplies
        // gets NULL for it (not the column's DEFAULT). Omitting these here
        // previously meant every regular item's is_mandatory/non_deletable
        // was inserted as NULL — violating their NOT NULL constraint and
        // failing the whole batch insert — whenever the same turnover also
        // had at least one asset-discovery item mixed into the same array.
        is_mandatory: false, non_deletable: false, asset_discovery_type: null as string | null,
      }
    })
  )

  // Progressive Asset Discovery: inject system-mandated, non-deletable tasks
  // for any required asset type not yet verified on this property.
  const missingAssetTypes = await getMissingAssetDiscoveryTypes(supabase, propertyId)
  if (missingAssetTypes.length > 0) {
    items.push(...buildAssetDiscoveryItems(instance.id, turnoverID, missingAssetTypes, items.length))
  }

  if (items.length > 0) await supabase.from('checklist_instance_items').insert(items)
}

/**
 * When a booking is cancelled, cancel any turnovers that depended on it.
 * A turnover depends on a booking if it's the prev_booking OR the next booking.
 * If the prev booking disappears, the turnover no longer has a checkout to clean after.
 * If the next booking disappears, there's no arrival to prep for.
 */
export interface CancelledTurnoverAssignment {
  turnoverId:   string
  orgId:        string
  crewMemberId: string
}

export async function cancelTurnoversForBooking(
  bookingId: string,
  supabase:  DBClient
): Promise<CancelledTurnoverAssignment[]> {
  // Single atomic UPDATE ... RETURNING (via .update().select()) rather than
  // a separate SELECT-then-UPDATE — captures who was assigned in the same
  // statement that flips status, so there's no window for a concurrent
  // unassignment to slip in between "read who's assigned" and "cancel".
  // Only turnovers that were actually 'assigned' have any
  // turnover_assignments rows to embed — a 'pending_assignment' turnover
  // never had a crew member, regardless of its post-update status here, so
  // no separate status check is needed on the returned rows.
  const { data: updated } = await supabase
    .from('turnovers')
    .update({ status: 'cancelled' })
    .or(`booking_id.eq.${bookingId},prev_booking_id.eq.${bookingId}`)
    .in('status', ['pending_assignment', 'assigned'])
    .select('id, org_id, turnover_assignments(crew_member_id)')

  const cancelled: CancelledTurnoverAssignment[] = []
  for (const t of updated ?? []) {
    const assignments = unwrapJoinArray<{ crew_member_id: string }>(t.turnover_assignments)
    for (const a of assignments) {
      cancelled.push({ turnoverId: t.id, orgId: t.org_id, crewMemberId: a.crew_member_id })
    }
  }
  return cancelled
}

/**
 * Fires one turnover/cancelled event per affected crew member, batching
 * every turnover cancelled out from under them by the same booking event
 * into a single notification — mirrors turnover/crew-assigned's own
 * batching so a crew member with two stacked turnovers on the same
 * cancelled booking gets one push/SMS, not two. Call this from an Inngest
 * step.run() after cancelTurnoversForBooking(); kept separate from that
 * function so generator.ts's DB-only functions stay free of the Inngest
 * import except where a notification is the whole point.
 */
export async function notifyCrewOfCancelledTurnovers(
  cancelled: CancelledTurnoverAssignment[]
): Promise<void> {
  if (cancelled.length === 0) return

  const byCrewMember = new Map<string, { orgId: string; turnoverIds: string[] }>()
  for (const c of cancelled) {
    const existing = byCrewMember.get(c.crewMemberId)
    if (existing) {
      existing.turnoverIds.push(c.turnoverId)
    } else {
      byCrewMember.set(c.crewMemberId, { orgId: c.orgId, turnoverIds: [c.turnoverId] })
    }
  }

  const { inngest } = await import('@/lib/inngest/client')
  await Promise.all(
    Array.from(byCrewMember.entries()).map(([crewMemberId, { orgId, turnoverIds }]) =>
      inngest.send({
        name: 'turnover/cancelled',
        data: { crew_member_id: crewMemberId, turnover_ids: turnoverIds, org_id: orgId },
      })
    )
  )
}

/**
 * Calculate next due date for a routine maintenance schedule.
 */
export function calcNextDueDate(frequency: string, from: Date): Date {
  const next = new Date(from)
  switch (frequency) {
    case 'weekly':      next.setDate(next.getDate() + 7);          break
    case 'biweekly':    next.setDate(next.getDate() + 14);         break
    case 'monthly':     next.setMonth(next.getMonth() + 1);        break
    case 'quarterly':   next.setMonth(next.getMonth() + 3);        break
    case 'semi_annual': next.setMonth(next.getMonth() + 6);        break
    case 'annual':      next.setFullYear(next.getFullYear() + 1);  break
    default:            next.setMonth(next.getMonth() + 1);        break
  }
  return next
}
