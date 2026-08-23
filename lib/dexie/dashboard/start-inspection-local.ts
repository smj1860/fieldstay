'use client'

// lib/dexie/dashboard/start-inspection-local.ts
//
// Starting an inspection ON THE DEVICE — the only start path, online or off.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THERE IS ONLY ONE PATH
//
// A separate online start (a Server Action) and offline start (this) would be
// two implementations of one thing, and the offline one is the one nobody
// exercises at a desk. So this always runs, and the outbox decides when the row
// reaches the server: online it drains within a second and behaves exactly as
// the old Server Action did; offline it lands on reconnect.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE DEVICE DECIDES, AND WHAT IT DOES NOT
//
// THE DEVICE OWNS THE FORM SNAPSHOT. It must, because the snapshot has to
// record the form that was actually WALKED. If the server built it at create
// time, a re-seed between the walk and the sync would freeze a different form
// than the questions the inspector answered — the exact substitution
// `form_snapshot` exists to prevent.
//
// THE SERVER OWNS THE HEADER SNAPSHOT. The letterhead needs the org owner's
// name, which is a role-filtered membership read, and caching that on every
// tablet is a worse trade than accepting that the letterhead reflects the
// moment the create lands. Nobody transfers ownership inside a six-hour drive.
//
// THE SERVER OWNS started_at. The device says what time it thinks the walk
// began; the create route measures the clock skew in the same request and
// corrects. See 20260823053931 for why that is enough.

import { buildFormSnapshot } from '@/lib/inspections/snapshots'
import type { Inspection } from '@/types/database'

import { getDashboardDb } from './schema'
import { enqueueDashboardMutation } from './syncService'

export type StartLocalOutcome =
  | { ok: true; inspectionId: string }
  | { ok: false; error: string }

/**
 * Creates the inspection locally and queues it for the server.
 *
 * The id is client-generated so the local row and the queued write agree, and
 * so a replayed create collides on the primary key rather than making a second
 * inspection. `crypto.randomUUID` rather than anything seeded — CLAUDE.md bans
 * Math.random for ids, and this one is a database key.
 */
export async function startInspectionLocally(
  userId:  string,
  orgId:   string,
  input:   { propertyId: string; formKey: string },
): Promise<StartLocalOutcome> {
  const db = getDashboardDb(userId, orgId)

  const form = await loadCachedForm(db, input.formKey)
  if (!form) {
    // Distinct from a generic failure: this device has never been online long
    // enough to hold the forms, and no amount of retrying here will fix it.
    return { ok: false, error: 'The inspection forms aren’t on this device yet. Reconnect once, then try again.' }
  }

  const property = await db.properties.get(input.propertyId)
  // Covers both "not cached" and "cached but another org's" — undefined is not
  // equal to orgId either, and the remedy the message offers is the same.
  if (property?.org_id !== orgId) {
    return { ok: false, error: 'That property isn’t on this device yet. Reconnect once, then try again.' }
  }

  const inspectionId  = crypto.randomUUID()
  const deviceStarted = new Date().toISOString()

  const snapshot = buildFormSnapshot(
    form.key, form.version, form.sections, form.items, deviceStarted,
  )

  const row: Inspection = {
    id:            inspectionId,
    org_id:        orgId,
    property_id:   input.propertyId,
    form_id:       form.id,
    form_version:  form.version,
    form_snapshot: snapshot,
    // The server builds this at create — see the header comment.
    header_snapshot: null,
    assigned_to_user_id: userId,
    inspector_name:      null,
    scheduled_for:       null,
    // Provisional, and labelled as such. The create route replaces it with the
    // skew-corrected value; until then this is what the UI shows, which is the
    // device's own belief and therefore right for the device's own display.
    started_at:                  deviceStarted,
    started_at_source:           'device',
    device_started_at:           deviceStarted,
    device_clock_offset_seconds: null,
    completed_at:         null,
    completed_by_user_id: null,
    source_schedule_id:     null,
    corrects_inspection_id: null,
    created_at: deviceStarted,
    updated_at: deviceStarted,
  }

  await enqueueDashboardMutation(
    userId, orgId,
    {
      kind:     'inspection.create',
      targetId: inspectionId,
      payload:  {
        id:            inspectionId,
        property_id:   input.propertyId,
        form_id:       form.id,
        form_version:  form.version,
        form_snapshot: snapshot,
        // `device_now` is deliberately NOT set here. The offset is only
        // meaningful when both clocks are read at the same instant, so the
        // upload handler stamps it at POST time — which may be hours later.
        device_started_at: deviceStarted,
      },
    },
    // Same transaction as the outbox row. CLAUDE.md's rule, bought with a real
    // bug: as two transactions a reclaimed PWA leaves a local row with nothing
    // queued to send it — here, an inspection that exists only on the tablet
    // and never reaches anyone.
    () => { void db.inspections.put(row) },
  )

  return { ok: true, inspectionId }
}

interface CachedForm {
  id:       string
  key:      string
  version:  number
  sections: Parameters<typeof buildFormSnapshot>[2]
  items:    Parameters<typeof buildFormSnapshot>[3]
}

/**
 * The highest active version of a form, from the local cache.
 *
 * Returns null rather than a partial form. A form whose items did not cache
 * would resolve to a SHORTER walk — every question the inspector is shown gets
 * answered, the Review gate passes, and a whole section is silently absent from
 * the record.
 */
async function loadCachedForm(
  db:      ReturnType<typeof getDashboardDb>,
  formKey: string,
): Promise<CachedForm | null> {
  const candidates = await db.inspection_forms.where('key').equals(formKey).toArray()
  const form = candidates
    .filter((f) => f.is_active)
    .sort((a, b) => b.version - a.version)[0]
  if (!form) return null

  const sections = await db.inspection_form_sections.where('form_id').equals(form.id).toArray()
  if (sections.length === 0) return null

  const sectionIds = new Set(sections.map((s) => s.id))
  const items = (await db.inspection_form_items.toArray())
    .filter((i) => sectionIds.has(i.section_id))
  if (items.length === 0) return null

  return { id: form.id, key: form.key, version: form.version, sections, items }
}
