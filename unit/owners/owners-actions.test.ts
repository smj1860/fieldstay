import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/rate-limit', async () => {
  // Stubbed because the email-send actions here now go through checkLimit().
  // Without this the unit run consults the REAL Upstash instance configured in
  // the environment, which makes these tests share (and exhaust) a live
  // 20/hour budget keyed on the fixture user id — a test that fails only
  // because an earlier run of itself used up the quota.
  const { checkLimitStub, retryAfterSecondsStub } = await import('@/unit/stubs/rate-limit')
  return {
    emailSendActionLimiter: { limit: vi.fn(async () => ({ success: true })) },
    checkLimit:             checkLimitStub(),
    retryAfterSeconds:      retryAfterSecondsStub,
    upstashConfigured:      () => false,
  }
})

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
  // toggleTransactionVisibility and deleteOwnerTransaction moved to
  // requireOrgRole: owner_transactions' RLS restricts UPDATE/DELETE to
  // admin|manager, but PostgREST answers a zero-row update with SUCCESS — so a
  // viewer's call used to return {} and log an audit row for a change RLS had
  // refused. The gate now refuses in app code.
  requireOrgRole: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/resend/client', () => ({ sendOwnerPortalEmail: vi.fn() }))

import { requireOrgMember, requireOrgRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { sendOwnerPortalEmail } from '@/lib/resend/client'
import {
  addPropertyOwner,
  generatePortalToken,
  generateCombinedPortalToken,
  addOwnerTransaction,
  toggleTransactionVisibility,
  revokeOwnerPortalToken,
  deleteOwnerTransaction,
  toggleCapitalPlanSharing,
} from '@/app/(dashboard)/owners/actions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'in', 'is']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.single = vi.fn(() => Promise.resolve(result))
    // `.update(...).eq(...).select('id')` and `.delete().eq(...).select('id')`
    // resolve to the queued result too — both actions now check that a row was
    // actually affected rather than trusting a null error.
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
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

describe('owners/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('addPropertyOwner', () => {
    it('adds an owner when the property belongs to the caller org', async () => {
      const supabase = makeSupabase({
        properties:      [{ data: { id: 'prop_1' } }],
        property_owners: [{ error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await addPropertyOwner(null, fd({
        property_id: 'prop_1',
        name:        'Jane Owner',
      }))

      expect(result).toEqual({ success: true })
    })

    it('rejects a property id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await addPropertyOwner(null, fd({
        property_id: 'other-orgs-property',
        name:        'Jane Owner',
      }))

      expect(result).toEqual({ error: 'Property not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('property_owners')
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await addPropertyOwner(null, fd({ property_id: 'prop_1', name: 'Jane Owner' }))

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(reportError).toHaveBeenCalled()
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('generatePortalToken', () => {
    it('generates a token and emails the owner when found', async () => {
      const supabase = makeSupabase({
        property_owners: [
          { data: { id: 'owner_1' } },
          { data: { name: 'Jane Owner', email: 'jane@example.com', properties: { name: 'Lakehouse' }, organizations: { name: 'Lake Martin Delivery' } } },
        ],
        owner_portal_tokens: [{ error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await generatePortalToken('owner_1')

      expect(result.success).toBe(true)
      expect(result.token).toBeDefined()
      expect(sendOwnerPortalEmail).toHaveBeenCalledWith(expect.objectContaining({ toEmail: 'jane@example.com' }))
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'owner_portal.token.generated',
      }))
    })

    it('rejects an owner id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ property_owners: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await generatePortalToken('other-orgs-owner')

      expect(result).toEqual({ error: 'Owner not found' })
      expect(sendOwnerPortalEmail).not.toHaveBeenCalled()
    })

    it('still saves the token when the email send fails (non-fatal)', async () => {
      const supabase = makeSupabase({
        property_owners: [
          { data: { id: 'owner_1' } },
          { data: { name: 'Jane Owner', email: 'jane@example.com', properties: null, organizations: null } },
        ],
        owner_portal_tokens: [{ error: null }],
      })
      vi.mocked(sendOwnerPortalEmail).mockRejectedValueOnce(new Error('Resend down'))
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await generatePortalToken('owner_1')

      expect(result.success).toBe(true)
      expect(reportError).toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await generatePortalToken('owner_1')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('generateCombinedPortalToken', () => {
    it('requires at least two owner ids', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await generateCombinedPortalToken(['owner_1'])

      expect(result).toEqual({ error: 'Combined links require at least two properties' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects when an owner id does not resolve within the caller org (IDOR check)', async () => {
      // Only 1 of the 2 requested owner ids came back from the org-scoped query
      const supabase = makeSupabase({
        property_owners: [{ data: [{ id: 'owner_1', property_id: 'prop_1' }] }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await generateCombinedPortalToken(['owner_1', 'other-orgs-owner'])

      expect(result).toEqual({ error: 'Owner not found' })
    })

    it('generates a combined token across at least two properties', async () => {
      const supabase = makeSupabase({
        property_owners: [{
          data: [
            { id: 'owner_1', property_id: 'prop_1' },
            { id: 'owner_2', property_id: 'prop_2' },
          ],
        }],
        owner_portal_tokens: [{ error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await generateCombinedPortalToken(['owner_1', 'owner_2'])

      expect(result.success).toBe(true)
      expect(result.token).toBeDefined()
    })
  })

  describe('addOwnerTransaction', () => {
    function txnFd(overrides: Partial<Record<string, string>> = {}) {
      return fd({
        property_id:      'prop_1',
        transaction_type: 'expense',
        category:         'maintenance',
        amount:           '150',
        description:      'Plumbing repair',
        transaction_date: '2026-07-20',
        ...overrides,
      })
    }

    it('creates a manual owner transaction scoped to the caller org', async () => {
      const supabase = makeSupabase({
        properties:         [{ data: { id: 'prop_1' } }],
        owner_transactions: [{ data: { id: 'txn_1' } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await addOwnerTransaction(null, txnFd())

      expect(result).toEqual({ success: true })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'owner.transaction.created',
      }))
    })

    it('rejects a non-positive amount before touching the DB', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await addOwnerTransaction(null, txnFd({ amount: '0' }))

      expect(result).toEqual({ error: 'Amount must be greater than 0' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects a property id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await addOwnerTransaction(null, txnFd())

      expect(result).toEqual({ error: 'Property not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('owner_transactions')
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await addOwnerTransaction(null, txnFd())

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('toggleTransactionVisibility', () => {
    it('toggles visibility scoped to the caller org', async () => {
      const supabase = makeSupabase({ owner_transactions: [{ data: [{ id: 'txn_1' }] }] })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await toggleTransactionVisibility('txn_1', false)

      expect(result).toEqual({})
      expect(supabase.from).toHaveBeenCalledWith('owner_transactions')
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action:   'owner.transaction.visibility_changed',
        metadata: { visible: false },
      }))
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await toggleTransactionVisibility('txn_1', false)

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    // The defect: owner_transactions' RLS restricts UPDATE to admin|manager,
    // and PostgREST answers a zero-row update with SUCCESS, not an error. So a
    // viewer used to get {} back plus an audit row asserting a change that
    // never happened. Zero affected rows must never read as a change.
    it('reports not-found rather than success when no row was updated', async () => {
      const supabase = makeSupabase({ owner_transactions: [{ data: [] }] })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await toggleTransactionVisibility('txn_1', false)

      expect(result).toEqual({ error: 'That transaction could not be found.' })
      expect(logAuditEvent).not.toHaveBeenCalled()
    })

    it('is gated on admin|manager, not bare org membership', async () => {
      const supabase = makeSupabase({ owner_transactions: [{ data: [{ id: 'txn_1' }] }] })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await toggleTransactionVisibility('txn_1', true)

      expect(requireOrgRole).toHaveBeenCalledWith(['admin', 'manager'])
    })
  })

  describe('revokeOwnerPortalToken', () => {
    it('revokes the active token for an owner belonging to the caller org', async () => {
      const supabase = makeSupabase({
        property_owners:     [{ data: { id: 'owner_1' } }],
        owner_portal_tokens: [{ error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await revokeOwnerPortalToken('owner_1')

      expect(result).toEqual({ success: true })
    })

    it('rejects an owner id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ property_owners: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await revokeOwnerPortalToken('other-orgs-owner')

      expect(result).toEqual({ error: 'Owner not found' })
    })
  })

  describe('deleteOwnerTransaction', () => {
    it('deletes the transaction and logs an audit event only when a row was actually deleted', async () => {
      const supabase = makeSupabase({
        owner_transactions: [{ data: [{ id: 'txn_1' }] }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await deleteOwnerTransaction('txn_1')

      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'owner.transaction.deleted',
      }))
    })

    // Was: "does not log an audit event when ... no row deleted". Not logging
    // was right, but the action returns void, so the caller read the silent
    // no-op as a successful delete. A row vanishing from the owner's financial
    // ledger — or NOT vanishing — must not be ambiguous in either direction.
    it('throws rather than silently no-opping when no row was deleted', async () => {
      const supabase = makeSupabase({
        owner_transactions: [{ data: [] }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await expect(deleteOwnerTransaction('other-orgs-txn'))
        .rejects.toThrow('That transaction could not be found.')

      expect(logAuditEvent).not.toHaveBeenCalled()
    })

    it('throws on a delete error instead of discarding it', async () => {
      // The error used to be dropped entirely — `const { data } = await ...` —
      // so a failed delete was indistinguishable from a successful one.
      const supabase = makeSupabase({
        owner_transactions: [{ data: null, error: { message: 'deadlock detected' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await expect(deleteOwnerTransaction('txn_1'))
        .rejects.toThrow('Could not delete the transaction. Please try again.')

      expect(logAuditEvent).not.toHaveBeenCalled()
    })

    it('is gated on admin|manager, not bare org membership', async () => {
      const supabase = makeSupabase({ owner_transactions: [{ data: [{ id: 'txn_1' }] }] })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await deleteOwnerTransaction('txn_1')

      expect(requireOrgRole).toHaveBeenCalledWith(['admin', 'manager'])
    })

    it('throws and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(new Error('REDIRECT:/login'))

      await expect(deleteOwnerTransaction('txn_1')).rejects.toThrow('REDIRECT:/login')
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('toggleCapitalPlanSharing', () => {
    it('toggles sharing for an owner belonging to the caller org, omitting PII from the audit log', async () => {
      const supabase = makeSupabase({
        property_owners: [{ data: { id: 'owner_1', name: 'Jane Owner', property_id: 'prop_1' } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await toggleCapitalPlanSharing('owner_1', true)

      expect(result).toEqual({ success: true })
      const call = vi.mocked(logAuditEvent).mock.calls[0]![0] as { metadata: Record<string, unknown> }
      expect(call.metadata).not.toHaveProperty('email')
      expect(call.metadata).not.toHaveProperty('phone')
    })

    it('rejects an owner id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ property_owners: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await toggleCapitalPlanSharing('other-orgs-owner', true)

      expect(result).toEqual({ error: 'Owner not found' })
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await toggleCapitalPlanSharing('owner_1', true)

      expect(result).toEqual({ error: 'Update failed' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })
})
