import { describe, it, expect } from 'vitest'
import { collectSourceFiles, rel, read } from './scan'

// The `work-order-photos` and `turnover-photos` buckets are PRIVATE and carry
// org-scoped storage.objects RLS policies (supabase/migrations/
// 20260730103000_work_order_turnover_photo_storage_policies.sql +
// 20260730700000_private_photo_buckets_and_path_normalization.sql) that match
// on the FIRST path segment via public.storage_org_prefix(name).
//
// Two ways to break that, both of which shipped once already and both of which
// fail SILENTLY (a denied upload, or a 400 on a thumbnail nobody clicks):
//
//   1. Uploading to a hand-built path with no `${org_id}/` first segment.
//      The RLS predicate can't see the object, the upload is denied, and the
//      crew/PM photo evidence just never exists.
//   2. Building a `/object/public/<bucket>/…` URL (or calling getPublicUrl())
//      for a bucket that is no longer public. Those URLs 400 forever.
//
// Both are pure source-text patterns, so neither gets to recur.

// `inspection-photos` joins the list with the migration that creates it
// (20260822194607), NOT with its first writer. Its storage RLS reads the first
// path segment as the org id exactly like the other two, so the day something
// writes there the contract is already enforced — rather than the bucket
// silently denying every upload until someone notices, which is what happened
// to work-order-photos in 20260730103000.
const ORG_SCOPED_BUCKETS = ['work-order-photos', 'turnover-photos', 'inspection-photos']

const SOURCE_DIRS = ['app', 'lib', 'components']

/**
 * Files allowed to name an org-scoped bucket in a `.storage.from(...).upload()`
 * chain without calling orgScopedStoragePath() — each must build the path some
 * other way that still guarantees the org prefix, and say so.
 */
const UPLOAD_PATH_EXCEPTIONS: Record<string, string> = {
  // Public vendor-token surfaces: no session to read an org from, so the org
  // id comes from the already-loaded work_orders row and is interpolated
  // directly. Both are service-role (RLS-exempt) but still write the prefix so
  // the object stays reachable by the PM-side signed-URL reads.
  'app/api/work-orders/[token]/photos/route.ts': 'service-role; org id read from the work order, prefix asserted below',
}

function uploadsToOrgScopedBucket(src: string): boolean {
  return ORG_SCOPED_BUCKETS.some((bucket) => {
    const re = new RegExp(`\\.from\\(\\s*['"\`]${bucket}['"\`]\\s*\\)[\\s\\S]{0,400}?\\.upload\\(`)
    return re.test(src)
  })
}

describe('guardrail: org-scoped storage buckets', () => {
  it('every upload to an org-scoped photo bucket builds its path with orgScopedStoragePath()', () => {
    const offenders = collectSourceFiles(SOURCE_DIRS)
      .filter((f) => uploadsToOrgScopedBucket(read(f)))
      .map(rel)
      .filter((p) => !(p in UPLOAD_PATH_EXCEPTIONS))
      .filter((p) => !read(`${process.cwd()}/${p}`).includes('orgScopedStoragePath'))

    expect(
      offenders,
      'work-order-photos/turnover-photos storage RLS matches on the FIRST path segment being the org id ' +
      '(public.storage_org_prefix). Build the key with orgScopedStoragePath() from lib/storage/object-path.ts — ' +
      'a hand-built path is denied on upload and unsignable on read, with no error the user ever sees.'
    ).toEqual([])
  })

  it('the exempted upload sites still interpolate an org id as the first path segment', () => {
    for (const file of Object.keys(UPLOAD_PATH_EXCEPTIONS)) {
      const src = read(`${process.cwd()}/${file}`)
      const paths = [...src.matchAll(/const path\s*=\s*`([^`]*)`/g)].map((m) => m[1]!)
      expect(paths.length, `${file}: expected at least one template-literal storage path`).toBeGreaterThan(0)
      for (const p of paths) {
        expect(
          /^\$\{\s*\w+(\.\w+)*\s*\}\//.test(p),
          `${file}: storage path \`${p}\` must start with an interpolated org id segment`
        ).toBe(true)
      }
    }
  })

  it('no code builds a public-object URL (or calls getPublicUrl) for a private bucket', () => {
    const offenders: string[] = []

    for (const file of collectSourceFiles(SOURCE_DIRS)) {
      const src = read(file)
      for (const bucket of ORG_SCOPED_BUCKETS) {
        const publicUrl  = src.includes(`/object/public/${bucket}/`)
        const getPublic  = new RegExp(`\\.from\\(\\s*['"\`]${bucket}['"\`]\\s*\\)\\s*\\.getPublicUrl\\(`).test(src)
        // A comment explaining that the bucket is private is not a violation.
        const codeLines = src.split('\n').filter((l) => {
          const t = l.trimStart()
          return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
        }).join('\n')
        const inCode = codeLines.includes(`/object/public/${bucket}/`) || getPublic
        if ((publicUrl || getPublic) && inCode) offenders.push(`${rel(file)} → ${bucket}`)
      }
    }

    expect(
      offenders,
      'Both photo buckets are private — a /object/public/… URL or getPublicUrl() result 400s forever. ' +
      'Mint a short-lived signed URL server-side after an org-ownership check (see getWorkOrderPhotoUrls()), ' +
      'and normalize any stored value with toStorageObjectPath() from lib/storage/object-path.ts.'
    ).toEqual([])
  })

  it('the two buckets are actually flipped private by a migration', () => {
    const migrations = collectSourceFiles(['supabase/migrations'], ['.sql'])
      .map((f) => read(f))
      .join('\n')

    for (const bucket of ORG_SCOPED_BUCKETS) {
      expect(
        /UPDATE storage\.buckets[\s\S]{0,200}?public\s*=\s*false[\s\S]{0,200}?/.test(migrations) &&
        migrations.includes(`'${bucket}'`),
        `${bucket} must be set public = false by a migration — the RLS SELECT policies are decorative while it is public.`
      ).toBe(true)
    }
  })
})
