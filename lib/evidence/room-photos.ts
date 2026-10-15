// lib/evidence/room-photos.ts
//
// Builds the mandatory evidence photo items injected into every turnover
// checklist: one "Room condition" doorway shot per room section, plus the
// property's claim spots. Pure functions over the template snapshot; the only
// I/O is loadOrSeedClaimSpots(). Mirrors lib/asset-discovery/engine.ts.
import type { DBClient } from '@/lib/supabase/server'
import { unwrapList } from '@/lib/supabase/unwrap'
import {
  ROOM_CONDITION_TASK, ROOM_CONDITION_REASON, EVIDENCE_SECTION, EVIDENCE_SECTION_ES,
} from './room-photo-copy'

export { ROOM_CONDITION_TASK, ROOM_CONDITION_REASON, EVIDENCE_SECTION, EVIDENCE_SECTION_ES }

/**
 * Sections that are not rooms and get no room-condition shot. Matched
 * case-insensitively on the English name. Confirm with the owner (R1).
 */
export const NON_ROOM_SECTIONS: readonly string[] = [
  'asset discovery', 'exterior', 'outside', 'arrival', 'departure',
  'final walkthrough', 'walkthrough', 'final checks', 'final check', 'final inspection', 'final',
  'supplies', 'inventory', 'restock',
  // Spanish names, for a template an org wrote in Spanish.
  'exteriores', 'llegada', 'salida', 'revisión final', 'revision final', 'recorrido final',
  'inventario', 'suministros', 'reposición', 'reposicion',
  EVIDENCE_SECTION.toLowerCase(),
]

export function isRoomSection(sectionName: string): boolean {
  const n = sectionName.trim().toLowerCase()
  return n.length > 0 && !NON_ROOM_SECTIONS.includes(n)
}

/** Seeded once per property on its first turnover after this ships (R2). */
export const DEFAULT_CLAIM_SPOTS: ReadonlyArray<{ match: RegExp; label: string; label_es: string }> = [
  { match: /bed/i,            label: 'Mattress, cover pulled back',   label_es: 'Colchón, con la funda retirada' },
  { match: /living|family/i,  label: 'Sofa cushions, lifted',         label_es: 'Cojines del sofá, levantados' },
  { match: /dining/i,         label: 'Table top',                     label_es: 'Superficie de la mesa' },
  { match: /kitchen/i,        label: 'Oven interior, door open',      label_es: 'Interior del horno, puerta abierta' },
  { match: /kitchen/i,        label: 'Refrigerator interior',         label_es: 'Interior del refrigerador' },
  { match: /bath/i,           label: 'Shower and tub from the door',  label_es: 'Ducha y bañera desde la puerta' },
]

export interface ClaimSpot {
  id:           string
  section_name: string
  label:        string
  label_es:     string | null
  sort_order:   number
}

interface SnapshotSection { name: string; name_es: string | null }

/**
 * One injected row. The key set MUST equal the regular item objects in
 * snapshotChecklist (and buildAssetDiscoveryItems): PostgREST's bulk insert
 * unions keys across the array and NULLs the gaps, which violates NOT NULL and
 * fails the whole batch.
 */
export interface EvidencePhotoItemRow {
  instance_id:          string
  turnover_id:          string
  section_name:         string
  section_name_es:      string | null
  task:                 string
  task_es:              string | null
  requires_photo:       boolean
  photo_reason:         string | null
  notes:                string | null
  sort_order:           number
  is_completed:         boolean
  is_mandatory:         boolean
  non_deletable:        boolean
  asset_discovery_type: string | null
  evidence_role:        string | null
  evidence_spot_id:     string | null
}

interface RowParts {
  instanceId: string
  turnoverId: string
  section:    { name: string; name_es: string | null }
  task:       { en: string; es: string }
  role:       'room_condition' | 'claim_spot'
  spotId:     string | null
  sortOrder:  number
}

