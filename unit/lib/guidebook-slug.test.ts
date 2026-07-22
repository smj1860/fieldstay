import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { createServiceClient } from '@/lib/supabase/server'
import {
  generateBaseSlug,
  generateUniqueSlug,
  generateUniqueSlugsForProperties,
} from '@/lib/guidebook/slug'

type Resp = { data?: unknown; error?: unknown }

// Chain supports both the single-slug .like() query and the batch .or()
// query — both resolve to { data: [...] } when awaited.
function makeSupabase(existingSlugs: string[]) {
  const calls: { method: string; args: unknown[] }[] = []
  const from = vi.fn(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'like', 'or']) {
      chain[m] = vi.fn((...args: unknown[]) => {
        calls.push({ method: m, args })
        return chain
      })
    }
    const result: Resp = { data: existingSlugs.map((slug) => ({ slug })), error: null }
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from, calls }
}

describe('generateBaseSlug', () => {
  it('lowercases and hyphenates a normal property name', () => {
    expect(generateBaseSlug('Bear Hollow Cabin #2')).toBe('bear-hollow-cabin-2')
  })

  it('collapses runs of non-alphanumeric characters into a single hyphen', () => {
    expect(generateBaseSlug('Lake   Martin -- Delivery!!')).toBe('lake-martin-delivery')
  })

  it('strips leading and trailing hyphens produced by punctuation at the edges', () => {
    expect(generateBaseSlug('--Sunset Villa--')).toBe('sunset-villa')
  })

  it('drops characters outside a-z/0-9, including unicode accents and emoji', () => {
    expect(generateBaseSlug('Café Provençal 🏡')).toBe('caf-proven-al')
  })

  it('returns an empty string for input with no alphanumeric characters', () => {
    expect(generateBaseSlug('!!!')).toBe('')
    expect(generateBaseSlug('')).toBe('')
  })

  it('caps the result at 60 characters', () => {
    const longName = 'A'.repeat(100)
    const slug = generateBaseSlug(longName)
    expect(slug.length).toBeLessThanOrEqual(60)
    expect(slug).toBe('a'.repeat(60))
  })

  it('does not leave a trailing hyphen when the 60-char cap lands mid-hyphen-run', () => {
    // 58 a's + a long non-alnum run — the cap should still land inside the
    // 'a' run here since the hyphen collapse happens before slicing.
    const name = `${'a'.repeat(58)}   long tail beyond the cap`
    const slug = generateBaseSlug(name)
    expect(slug.length).toBeLessThanOrEqual(60)
  })

  it('preserves existing numerals', () => {
    expect(generateBaseSlug('Unit 42B')).toBe('unit-42b')
  })
})

describe('generateUniqueSlug', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the base slug when it is not taken', async () => {
    const supabase = makeSupabase([])
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const slug = await generateUniqueSlug('Bear Hollow Cabin')

    expect(slug).toBe('bear-hollow-cabin')
  })

  it('appends -2 when the base slug is already taken', async () => {
    const supabase = makeSupabase(['bear-hollow-cabin'])
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const slug = await generateUniqueSlug('Bear Hollow Cabin')

    expect(slug).toBe('bear-hollow-cabin-2')
  })

  it('finds the first available numeric suffix when several are taken', async () => {
    const supabase = makeSupabase(['bear-hollow-cabin', 'bear-hollow-cabin-2', 'bear-hollow-cabin-3'])
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const slug = await generateUniqueSlug('Bear Hollow Cabin')

    expect(slug).toBe('bear-hollow-cabin-4')
  })

  it('queries with a prefix LIKE pattern scoped to the base slug', async () => {
    const supabase = makeSupabase([])
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    await generateUniqueSlug('Bear Hollow Cabin')

    expect(supabase.calls.some((c) => c.method === 'like' && c.args[1] === 'bear-hollow-cabin%')).toBe(true)
  })
})

describe('generateUniqueSlugsForProperties', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns an empty map for an empty input list', async () => {
    const supabase = makeSupabase([])
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await generateUniqueSlugsForProperties([])

    expect(result.size).toBe(0)
  })

  it('assigns the base slug to each property when nothing conflicts', async () => {
    const supabase = makeSupabase([])
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await generateUniqueSlugsForProperties([
      { id: 'p1', name: 'Bear Hollow Cabin' },
      { id: 'p2', name: 'Mountain View Lodge' },
    ])

    expect(result.get('p1')).toBe('bear-hollow-cabin')
    expect(result.get('p2')).toBe('mountain-view-lodge')
  })

  it('avoids a collision against an existing DB slug', async () => {
    const supabase = makeSupabase(['bear-hollow-cabin'])
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await generateUniqueSlugsForProperties([{ id: 'p1', name: 'Bear Hollow Cabin' }])

    expect(result.get('p1')).toBe('bear-hollow-cabin-2')
  })

  it('avoids a collision between two properties in the same batch that share a base slug', async () => {
    const supabase = makeSupabase([])
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await generateUniqueSlugsForProperties([
      { id: 'p1', name: 'Bear Hollow Cabin' },
      { id: 'p2', name: 'Bear Hollow Cabin' },
    ])

    const slugs = new Set([result.get('p1'), result.get('p2')])
    expect(slugs.size).toBe(2)
    expect(slugs.has('bear-hollow-cabin')).toBe(true)
    expect(slugs.has('bear-hollow-cabin-2')).toBe(true)
  })

  it('combines an in-batch collision with a pre-existing DB slug correctly', async () => {
    const supabase = makeSupabase(['bear-hollow-cabin', 'bear-hollow-cabin-2'])
    vi.mocked(createServiceClient).mockReturnValue(supabase as never)

    const result = await generateUniqueSlugsForProperties([
      { id: 'p1', name: 'Bear Hollow Cabin' },
      { id: 'p2', name: 'Bear Hollow Cabin' },
    ])

    const slugs = new Set([result.get('p1'), result.get('p2')])
    expect(slugs.has('bear-hollow-cabin-3')).toBe(true)
    expect(slugs.has('bear-hollow-cabin-4')).toBe(true)
  })
})
