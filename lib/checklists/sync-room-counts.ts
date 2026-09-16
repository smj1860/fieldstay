// lib/checklists/sync-room-counts.ts
// ============================================================================
// Keep a property's counted checklist sections in step with its bedroom and
// bathroom counts, after the checklist already exists.
//
// THE GAP THIS CLOSES. applyMasterChecklistToProperty composes N bedroom
// sections where N = properties.bedrooms, and it runs in exactly two places:
// property creation, and a PMS initial sync. Nothing re-ran it when the counts
// were later corrected, so a property imported with the wrong bedroom count
// kept a checklist built for the wrong bedroom count — permanently, unless the
// PM hand-added the missing sections.
//
// That is guaranteed for a Hostex import (its /properties exposes no bedroom
// count at all, so every property lands at the 1-bedroom default), and
// reachable for any provider whose data is incomplete, and for a property
// created by hand with a typo. Inventory par levels already self-healed on the
// same edit — smart pars recompute from bedrooms/bathrooms/max_guests via
// `inventory/par-recompute-requested` — so the checklist was the odd one out.
//
// ADDITIVE ONLY, deliberately. This mirrors applyRoomQuantities() in
// checklist-builder.tsx, the PM-facing "Insert Rooms from Library" picker:
// count the sections already derived from that room template, and add up to
// the target. Never remove.
//
// Lowering a count therefore leaves the surplus sections in place, and that is
// the right trade. A section may carry crew-customised items, renamed tasks or
// photo requirements, and deleting it to satisfy an arithmetic target would
// silently destroy that work — where leaving it costs the PM one visible,
// reversible click in the builder. The UI has always behaved this way; the
// server now behaves the same.
// ============================================================================

import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { reportError } from '@/lib/observability/report-error'
import { acquireLock, releaseLock, renewLock, SINGLE_FLIGHT_DEFAULTS } from '@/lib/cache/single-flight'
import {
  fetchOrgRoomTemplateData,
  type OrgRoomTemplateData,
} from '@/lib/checklists/apply-master-template'
import { numberedRoomLabel, numberedRoomLabelEs } from '@/lib/checklists/room-label'

/** Cap on sections read back for one property's default template. */
const SECTION_LIMIT = 500

export interface RoomCounts {
  bedrooms:  number
  bathrooms: number | null
}

export interface RoomCountSyncResult {
  /** Sections added. 0 when the checklist already matched, or had none to match. */
  added: number
}

interface PlannedSection {
  template_id:      string
  name:             string
  name_es:          string | null
  room_template_id: string
  sort_order:       number
}

/**
 * Which sections are missing, as data. Pure — no I/O — so the arithmetic that
 * decides what to add can be read and tested without a database.
 */
function planMissingSections(
  templateId:     string,
  existing:       Array<{ room_template_id: string | null; sort_order: number | null }>,
  roomData:       OrgRoomTemplateData,
  counts:         RoomCounts,
): PlannedSection[] {
  const { bedroomRoomTemplateId, bathroomRoomTemplateId, roomTemplates } = roomData

  const targets: Array<[string | null, number]> = [
    [bedroomRoomTemplateId,  counts.bedrooms],
    [bathroomRoomTemplateId, counts.bathrooms ?? 0],
  ]

  let sortOrder = existing.reduce((max, s) => Math.max(max, Number(s.sort_order) || 0), -1) + 1
  const planned: PlannedSection[] = []

  for (const [roomTemplateId, target] of targets) {
    if (!roomTemplateId || target <= 0) continue

    const room = roomTemplates.find((r) => r.id === roomTemplateId)
    if (!room) continue

    const currentCount = existing.filter((s) => s.room_template_id === roomTemplateId).length

    // Same numbering as applyRoomQuantities: an existing lone "Bedroom" is NOT
    // renamed to "Bedroom 1" when the count grows. Matching the picker matters
    // more than the cosmetic gap, and renaming a section a PM may have
    // referred to is the worse surprise.
    for (let i = currentCount + 1; i <= target; i++) {
      planned.push({
        template_id:      templateId,
        name:             numberedRoomLabel(room.name, target, i),
        name_es:          numberedRoomLabelEs(room.name_es, target, i),
        room_template_id: roomTemplateId,
        sort_order:       sortOrder++,
      })
    }
  }

  return planned
}

/**
 * Inserts the planned sections and their items. Two writes regardless of how
 * many sections are missing — all sections in one insert, all their items in
 * a second. A per-section loop would be the query-per-iteration shape
 * unit/guardrails/n-plus-one-loops.test.ts exists to catch, and correcting a
 * studio to an eight-bedroom would issue sixteen round trips inside a
 * user-facing save. Errors propagate to the caller's try/catch — this
 * function is only ever called from inside syncChecklistRoomCounts's
 * lock-guarded block.
 */
