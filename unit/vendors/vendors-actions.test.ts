import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
  requireOrgRole:   vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/stripe/vendor-connect-invite', () => ({
  resendVendorConnectInvite: vi.fn(),
}))

import { requireOrgRole } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { resendVendorConnectInvite as sendResendConnectInvite } from '@/lib/stripe/vendor-connect-invite'
import {
  createComplianceDocument,
  deleteComplianceDocument,
  verifyComplianceDocument,
  resendVendorConnectInvite,
} from '@/app/(dashboard)/vendors/actions'

type Resp = { data?: unknown; error?: unknown }

// Chainable Supabase mock — every builder method returns the chain itself,
// terminating in `.single()` (or `.then()` for a bare update/delete with no
// terminal call) resolving to the next queued response for that table.
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

describe('vendors/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createComplianceDocument', () => {
    function fd(fields: Record<string, string>) {
      const f = new FormData()
      for (const [k, v] of Object.entries(fields)) f.append(k, v)
      return f
    }

    it('creates a compliance document when the vendor belongs to the caller org', async () => {
      const supabase = makeSupabase({
        vendors:                       [{ data: { id: 'vendor_1' } }],
        vendor_compliance_documents:   [{ data: { id: 'doc_1' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        user: { id: 'user_1' }, supabase, membership,
      } as never)

      const result = await createComplianceDocument('vendor_1', null, fd({
        document_type: 'coi',
        document_name: 'General Liability',
      }))

      expect(result).toEqual({ success: true })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'vendor.compliance_document.created',
        orgId:  'org_1',
      }))
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await createComplianceDocument('vendor_1', null, fd({
        document_type: 'coi',
        document_name: 'General Liability',
      }))

      expect(result).toEqual({ error: 'Failed to save document' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects a vendor id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({
        vendors: [{ data: null }], // .eq('org_id', ...) filtered it out
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        user: { id: 'user_1' }, supabase, membership,
      } as never)

      const result = await createComplianceDocument('other-orgs-vendor', null, fd({
        document_type: 'coi',
        document_name: 'General Liability',
      }))

      expect(result).toEqual({ error: 'Vendor not found' })
    })

    it('requires a document type and name', async () => {
      const supabase = makeSupabase({
        vendors: [{ data: { id: 'vendor_1' } }, { data: { id: 'vendor_1' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        user: { id: 'user_1' }, supabase, membership,
      } as never)

      expect(await createComplianceDocument('vendor_1', null, fd({ document_name: 'x' })))
        .toEqual({ error: 'Document type is required' })
      expect(await createComplianceDocument('vendor_1', null, fd({ document_type: 'coi' })))
        .toEqual({ error: 'Document name is required' })
    })
  })

  describe('deleteComplianceDocument', () => {
    it('deactivates the document scoped to the caller org', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockResolvedValue({
        user: { id: 'user_1' }, supabase, membership,
      } as never)

      await deleteComplianceDocument('doc_1', 'vendor_1')

      expect(supabase.from).toHaveBeenCalledWith('vendor_compliance_documents')
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'vendor.compliance_document.deactivated',
      }))
    })

    it('throws and never touches the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      await expect(deleteComplianceDocument('doc_1', 'vendor_1')).rejects.toThrow()
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('verifyComplianceDocument', () => {
    it('marks a document verified', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockResolvedValue({
        user: { id: 'user_1' }, supabase, membership,
      } as never)

      const result = await verifyComplianceDocument('doc_1', 'vendor_1')

      expect(result).toEqual({})
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'vendor.compliance_document.verified',
      }))
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await verifyComplianceDocument('doc_1', 'vendor_1')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('resendVendorConnectInvite', () => {
    it('resends the invite when the vendor has an email and is not yet connected', async () => {
      const supabase = makeSupabase({
        vendors: [{
          data: {
            id: 'vendor_1', name: 'Acme Cleaning', email: 'acme@example.com',
            stripe_connect_charges_enabled: false, stripe_connect_token: 'tok_1',
          },
        }],
        organizations: [{ data: { name: 'Lake Martin Delivery' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await resendVendorConnectInvite('vendor_1')

      expect(result).toEqual({ success: true })
      expect(sendResendConnectInvite).toHaveBeenCalledWith(expect.objectContaining({
        vendorId: 'vendor_1',
        orgId:    'org_1',
      }))
    })

    it('rejects a vendor id that does not belong to the caller org', async () => {
      const supabase = makeSupabase({ vendors: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await resendVendorConnectInvite('other-orgs-vendor')

      expect(result).toEqual({ error: 'Vendor not found' })
      expect(sendResendConnectInvite).not.toHaveBeenCalled()
    })

    it('refuses to resend when the vendor is already connected', async () => {
      const supabase = makeSupabase({
        vendors: [{
          data: {
            id: 'vendor_1', name: 'Acme Cleaning', email: 'acme@example.com',
            stripe_connect_charges_enabled: true, stripe_connect_token: 'tok_1',
          },
        }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await resendVendorConnectInvite('vendor_1')

      expect(result).toEqual({ error: 'This vendor is already connected — no need to resend.' })
      expect(sendResendConnectInvite).not.toHaveBeenCalled()
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await resendVendorConnectInvite('vendor_1')

      expect(result).toEqual({ error: 'Failed to resend invite. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })
})