function evidenceRow(p: RowParts): EvidencePhotoItemRow {
  return {
    instance_id: p.instanceId, turnover_id: p.turnoverId,
    section_name: p.section.name, section_name_es: p.section.name_es,
    task: p.task.en, task_es: p.task.es,
    requires_photo: true, photo_reason: ROOM_CONDITION_REASON.en,
    notes: null, sort_order: p.sortOrder, is_completed: false,
    is_mandatory: true, non_deletable: true, asset_discovery_type: null,
    evidence_role: p.role, evidence_spot_id: p.spotId,
  }
}

export function buildEvidencePhotoItems(
  instanceId:     string,
  turnoverId:     string,
  sections:       readonly SnapshotSection[],
  spots:          readonly ClaimSpot[],
  startSortOrder: number,
): EvidencePhotoItemRow[] {
  const rows: EvidencePhotoItemRow[] = []
  let sort = startSortOrder
  const sectionNames = new Set(sections.map((s) => s.name))
  const base = { instanceId, turnoverId }

  for (const section of sections.filter((s) => isRoomSection(s.name))) {
    rows.push(evidenceRow({ ...base, section, task: ROOM_CONDITION_TASK, role: 'room_condition', spotId: null, sortOrder: sort++ }))
    for (const spot of spots.filter((x) => x.section_name === section.name)) {
      rows.push(evidenceRow({
        ...base, section, task: { en: spot.label, es: spot.label_es ?? spot.label },
        role: 'claim_spot', spotId: spot.id, sortOrder: sort++,
      }))
    }
  }

  // Spots whose section no longer exists on the template: never drop silently.
  const orphanSection = { name: EVIDENCE_SECTION, name_es: EVIDENCE_SECTION_ES }
  for (const spot of spots.filter((x) => !sectionNames.has(x.section_name))) {
    rows.push(evidenceRow({
      ...base, section: orphanSection,
      task: { en: `${spot.section_name}: ${spot.label}`, es: `${spot.section_name}: ${spot.label_es ?? spot.label}` },
      role: 'claim_spot', spotId: spot.id, sortOrder: sort++,
    }))
  }
  return rows
}

/**
 * Active claim spots for the property. On the first call for a property with
 * no rows at all, seeds DEFAULT_CLAIM_SPOTS against the template's room
 * sections, so the PM starts from a sensible list instead of an empty one.
 * Idempotent: the UNIQUE (property_id, section_name, label) makes a racing
 * second seed collide, and the re-read after returns whichever won.
 */
export async function loadOrSeedClaimSpots(
  supabase:   DBClient,
  orgId:      string,
  propertyId: string,
  sections:   readonly SnapshotSection[],
): Promise<ClaimSpot[]> {
  const read = () => supabase
    .from('property_evidence_spots')
    .select('id, section_name, label, label_es, sort_order, is_active')
    .eq('org_id', orgId)
    .eq('property_id', propertyId)
    .order('sort_order', { ascending: true })
    .limit(200)

  const first = unwrapList(await read(), { site: 'lib.evidence.room-photos.spots', orgId }) ?? []
  if (first.length > 0) return first.filter((s) => s.is_active)

  const seed = sections
    .filter((s) => isRoomSection(s.name))
    .flatMap((s) => DEFAULT_CLAIM_SPOTS
      .filter((d) => d.match.test(s.name))
      .map((d, i) => ({ org_id: orgId, property_id: propertyId, section_name: s.name, label: d.label, label_es: d.label_es, sort_order: i })))
  if (seed.length === 0) return []

  const { error } = await supabase
    .from('property_evidence_spots')
    .upsert(seed, { onConflict: 'property_id,section_name,label', ignoreDuplicates: true })
  if (error) throw error   // snapshotChecklist's caller already treats a throw as a failed snapshot

  const after = unwrapList(await read(), { site: 'lib.evidence.room-photos.spots.afterSeed', orgId }) ?? []
  return after.filter((s) => s.is_active)
}
