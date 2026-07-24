import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))
vi.mock('@/lib/integrations/health', () => ({
  getIntegrationHealth: vi.fn(),
}))

import { GET } from '@/app/api/integrations/health/route'
import { requireOrgMember } from '@/lib/auth'
import { getIntegrationHealth } from '@/lib/integrations/health'

const ORG_ID  = 'org_1'
const USER_ID = 'user_1'

function mockAuthed() {
  vi.mocked(requireOrgMember).mockResolvedValue({
    user:       { id: USER_ID } as never,
    supabase:   {} as never,
    membership: { org_id: ORG_ID } as never,
  })
}

describe('GET /api/integrations/health', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('propagates the auth failure (e.g. redirect-to-login) instead of swallowing it', async () => {
    vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

    await expect(GET()).rejects.toThrow('REDIRECT:/login')
    expect(getIntegrationHealth).not.toHaveBeenCalled()
  })

  it('returns the health items for the caller org on the happy path', async () => {
    mockAuthed()
    const items = [
      {
        kind:       'connection' as const,
        id:         'conn_1',
        providerId: 'hospitable',
        label:      'Hospitable',
        status:     'healthy' as const,
        lastSyncAt: '2026-07-22T00:00:00.000Z',
        detail:     null,
      },
    ]
    vi.mocked(getIntegrationHealth).mockResolvedValue(items)

    const res = await GET()

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ items })
  })

  it('scopes the lookup to the caller org_id only — never a client-supplied value', async () => {
    mockAuthed()
    vi.mocked(getIntegrationHealth).mockResolvedValue([])

    await GET()

    expect(getIntegrationHealth).toHaveBeenCalledTimes(1)
    expect(getIntegrationHealth).toHaveBeenCalledWith(ORG_ID)
  })
})
