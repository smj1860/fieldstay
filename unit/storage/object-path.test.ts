import { describe, it, expect } from 'vitest'
import {
  orgScopedStoragePath,
  toStorageObjectPath,
  hasOrgPrefix,
  hasAnyOrgPrefix,
} from '@/lib/storage/object-path'

const ORG = '11111111-2222-3333-4444-555555555555'

describe('orgScopedStoragePath', () => {
  it('puts the org id first — the segment storage RLS matches on', () => {
    expect(orgScopedStoragePath(ORG, 'wo-1', 'a.jpg')).toBe(`${ORG}/wo-1/a.jpg`)
  })

  it('flattens and trims segments so a caller cannot smuggle in an empty one', () => {
    expect(orgScopedStoragePath(ORG, 'a/b', '', ' c ', 'd.jpg')).toBe(`${ORG}/a/b/c/d.jpg`)
  })

  it('refuses a non-UUID org id rather than silently writing an unreachable path', () => {
    expect(() => orgScopedStoragePath('not-an-org', 'x.jpg')).toThrow()
    expect(() => orgScopedStoragePath('', 'x.jpg')).toThrow()
  })
})

describe('toStorageObjectPath', () => {
  it('returns a bare key unchanged, including legacy non-org-prefixed keys', () => {
    expect(toStorageObjectPath('turnover-photos', `${ORG}/turnover-9/a.jpg`)).toBe(`${ORG}/turnover-9/a.jpg`)
    expect(toStorageObjectPath('work-order-photos', 'wo-9/a.jpg')).toBe('wo-9/a.jpg')
  })

  it('strips a legacy public URL back to the key', () => {
    expect(
      toStorageObjectPath('turnover-photos', `https://x.supabase.co/storage/v1/object/public/turnover-photos/${ORG}/a.jpg`)
    ).toBe(`${ORG}/a.jpg`)
  })

  it('strips a signed URL, token and all', () => {
    expect(
      toStorageObjectPath('work-order-photos', 'https://x.supabase.co/storage/v1/object/sign/work-order-photos/wo-9/a.jpg?token=abc.def')
    ).toBe('wo-9/a.jpg')
  })

  it('URL-decodes the key', () => {
    expect(
      toStorageObjectPath('turnover-photos', 'https://x.supabase.co/storage/v1/object/public/turnover-photos/a%20b/c.jpg')
    ).toBe('a b/c.jpg')
  })

  it('refuses a URL pointing at a different bucket (no cross-bucket read)', () => {
    expect(
      toStorageObjectPath('turnover-photos', 'https://x.supabase.co/storage/v1/object/public/compliance-documents/secret.pdf')
    ).toBeNull()
  })

  it('refuses a non-storage URL', () => {
    expect(toStorageObjectPath('turnover-photos', 'https://evil.example.com/turnover-photos/a.jpg')).toBeNull()
  })

  it('returns null for empty/missing values', () => {
    expect(toStorageObjectPath('turnover-photos', null)).toBeNull()
    expect(toStorageObjectPath('turnover-photos', '')).toBeNull()
    expect(toStorageObjectPath('turnover-photos', '   ')).toBeNull()
  })
})

describe('prefix predicates', () => {
  it('hasOrgPrefix only matches the caller-supplied org', () => {
    expect(hasOrgPrefix(`${ORG}/a.jpg`, ORG)).toBe(true)
    expect(hasOrgPrefix('wo-1/a.jpg', ORG)).toBe(false)
  })

  it('hasAnyOrgPrefix spots legacy keys', () => {
    expect(hasAnyOrgPrefix(`${ORG}/a.jpg`)).toBe(true)
    expect(hasAnyOrgPrefix('asset-discovery/p1/a.jpg')).toBe(false)
    expect(hasAnyOrgPrefix('turnover-1/a.jpg')).toBe(false)
  })
})
