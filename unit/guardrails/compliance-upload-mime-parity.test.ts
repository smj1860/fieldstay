import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(__dirname, '..', '..')

/**
 * The `compliance-documents` bucket enforces a MIME allowlist, and its upload
 * goes browser → Supabase Storage directly — no route handler, no proxy
 * limiter, nothing of ours in the path. The bucket is therefore the ONLY
 * enforcement point, which makes the client's content-type map load-bearing:
 *
 *   - a type the CLIENT sends that the BUCKET rejects  → the vendor's upload
 *     fails with a raw storage error and no explanation
 *   - a type the BUCKET allows that the CLIENT never sends → a file format the
 *     user is silently unable to upload at all
 *
 * Both are invisible until a vendor hits one mid-onboarding, so this pins the
 * two lists to each other. The bucket side is asserted against the migration
 * that defines it (supabase/migrations/*_compliance_documents_bucket_limits.sql),
 * which is the committed record of the live configuration.
 */
describe('guardrail: compliance upload content types match the bucket allowlist', () => {
  const component = readFileSync(
    join(ROOT, 'app/(dashboard)/vendors/[id]/compliance-section.tsx'),
    'utf8',
  )
  const migration = readFileSync(
    join(ROOT, 'supabase/migrations/20260803160000_compliance_documents_bucket_limits.sql'),
    'utf8',
  )

  function mimeTypesFrom(source: string): string[] {
    // Both files quote MIME types the same way; collecting them is enough to
    // compare the sets without parsing TS or SQL.
    return [...new Set(
      [...source.matchAll(/'((?:application|image)\/[a-z0-9.+-]+)'/g)].map((m) => m[1]!),
    )].sort()
  }

  it('the client map and the bucket allowlist contain exactly the same types', () => {
    const clientTypes = mimeTypesFrom(component)
    const bucketTypes = mimeTypesFrom(migration)

    expect(bucketTypes.length, 'migration should declare the bucket MIME list').toBeGreaterThan(0)
    expect(
      clientTypes,
      'compliance-section.tsx and the bucket migration disagree — one of them will reject uploads the other permits.',
    ).toEqual(bucketTypes)
  })

  it('the file picker derives `accept` rather than hard-coding it', () => {
    // A hand-written accept list is what drifted last time: it omitted .heic,
    // which recent iPhones produce by default.
    expect(component).toMatch(/accept=\{ACCEPTED_EXTENSIONS\.join\(','\)\}/)
    expect(component).not.toMatch(/accept="\./)
  })

  it('the upload validates content type before calling storage', () => {
    // Passing file.type straight through is the defect this replaced: browsers
    // report application/octet-stream (or nothing) for files from some
    // sources, which the bucket would then reject.
    expect(component).toMatch(/resolveContentType\(file\)/)
    expect(component).not.toMatch(/contentType:\s*file\.type/)
  })
})
