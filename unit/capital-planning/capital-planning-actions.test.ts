import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
  requireOrgRole:   vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

import { requireOrgMember } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { inngest } from '@/lib/inngest/client'
import {
  triggerDepreciationLedger,
  triggerCapexProjections,
  updateReplacementStatus,
} from '@/app/(dashboard)/capital-planning/actions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'eq']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from }
}

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

describe('capital-planning/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('triggerDepreciationLedger', () => {
    it('sends the depreciation-ledger event for the caller org', async () => {
      vi.mocked(requireOrgMember).mockResolvedValue({ membership } as never)

      await triggerDepreciationLedger(2026, 'org_1')

      expect(inngest.send).toHaveBeenCalledWith({
        name: 'asset/depreciation-ledger-requested',
        data: { org_id: 'org_1', tax_year: 2026 },
      })
    })

    it('is a silent no-op when the supplied orgId does not match the caller membership (tenant isolation)', async () => {
      vi.mocked(requireOrgMember).mockResolvedValue({ membership } as never)

      await triggerDepreciationLedger(2026, 'some-other-org')

      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('throws when the caller is not an authenticated org member', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      await expect(triggerDepreciationLedger(2026, 'org_1')).rejects.toThrow('REDIRECT:/login')
      expect(inngest.send).not.toHaveBeenCalled()
    })
  })

  describe('triggerCapexProjections', () => {
    it('sends the capex-projection event and logs an audit event', async () => {
      vi.mocked(requireOrgMember).mockResolvedValue({
        membership, user: { id: 'user_1' },
      } as never)

      await triggerCapexProjections()

      expect(inngest.send).toHaveBeenCalledWith({
        name: 'asset/capex-projection-requested',
        data: { org_id: 'org_1' },
      })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        orgId:  'org_1',
        action: 'asset.capex_projection.triggered',
      }))
    })

    it('throws and never sends the event when the caller is not an authenticated org member', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      await expect(triggerCapexProjections()).rejects.toThrow('REDIRECT:/login')
      expect(inngest.send).not.toHaveBeenCalled()
    })
  })

  describe('updateReplacementStatus', () => {
    it('updates the status when the asset belongs to the caller org', async () => {
      const supabase = makeSupabase({
        property_assets: [{ data: { id: 'asset_1', name: 'Water Heater', org_id: 'org_1' } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await updateReplacementStatus('asset_1', 'approved')

      expect(result).toEqual({})
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action:   'asset.replacement_status.updated',
        targetId: 'asset_1',
      }))
    })

    it('rejects an invalid status before touching the DB', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await updateReplacementStatus('asset_1', 'not-a-real-status' as any)

      expect(result).toEqual({ error: 'Invalid status' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects an asset id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ property_assets: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await updateReplacementStatus('other-orgs-asset', 'approved')

      expect(result).toEqual({ error: 'Asset not found' })
      expect(logAuditEvent).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await updateReplacementStatus('asset_1', 'approved')

      expect(result).toEqual({ error: 'Update failed' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })
})
