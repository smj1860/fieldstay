// lib/evidence/backfill.ts
//
// Finds photo pointers that have no ledger row. A pointer can lack one because
// it predates the ledger, because the seal request was never sent (an older
// crew build), because a seal failed after the upload landed, or because the
// writer is a path that cannot seal itself yet. The daily sweep seals them with
// capturedBy.kind = 'system' and an honest server-observed time.
//
// Bounded two ways, both stated: only pointers touched in the last
// BACKFILL_LOOKBACK_DAYS are scanned (the table grows with TIME, not portfolio
// size), and at most MAX_SEALS_PER_RUN are sealed per org per run, so a large
// backlog drains over days rather than inside one invocation.
import 'server-only'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { hasOrgPrefix, toStorageObjectPath } from '@/lib/storage/object-path'
import type { DBClient } from '@/lib/supabase/server'
import type { EvidenceBucket, EvidenceSourceTable } from '@/types/database'

export const BACKFILL_LOOKBACK_DAYS = 120
export const MAX_SEALS_PER_RUN = 200
const DAY_MS = 86_400_000

export interface Pointer {
  bucket:       EvidenceBucket
  path:         string
  sourceTable:  EvidenceSourceTable
  sourceId:     string
  propertyId:   string
  turnoverId:   string | null
  workOrderId:  string | null
  inspectionId: string | null
  observedAt:   string | null
}

/** Pure: pointers whose (bucket, path) is not already sealed, deduped, capped. */
export function diffUnsealed(
  pointers: readonly Pointer[], sealed: ReadonlySet<string>, max: number = MAX_SEALS_PER_RUN,
): Pointer[] {
  const seen = new Set<string>()
  const out: Pointer[] = []
  for (const p of pointers) {
    const key = sealKey(p.bucket, p.path)
    if (sealed.has(key) || seen.has(key)) continue
    seen.add(key)
    out.push(p)
    if (out.length >= max) break
  }
  return out
}

export function sealKey(bucket: string, path: string): string {
  return `${bucket}|${path}`
}

/** Normalises a stored value to a bare, org-prefixed object key, or null (legacy / foreign paths are skipped, not guessed). */
function usablePath(bucket: EvidenceBucket, stored: string | null, orgId: string): string | null {
  const path = toStorageObjectPath(bucket, stored)
  return path && hasOrgPrefix(path, orgId) ? path : null
}

type Row = Record<string, unknown>
const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const obj = (v: unknown): Row => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : {})

function pointerOf(
  orgId: string, bucket: EvidenceBucket, stored: unknown,
  rest: Omit<Pointer, 'bucket' | 'path'>,
): Pointer | null {
  const path = usablePath(bucket, str(stored), orgId)
  return path ? { bucket, path, ...rest } : null
}

async function itemPointers(supabase: DBClient, orgId: string, since: string): Promise<Pointer[]> {
  const rows = await fetchAllRows<Row>((from, to) => supabase
    .from('checklist_instance_items')
    .select('id, photo_storage_path, turnover_id, completed_at, updated_at, turnovers!inner(property_id, org_id)')
    .eq('turnovers.org_id', orgId).not('photo_storage_path', 'is', null).gte('updated_at', since)
    .order('id').range(from, to), { label: 'backfill.items' })
  return rows.flatMap((r) => {
    const propertyId = str(obj(r.turnovers).property_id)
    const p = propertyId && pointerOf(orgId, 'turnover-photos', r.photo_storage_path, {
      sourceTable: 'checklist_instance_items', sourceId: String(r.id), propertyId,
      turnoverId: str(r.turnover_id), workOrderId: null, inspectionId: null,
      observedAt: str(r.completed_at) ?? str(r.updated_at),
    })
    return p ? [p] : []
  })
}

async function sectionPointers(supabase: DBClient, orgId: string, since: string): Promise<Pointer[]> {
  const rows = await fetchAllRows<Row>((from, to) => supabase
    .from('checklist_instances')
    .select('id, section_photo_path, turnover_id, updated_at, turnovers!inner(property_id)')
    .eq('org_id', orgId).not('section_photo_path', 'is', null).gte('updated_at', since)
    .order('id').range(from, to), { label: 'backfill.sections' })
  return rows.flatMap((r) => {
    const propertyId = str(obj(r.turnovers).property_id)
    const p = propertyId && pointerOf(orgId, 'turnover-photos', r.section_photo_path, {
      sourceTable: 'checklist_instances', sourceId: String(r.id), propertyId,
      turnoverId: str(r.turnover_id), workOrderId: null, inspectionId: null, observedAt: str(r.updated_at),
    })
    return p ? [p] : []
  })
}

