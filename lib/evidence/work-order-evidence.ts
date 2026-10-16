// lib/evidence/work-order-evidence.ts
//
// The sealed photographs for one work order, split into "before" (what the PM
// or crew documented ahead of the work) and "after" (what the vendor uploaded
// when finishing), with short-lived signed URLs. Shared by three surfaces:
//   - the PM's work order photo page (owner P&L "View photos"),
//   - the owner portal's read-only copy of it,
//   - the vendor portal's "photos from the property manager" panel.
//
// Runs on a SERVICE client: two of the three callers have no Supabase session
// (owner token, vendor token). Every read here is therefore scoped explicitly,
// and THE CALLER decides whether this work order may be shown to its audience
// before calling. This module never decides authorization.
//
// "Before" and "after" are derived from who captured the photo, not from a
// timestamp: PM and crew uploads document the problem, vendor uploads document
// the fix. A withdrawn photo is excluded, never listed.
import 'server-only'
import { chunkArray, IN_CLAUSE_CHUNK_SIZE } from '@/lib/inngest/chunk'
import { toStorageObjectPath } from '@/lib/storage/object-path'
import { unwrapList } from '@/lib/supabase/unwrap'
import { reportError } from '@/lib/observability/report-error'
import type { DBClient } from '@/lib/supabase/server'

export const WORK_ORDER_PHOTO_URL_TTL_SECONDS = 300
const MAX_WORK_ORDER_EVIDENCE = 100

export type WorkOrderEvidenceSide = 'before' | 'after'

export interface WorkOrderEvidencePhoto {
  id:            string
  side:          WorkOrderEvidenceSide
  capturedAt:    string
  capturedByKind: string
  hashVerified:  boolean
  url:           string
}

export interface WorkOrderEvidence {
  before: WorkOrderEvidencePhoto[]
  after:  WorkOrderEvidencePhoto[]
}

interface Row {
  id:               string
  bucket:           string
  storage_path:     string
  captured_at:      string
  captured_by_kind: string
  hash_verified:    boolean
}

export function sideOf(capturedByKind: string): WorkOrderEvidenceSide {
  return capturedByKind === 'vendor' ? 'after' : 'before'
}

async function withdrawnOriginals(supabase: DBClient, orgId: string, workOrderId: string): Promise<Set<string>> {
  const res = await supabase
    .from('evidence_events').select('refers_to_event_id')
    .eq('org_id', orgId).eq('work_order_id', workOrderId).eq('kind', 'photo_withdrawn')
    .limit(MAX_WORK_ORDER_EVIDENCE)
  return new Set(unwrapList(res, { site: 'lib.evidence.woEvidence.withdrawn', orgId })
    .map((r) => r.refers_to_event_id).filter((x): x is string => x !== null))
}

async function signAll(supabase: DBClient, rows: readonly Row[]): Promise<Map<string, string>> {
  const urls = new Map<string, string>()
  const byBucket = new Map<string, { id: string; path: string }[]>()
  for (const r of rows) {
    const path = toStorageObjectPath(r.bucket, r.storage_path)
    if (path) byBucket.set(r.bucket, [...(byBucket.get(r.bucket) ?? []), { id: r.id, path }])
  }
  const batches = [...byBucket].flatMap(([bucket, entries]) =>
    chunkArray(entries, IN_CLAUSE_CHUNK_SIZE).map((chunk) => ({ bucket, chunk })))
  const signBatch = async ({ bucket, chunk }: { bucket: string; chunk: { id: string; path: string }[] }) => {
    const { data, error } = await supabase.storage.from(bucket)
      .createSignedUrls(chunk.map((e) => e.path), WORK_ORDER_PHOTO_URL_TTL_SECONDS)
    // A failed sign costs those photos their thumbnails, not the page.
    if (error) { reportError(error, { site: 'lib.evidence.woEvidence.sign', level: 'warning' }); return }
    chunk.forEach((e, i) => { const u = data?.[i]?.signedUrl; if (u) urls.set(e.id, u) })
  }
  await Promise.all(batches.map(signBatch))
  return urls
}

export async function loadWorkOrderEvidence(
  supabase: DBClient,
  input: { orgId: string; workOrderId: string; sides: readonly WorkOrderEvidenceSide[] },
): Promise<WorkOrderEvidence> {
  const { orgId, workOrderId } = input
  const res = await supabase
    .from('evidence_events')
    .select('id, bucket, storage_path, captured_at, captured_by_kind, hash_verified')
    .eq('org_id', orgId).eq('work_order_id', workOrderId).eq('kind', 'photo_sealed')
    .order('captured_at', { ascending: true })
    .limit(MAX_WORK_ORDER_EVIDENCE)
  const withdrawn = await withdrawnOriginals(supabase, orgId, workOrderId)
  const rows = (unwrapList(res, { site: 'lib.evidence.woEvidence.events', orgId }) as Row[])
    .filter((r) => !withdrawn.has(r.id) && input.sides.includes(sideOf(r.captured_by_kind)))

  const urls = await signAll(supabase, rows)
  const out: WorkOrderEvidence = { before: [], after: [] }
  for (const r of rows) {
    const url = urls.get(r.id)
    if (!url) continue
    const side = sideOf(r.captured_by_kind)
    out[side].push({
      id: r.id, side, capturedAt: r.captured_at, capturedByKind: r.captured_by_kind,
      hashVerified: r.hash_verified, url,
    })
  }
  return out
}
