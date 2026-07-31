// lib/storage/object-path.ts
//
// One place that knows the shape of an object key in the two ORG-SCOPED photo
// buckets (`work-order-photos`, `turnover-photos`).
//
// Both buckets are PRIVATE and carry org-scoped storage.objects RLS policies
// (supabase/migrations/20260730103000_*) that key off the FIRST path segment
// via public.storage_org_prefix(name). A path whose first segment is not the
// owning org's UUID is unreachable by every policy — the upload is denied and
// no signed URL can ever be minted for it. So every write MUST go through
// orgScopedStoragePath().
//
// Reads are the mirror image: historical rows persisted either a full
// `/storage/v1/object/public/<bucket>/<key>` URL (property_assets.photo_url
// did exactly this) or a legacy non-org-prefixed key. toStorageObjectPath()
// normalizes both back to a bare object key so a signed-URL/download call
// still resolves them instead of 404-ing.
//
// Isomorphic on purpose — imported from crew PWA client components, PM client
// components, Server Actions, Route Handlers, and Inngest steps alike. No
// `server-only`, no Supabase import.

export const ORG_SCOPED_PHOTO_BUCKETS = ['work-order-photos', 'turnover-photos'] as const

export type OrgScopedPhotoBucket = (typeof ORG_SCOPED_PHOTO_BUCKETS)[number]

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Builds an object key for an org-scoped photo bucket.
 *
 * The leading `${orgId}/` segment is what the storage RLS policies match on —
 * never hand-build one of these paths with a template literal.
 */
export function orgScopedStoragePath(orgId: string, ...segments: string[]): string {
  if (!UUID_RE.test(orgId)) {
    throw new Error('orgScopedStoragePath: orgId must be the org UUID (it is the RLS-matched first path segment)')
  }
  const tail = segments
    .flatMap((s) => s.split('/'))
    .map((s) => s.trim())
    .filter(Boolean)
  return [orgId, ...tail].join('/')
}

/** True when `path`'s first segment is `orgId` — i.e. the storage policies can see it. */
export function hasOrgPrefix(path: string, orgId: string): boolean {
  return path.startsWith(`${orgId}/`)
}

/** True when `path`'s first segment is *some* org UUID (used to spot legacy keys). */
export function hasAnyOrgPrefix(path: string): boolean {
  const first = path.split('/')[0] ?? ''
  return UUID_RE.test(first)
}

/**
 * Normalizes a stored value to a bare object key for `bucket`.
 *
 * Accepts, in order:
 *  - a full Supabase Storage URL (`.../object/public/<bucket>/<key>`,
 *    `.../object/sign/<bucket>/<key>?token=…`, `.../object/<bucket>/<key>`)
 *  - a bare key, returned unchanged (including legacy non-org-prefixed keys —
 *    those objects still exist under their old key and must stay readable)
 *
 * Returns null for an empty/missing value, or for a URL that points at some
 * OTHER bucket (which would otherwise silently authorize a cross-bucket read).
 */
export function toStorageObjectPath(bucket: string, stored: string | null | undefined): string | null {
  const value = stored?.trim()
  if (!value) return null

  if (!value.includes('://')) return value

  // A URL — find `/<bucket>/` after the storage object endpoint.
  const marker = `/${bucket}/`
  const objectIdx = value.indexOf('/storage/v1/object/')
  if (objectIdx === -1) return null

  const bucketIdx = value.indexOf(marker, objectIdx)
  if (bucketIdx === -1) return null

  const key = value.slice(bucketIdx + marker.length).split('?')[0] ?? ''
  if (!key) return null

  try {
    return decodeURIComponent(key)
  } catch {
    // Malformed percent-escape — the raw key is still closer to correct than
    // throwing out of a read path.
    return key
  }
}