async function insertPlannedSections(
  supabase:   SupabaseClient,
  templateId: string,
  planned:    PlannedSection[],
  roomData:   OrgRoomTemplateData,
): Promise<RoomCountSyncResult> {
  const { data: created, error: insertErr } = await supabase
    .from('checklist_template_sections')
    .insert(planned)
    .select('id, room_template_id')

  if (insertErr) throw insertErr

  // Sections created but items not attached is worse than nothing — the crew
  // sees a room they cannot act on — so a short read here is refused rather
  // than half-populated.
  if ((created ?? []).length !== planned.length) {
    throw new Error(`inserted ${planned.length} sections but read back ${(created ?? []).length}`)
  }

  const items = (created ?? []).flatMap((section) =>
    (roomData.itemsByTemplate[section.room_template_id as string] ?? []).map((item) => ({
      section_id:     section.id as string,
      template_id:    templateId,
      task:           item.task,
      task_es:        item.task_es,
      requires_photo: item.requires_photo,
      notes:          item.notes,
      sort_order:     item.sort_order,
    }))
  )

  if (items.length) {
    const { error: itemsErr } = await supabase.from('checklist_template_items').insert(items)
    if (itemsErr) throw itemsErr
  }

  return { added: planned.length }
}

/**
 * Top up a property's bedroom/bathroom sections to match its current counts.
 *
 * Never throws: a checklist one section short is a visible, fixable
 * inconvenience, whereas failing the enclosing save would reject a property
 * edit already committed to the database.
 *
 * LOCKED PER PROPERTY around the read-then-insert. No DB constraint backs the
 * section count this function reads — there deliberately can't be one:
 * `planMissingSections` numbers a new section from `currentCount + 1`, and
 * two identically-numbered "Bedroom 3" sections are a legitimate outcome of
 * the PM-facing "Insert Rooms from Library" picker, not a row a unique index
 * could reject. Without this lock, two concurrent calls for the same
 * property — a double-submitted edit, two tabs — would both read the SAME
 * existing sections, both decide the SAME sections are missing, and both
 * insert them: two "Bedroom 3" sections, each generating its own duplicate
 * set of checklist items for a crew member to work through. Fails open like
 * every other lock built on lib/cache/single-flight.ts — no Redis means
 * proceed unlocked, no worse than before this existed.
 *
 * The lock is acquired only after confirming there is a default template to
 * work against — a property with none (the common no-op case) never pays for
 * it.
 *
 * The lock's TTL is fixed at acquisition and Redis does not know how long the
 * guarded insert will actually take, so it is RENEWED once the sections read
 * comes back and the potentially-slow part (inserting up to a many-bedroom
 * property's worth of sections plus their items) is about to start. Without
 * this, a correction of a studio to a large multi-bedroom property that took
 * longer than the TTL would let a concurrent retry see the lock as expired,
 * acquire it, and duplicate the insert — exactly the race this lock exists to
 * prevent. Best-effort (renewLock never throws): a failed renewal just means
 * the original TTL still applies, no worse than before this existed.
 */
export async function syncChecklistRoomCounts(
  propertyId: string,
  orgId:      string,
  supabase:   SupabaseClient,
  counts:     RoomCounts,
  orgRoomData?: OrgRoomTemplateData,
): Promise<RoomCountSyncResult> {
  try {
    // The property's DEFAULT template only. A property with none has not been
    // through checklist composition yet — creation or the next sync will build
    // it from the corrected counts, so there is nothing to top up here.
    const { data: template, error: templateErr } = await supabase
      .from('checklist_templates')
      .select('id')
      .eq('org_id', orgId)
      .eq('property_id', propertyId)
      .eq('is_default', true)
      .maybeSingle()

    if (templateErr) throw templateErr
    if (!template) return { added: 0 }

    const templateId = template.id as string
    const roomData   = orgRoomData ?? await fetchOrgRoomTemplateData(orgId, supabase)

    const lockKey = `sync-checklist-room-counts:${propertyId}`
    if (!(await acquireLock(lockKey))) {
      // Someone else is topping up this property's checklist right now.
      // Their insert already covers whatever was missing — this caller
      // doing nothing is the correct outcome, not a missed one.
      return { added: 0 }
    }

    try {
      const { data: sections, error: sectionsErr } = await supabase
        .from('checklist_template_sections')
        .select('id, room_template_id, sort_order')
        .eq('template_id', templateId)
        .limit(SECTION_LIMIT)

      if (sectionsErr) throw sectionsErr

      const planned = planMissingSections(templateId, sections ?? [], roomData, counts)
      if (!planned.length) return { added: 0 }

      // Re-arm the TTL before the two inserts below — see the header
      // comment's note on why a fixed TTL can't be trusted to outlive this.
      await renewLock(lockKey, SINGLE_FLIGHT_DEFAULTS.DEFAULT_LOCK_TTL_SECONDS)

      return await insertPlannedSections(supabase, templateId, planned, roomData)
    } finally {
      await releaseLock(lockKey)
    }
  } catch (err) {
    console.error('[syncChecklistRoomCounts]', err)
    reportError(err, {
      site:  'lib.checklists.sync-room-counts',
      orgId,
      extra: { propertyId },
    })
    return { added: 0 }
  }
}