async function assetPointers(supabase: DBClient, orgId: string, since: string): Promise<Pointer[]> {
  const rows = await fetchAllRows<Row>((from, to) => supabase
    .from('property_assets')
    .select('id, photo_url, property_id, updated_at')
    .eq('org_id', orgId).not('photo_url', 'is', null).gte('updated_at', since)
    .order('id').range(from, to), { label: 'backfill.assets' })
  return rows.flatMap((r) => {
    const p = pointerOf(orgId, 'turnover-photos', r.photo_url, {
      sourceTable: 'property_assets', sourceId: String(r.id), propertyId: String(r.property_id),
      turnoverId: null, workOrderId: null, inspectionId: null, observedAt: str(r.updated_at),
    })
    return p ? [p] : []
  })
}

async function workOrderPhotoPointers(supabase: DBClient, orgId: string, since: string): Promise<Pointer[]> {
  const rows = await fetchAllRows<Row>((from, to) => supabase
    .from('work_order_photos')
    .select('id, storage_path, work_order_id, created_at, work_orders!inner(org_id, property_id)')
    .eq('work_orders.org_id', orgId).gte('created_at', since)
    .order('id').range(from, to), { label: 'backfill.wo-photos' })
  return rows.flatMap((r) => {
    const propertyId = str(obj(r.work_orders).property_id)
    const p = propertyId && pointerOf(orgId, 'work-order-photos', r.storage_path, {
      sourceTable: 'work_order_photos', sourceId: String(r.id), propertyId,
      turnoverId: null, workOrderId: str(r.work_order_id), inspectionId: null, observedAt: str(r.created_at),
    })
    return p ? [p] : []
  })
}

async function inspectionPointers(supabase: DBClient, orgId: string, since: string): Promise<Pointer[]> {
  const rows = await fetchAllRows<Row>((from, to) => supabase
    .from('inspection_items')
    .select('id, photo_path, inspection_id, answered_at, updated_at, inspections!inner(property_id, completed_at)')
    .eq('org_id', orgId).not('photo_path', 'is', null).not('inspections.completed_at', 'is', null)
    .gte('updated_at', since).order('id').range(from, to), { label: 'backfill.inspection-items' })
  return rows.flatMap((r) => {
    const propertyId = str(obj(r.inspections).property_id)
    const p = propertyId && pointerOf(orgId, 'inspection-photos', r.photo_path, {
      sourceTable: 'inspection_items', sourceId: String(r.id), propertyId,
      turnoverId: null, workOrderId: null, inspectionId: str(r.inspection_id),
      observedAt: str(r.answered_at) ?? str(r.updated_at),
    })
    return p ? [p] : []
  })
}

async function sealedKeys(supabase: DBClient, orgId: string, sinceIso: string): Promise<Set<string>> {
  const rows = await fetchAllRows<{ bucket: string; storage_path: string }>((from, to) => supabase
    .from('evidence_events')
    .select('bucket, storage_path')
    .eq('org_id', orgId).eq('kind', 'photo_sealed').gte('received_at', sinceIso)
    .order('id').range(from, to), { label: 'backfill.sealed' })
  return new Set(rows.map((r) => sealKey(r.bucket, r.storage_path)))
}

export async function findUnsealed(supabase: DBClient, orgId: string, nowMs: number): Promise<Pointer[]> {
  const since = new Date(nowMs - BACKFILL_LOOKBACK_DAYS * DAY_MS).toISOString()
  // The sealed read reaches back further than the pointer scan: a pointer row
  // touched in the window may have been sealed well before it.
  const sealedSince = new Date(nowMs - 2 * BACKFILL_LOOKBACK_DAYS * DAY_MS).toISOString()
  const [items, sections, assets, woPhotos, inspections, sealed] = await Promise.all([
    itemPointers(supabase, orgId, since),
    sectionPointers(supabase, orgId, since),
    assetPointers(supabase, orgId, since),
    workOrderPhotoPointers(supabase, orgId, since),
    inspectionPointers(supabase, orgId, since),
    sealedKeys(supabase, orgId, sealedSince),
  ])
  return diffUnsealed([...items, ...sections, ...assets, ...woPhotos, ...inspections], sealed)
}
