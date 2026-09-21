import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/crew-auth', () => ({ requireCrewMember: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { requireCrewMember } from '@/lib/crew-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { revalidatePath } from 'next/cache'
import { setCrewLocale } from '@/app/crew/settings/actions'

type Resp = { data?: unknown; error?: unknown }

interface Call { method: string; args: unknown[] }

function makeClient(result: Resp = { data: null, error: null }) {
  const calls: Call[] = []
  const from = vi.fn(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['update', 'eq']) {
      chain[m] = vi.fn((...args: unknown[]) => { calls.push({ method: m, args }); return chain })
    }
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { client: { from }, calls }
}

const CREW = { id: 'crew_1', org_id: 'org_1', locale: 'en' as const }

function authAs() {
  vi.mocked(requireCrewMember).mockResolvedValue({
    ok: true, supabase: {} as never, crew: CREW, user: { id: 'user_1' },
  } as never)
}

describe('setCrewLocale', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('rejects when the crew session cannot be verified', async () => {
    vi.mocked(requireCrewMember).mockResolvedValue({ ok: false, response: {} as never })

    const result = await setCrewLocale('es')

    expect(result.error).toMatch(/could not verify/i)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('writes the new locale scoped to the caller\'s own row, and revalidates', async () => {
    authAs()
    const { client, calls } = makeClient({ data: null, error: null })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await setCrewLocale('es')

    expect(result.error).toBeUndefined()
    expect(createServiceClient).toHaveBeenCalledWith({ crew: CREW })
    const updateCall = calls.find((c) => c.method === 'update')
    expect(updateCall?.args[0]).toEqual({ locale: 'es' })
    const eqCall = calls.find((c) => c.method === 'eq')
    expect(eqCall?.args).toEqual(['id', CREW.id])
    expect(revalidatePath).toHaveBeenCalledWith('/crew', 'layout')
  })

  it('surfaces a friendly error when the write fails', async () => {
    authAs()
    const { client } = makeClient({ data: null, error: { message: 'db down' } })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await setCrewLocale('es')

    expect(result.error).toMatch(/could not save/i)
  })
})
