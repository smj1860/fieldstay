import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))

import { requireOrgMember } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { createCommunicationLog, deleteCommunicationLog } from '@/app/(dashboard)/comms-log/actions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'eq', 'is']) {
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

function fd(fields: Record<string, string>) {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.append(k, v)
  return f
}

describe('comms-log/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createCommunicationLog', () => {
    it('creates a log entry scoped to the caller org', async () => {
      const supabase = makeSupabase({
        communication_logs: [{ data: { id: 'log_1' } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await createCommunicationLog(null, fd({
        recipient_type: 'vendor',
        vendor_id:      'vendor_1',
        body:           'Confirmed the appointment',
      }))

      expect(result).toEqual({ success: true })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        orgId:  'org_1',
        action: 'comms.log.created',
      }))
    })

    it('rejects when recipient type is vendor but no vendor is selected', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await createCommunicationLog(null, fd({
        recipient_type: 'vendor',
        body:           'hello',
      }))

      expect(result).toEqual({ error: 'Select a vendor' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects when there is no subject or body', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await createCommunicationLog(null, fd({
        recipient_type: 'crew',
        crew_member_id: 'crew_1',
      }))

      expect(result).toEqual({ error: 'Add a subject or message body' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await createCommunicationLog(null, fd({
        recipient_type: 'vendor',
        vendor_id:      'vendor_1',
        body:           'hello',
      }))

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('deleteCommunicationLog', () => {
    it('scopes the delete to the caller org and soft-delete filter', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await deleteCommunicationLog('log_1')

      expect(result).toEqual({})
      expect(supabase.from).toHaveBeenCalledWith('communication_logs')
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action:   'comms.log.deleted',
        targetId: 'log_1',
      }))
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await deleteCommunicationLog('log_1')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })
})
