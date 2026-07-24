import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRedirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({
  redirect:          (url: string) => mockRedirect(url),
  unstable_rethrow:  (err: unknown) => { throw err },
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient:        vi.fn(),
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}))

import { createOrganization } from '@/app/onboarding/actions'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'

function makeAuthedClient(user: { id: string; email: string; user_metadata?: Record<string, unknown> } | null) {
  return {
    auth: {
      getUser: () => Promise.resolve({ data: { user } }),
    },
  }
}

interface AdminOpts {
  slugCount?: number
  rpcResult?: { data: unknown; error: unknown }
}

function makeAdminClient({ slugCount = 0, rpcResult = { data: { org_id: 'org_1', created: true }, error: null } }: AdminOpts = {}) {
  const rpcSingle = vi.fn(() => Promise.resolve(rpcResult))
  const rpc = vi.fn((_fn: string, _args: Record<string, unknown>) => ({ single: rpcSingle }))

  const from = vi.fn(() => ({
    select: () => ({
      eq: () => Promise.resolve({ count: slugCount }),
    }),
  }))

  return { from, rpc, rpcSingle }
}

function formData(name: string): FormData {
  const fd = new FormData()
  fd.set('org_name', name)
  return fd
}

describe('onboarding/actions — createOrganization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('redirects to /login when there is no authenticated user, without creating anything', async () => {
    vi.mocked(createClient).mockResolvedValue(makeAuthedClient(null) as never)
    const admin = makeAdminClient()
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    await expect(createOrganization(null, formData('Lake Martin Delivery'))).rejects.toThrow('REDIRECT:/login')

    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('rejects a blank org name before touching the DB', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeAuthedClient({ id: 'user_1', email: 'pm@example.com' }) as never
    )
    const admin = makeAdminClient()
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const result = await createOrganization(null, formData('   '))

    expect(result).toEqual({ error: 'Organization name is required' })
    expect(admin.rpc).not.toHaveBeenCalled()
  })

  it('creates the org via the advisory-locked RPC and fires the onboarding drip on the happy path', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeAuthedClient({ id: 'user_1', email: 'pm@example.com', user_metadata: { full_name: 'Jamie Rivera' } }) as never
    )
    const admin = makeAdminClient({ rpcResult: { data: { org_id: 'org_new_1', created: true }, error: null } })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const result = await createOrganization(null, formData('Lake Martin Delivery'))

    expect(result).toEqual({ success: true })
    expect(admin.rpc).toHaveBeenCalledWith(
      'create_organization_with_owner',
      expect.objectContaining({ p_user_id: 'user_1', p_name: 'Lake Martin Delivery' })
    )
    expect(inngest.send).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'user/onboarding.drip.started',
        data: expect.objectContaining({ user_id: 'user_1', org_id: 'org_new_1', org_name: 'Lake Martin Delivery' }),
      })
    )
  })

  it('redirects to /ops without firing the drip again when the org already existed (idempotent double-submit)', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeAuthedClient({ id: 'user_1', email: 'pm@example.com' }) as never
    )
    const admin = makeAdminClient({ rpcResult: { data: { org_id: 'org_existing_1', created: false }, error: null } })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    await expect(createOrganization(null, formData('Lake Martin Delivery'))).rejects.toThrow('REDIRECT:/ops')

    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('returns a generic error and does not fire the drip when the RPC itself fails', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeAuthedClient({ id: 'user_1', email: 'pm@example.com' }) as never
    )
    const admin = makeAdminClient({ rpcResult: { data: null, error: { message: 'advisory lock timeout' } } })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    const result = await createOrganization(null, formData('Lake Martin Delivery'))

    expect(result).toEqual({ error: 'Failed to create organization. Please try again.' })
    expect(inngest.send).not.toHaveBeenCalled()
  })

  it('appends a uniqueness suffix to the slug when the base slug is already taken', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeAuthedClient({ id: 'user_1', email: 'pm@example.com' }) as never
    )
    const admin = makeAdminClient({ slugCount: 1, rpcResult: { data: { org_id: 'org_1', created: true }, error: null } })
    vi.mocked(createServiceClient).mockReturnValue(admin as never)

    await createOrganization(null, formData('Lake Martin Delivery'))

    const rpcArgs = admin.rpc.mock.calls[0][1] as { p_slug: string }
    expect(rpcArgs.p_slug).not.toBe('lake-martin-delivery')
    expect(rpcArgs.p_slug.startsWith('lake-martin-delivery-')).toBe(true)
  })
})
