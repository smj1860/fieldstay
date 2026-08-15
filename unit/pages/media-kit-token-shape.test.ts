import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/navigation', () => ({
  notFound: vi.fn(() => { throw new Error('NEXT_NOT_FOUND') }),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
// next/font/local is a build-time macro the bundler rewrites; imported straight
// into vitest it resolves to a stub that throws. (This mocked next/font/google
// until 2026-08-15, when the fonts were self-hosted to stop the Google fetch
// taking down production builds — the pages no longer import that module at
// all, so the old mock silently stopped covering anything and this file failed
// to load.)
vi.mock('next/font/local', () => ({
  default: () => ({ variable: 'font' }),
}))
vi.mock('@/app/g/kit/[media_kit_token]/media-kit-client', () => ({
  MediaKitClient: () => null,
}))
vi.mock('@/app/g/kit/[media_kit_token]/print/print-kit', () => ({
  PrintKit: () => null,
}))

import MediaKitPage from '@/app/g/kit/[media_kit_token]/page'
import PrintKitPage from '@/app/g/kit/[media_kit_token]/print/page'
import { createServiceClient } from '@/lib/supabase/server'
import { notFound } from 'next/navigation'

const VALID_TOKEN = '66666666-6666-4666-8666-666666666666'

/**
 * Answers 22P02 for a non-UUID compared against a `uuid` column, because that
 * is what Postgres does — it does not return zero rows. A double that quietly
 * accepts anything makes a malformed-input test pass whether the handling
 * exists or not.
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function makeSupabase() {
  const from = vi.fn(() => {
    const eqArgs: [string, unknown][] = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.eq     = vi.fn((col: string, val: unknown) => { eqArgs.push([col, val]); return chain })
    chain.maybeSingle = vi.fn(() => {
      const bad = eqArgs.find(([col, val]) =>
        (col === 'media_kit_token' || col === 'id') && !UUID_RE.test(String(val)))
      if (bad) {
        return Promise.resolve({
          data:  null,
          error: { code: '22P02', message: `invalid input syntax for type uuid: "${String(bad[1])}"` },
        })
      }
      return Promise.resolve({ data: null, error: null })
    })
    return chain
  })
  return { from }
}

const pages: [string, (a: { params: Promise<{ media_kit_token: string }> }) => Promise<unknown>][] = [
  ['media kit',       MediaKitPage as never],
  ['print media kit', PrintKitPage as never],
]

describe.each(pages)('/g/kit — %s page token shape', (_label, Page) => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(createServiceClient).mockReturnValue(makeSupabase() as never)
  })

  it('404s a malformed token instead of rendering an outage', async () => {
    // The intent already documented on these pages is that a failed READ must
    // not read as an invalid token. The inverse held just as strongly and was
    // not handled: media_kit_token is a `uuid`, so a malformed one is 22P02,
    // which unwrap() escalates into the segment error boundary — telling a
    // sponsor with a plainly bad URL that something went wrong on our side.
    await expect(
      Page({ params: Promise.resolve({ media_kit_token: 'kit-token-abc-123' }) })
    ).rejects.toThrow('NEXT_NOT_FOUND')

    expect(notFound).toHaveBeenCalled()
    // Cheap and load-bearing: no database round trip for input that could
    // never match, on a public unauthenticated surface.
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('still queries — and 404s — for a well-formed token that matches no sponsor', async () => {
    await expect(
      Page({ params: Promise.resolve({ media_kit_token: VALID_TOKEN }) })
    ).rejects.toThrow('NEXT_NOT_FOUND')

    expect(createServiceClient).toHaveBeenCalled()
  })
})
