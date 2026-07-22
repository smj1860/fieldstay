import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))
vi.mock('@/lib/integrations/vault', () => ({
  readIntegrationToken:       vi.fn(),
  disconnectIntegrationToken: vi.fn(),
}))
vi.mock('@/lib/integrations/registry', () => ({
  getProvider: vi.fn(),
}))
// Dynamically imported inside triggerResync — must still be mocked at
// module level since vi.mock hoists above the dynamic import call site.
vi.mock('@/lib/rate-limit', () => ({
  integrationResyncLimiter: { limit: vi.fn(async () => ({ success: true })) },
}))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}))

import {
  getSyncProgress,
  triggerResync,
  disconnectIntegration,
  connectWithApiKey,
} from '@/app/(dashboard)/settings/integrations/actions'
import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { readIntegrationToken, disconnectIntegrationToken } from '@/lib/integrations/vault'
import { getProvider } from '@/lib/integrations/registry'
import { integrationResyncLimiter } from '@/lib/rate-limit'
import { inngest } from '@/lib/inngest/client'

interface QueuedByTable {
  [table: string]: unknown[]
}

// See unit/settings/settings-actions.test.ts for the pattern this mirrors.
function makeSupabase(queued: QueuedByTable = {}) {
  const counters: Record<string, number> = {}
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    const record = (method: string, args: unknown[]) => {
      calls.push({ table, method, args })
      return chain
    }
    chain.select = (...a: unknown[]) => record('select', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.not    = (...a: unknown[]) => record('not', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      const result = queued[table]?.[idx] ?? { data: null, error: null }
      return Promise.resolve(result)
    }

    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

const ORG_ID  = 'org_1'
const USER_ID = 'user_1'

function membership(role: string = 'admin') {
  return {
    org_id: ORG_ID,
    role,
    org: { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
  }
}

function mockAuthed(role = 'admin') {
  vi.mocked(requireOrgMember).mockResolvedValue({
    user:       { id: USER_ID } as never,
    supabase:   {} as never,
    membership: membership(role) as never,
  })
}

describe('settings/integrations/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // vi.clearAllMocks() clears call history but not a prior
    // mockResolvedValue() override — reset explicitly so a rate-limit-denied
    // test earlier in the suite can't leak into a later happy-path test.
    vi.mocked(integrationResyncLimiter.limit).mockResolvedValue({ success: true } as never)
  })

  describe('getSyncProgress', () => {
    it('returns null when requireOrgMember rejects, without touching the DB', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))
      const supabase = makeSupabase()
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await getSyncProgress('hospitable')

      expect(result).toBeNull()
      expect(createServiceClient).not.toHaveBeenCalled()
    })

    it('scopes the connection lookup to the current user, keyed by provider_id', async () => {
      mockAuthed()
      const supabase = makeSupabase({
        integration_connections: [{
          data: { metadata: { properties_found: 4, bookings_found: 10, last_sync_status: 'ok' } },
          error: null,
        }],
      })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await getSyncProgress('hospitable')

      expect(result).toEqual({ propertiesFound: 4, bookingsFound: 10, lastSyncStatus: 'ok' })
      const eqCalls = supabase.calls.filter((c) => c.table === 'integration_connections' && c.method === 'eq')
      expect(eqCalls.some((c) => c.args[0] === 'user_id' && c.args[1] === USER_ID)).toBe(true)
      expect(eqCalls.some((c) => c.args[0] === 'provider_id' && c.args[1] === 'hospitable')).toBe(true)
    })
  })

  describe('triggerResync — role gate + tenant isolation', () => {
    it('denies a viewer-role caller before reading the connection row', async () => {
      mockAuthed('viewer')
      const supabase = makeSupabase()
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await triggerResync('hospitable')

      expect(result).toEqual({ error: 'Permission denied' })
      expect(createServiceClient).not.toHaveBeenCalled()
    })

    it('scopes the connection lookup to the caller org_id (IDOR)', async () => {
      mockAuthed('admin')
      const supabase = makeSupabase({
        integration_connections: [{ data: null, error: null }],
      })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await triggerResync('ownerrez')

      expect(result).toEqual({ error: 'This integration isn’t connected — connect it first.' })
      const eqCalls = supabase.calls.filter((c) => c.table === 'integration_connections' && c.method === 'eq')
      expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
    })

    it('rejects when the resync rate limit is exceeded, without dispatching to Inngest', async () => {
      mockAuthed('admin')
      const supabase = makeSupabase({
        integration_connections: [{ data: { user_id: USER_ID, org_id: ORG_ID, external_user_id: 'ext_1', status: 'connected' }, error: null }],
      })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)
      vi.mocked(integrationResyncLimiter.limit).mockResolvedValue({ success: false } as never)

      const result = await triggerResync('ownerrez')

      expect(result).toEqual({ error: 'Sync already in progress — please wait 60 seconds before trying again' })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('fires the ownerrez resync event scoped to the caller org on the happy path', async () => {
      mockAuthed('manager')
      const supabase = makeSupabase({
        integration_connections: [{ data: { user_id: USER_ID, org_id: ORG_ID, external_user_id: 'ext_1', status: 'connected' }, error: null }],
      })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await triggerResync('ownerrez')

      expect(result).toEqual({ success: true })
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'ownerrez/sync.now.requested',
        data: { org_id: ORG_ID, user_id: USER_ID, trigger: 'manual' },
      })
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_ID, action: 'integration.sync_triggered' })
      )
    })

    it('returns an error for an unsupported provider without touching Inngest', async () => {
      mockAuthed('admin')
      const supabase = makeSupabase({
        integration_connections: [{ data: { user_id: USER_ID, org_id: ORG_ID, external_user_id: null, status: 'connected' }, error: null }],
      })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await triggerResync('hostaway')

      expect(result).toEqual({ error: "Resync isn't supported for hostaway yet." })
      expect(inngest.send).not.toHaveBeenCalled()
    })
  })

  describe('disconnectIntegration', () => {
    it('does not touch the vault when requireOrgMember rejects', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      await expect(disconnectIntegration('hospitable')).rejects.toThrow('REDIRECT:/login')
      expect(readIntegrationToken).not.toHaveBeenCalled()
      expect(disconnectIntegrationToken).not.toHaveBeenCalled()
    })

    it('revokes at the provider and disconnects locally on the happy path', async () => {
      mockAuthed('admin')
      vi.mocked(readIntegrationToken).mockResolvedValue('access_token_abc')
      const revokeAccessToken = vi.fn(async () => undefined)
      vi.mocked(getProvider).mockReturnValue({ revokeAccessToken } as never)

      const result = await disconnectIntegration('hospitable')

      expect(result).toEqual({})
      expect(readIntegrationToken).toHaveBeenCalledWith(USER_ID, 'hospitable')
      expect(revokeAccessToken).toHaveBeenCalledWith({ token: 'access_token_abc' })
      expect(disconnectIntegrationToken).toHaveBeenCalledWith(USER_ID, 'hospitable')
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_ID, action: 'integration.disconnected', targetId: 'hospitable' })
      )
    })

    it('still disconnects locally when provider revocation throws (non-fatal)', async () => {
      mockAuthed('admin')
      vi.mocked(readIntegrationToken).mockResolvedValue('access_token_abc')
      const revokeAccessToken = vi.fn(async () => { throw new Error('provider down') })
      vi.mocked(getProvider).mockReturnValue({ revokeAccessToken } as never)

      const result = await disconnectIntegration('hospitable')

      expect(result).toEqual({})
      expect(disconnectIntegrationToken).toHaveBeenCalledWith(USER_ID, 'hospitable')
    })

    it('returns a generic error when the local disconnect itself fails', async () => {
      mockAuthed('admin')
      vi.mocked(readIntegrationToken).mockResolvedValue(null)
      vi.mocked(disconnectIntegrationToken).mockRejectedValue(new Error('vault unreachable'))

      const result = await disconnectIntegration('hospitable')

      expect(result).toEqual({ error: 'Failed to disconnect. Please try again.' })
    })
  })

  describe('connectWithApiKey', () => {
    it('requires an authenticated org member before returning', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      await expect(connectWithApiKey('hostaway', { accountId: '1', apiKey: 'k' })).rejects.toThrow('REDIRECT:/login')
    })

    it('is disabled for every provider — Hostaway credential exchange is commented out pending initial-sync support', async () => {
      mockAuthed('admin')

      const result = await connectWithApiKey('hostaway', { accountId: '1', apiKey: 'k' })

      expect(result).toEqual({ error: "hostaway isn't available to connect yet." })
    })
  })
})
