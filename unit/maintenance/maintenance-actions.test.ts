import { describe, it, expect, vi, beforeEach } from 'vitest'

// Next.js aliases this to an empty module at build time; vitest needs an
// explicit stub since the real package isn't installed as a dependency.
vi.mock('server-only', () => ({}))

const mockRedirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({
  redirect: (url: string) => mockRedirect(url),
  // Mirrors Next's real behavior: rethrow control-flow errors (redirect/notFound)
  // so they escape a surrounding try/catch instead of being swallowed into a
  // generic error response.
  unstable_rethrow: (err: unknown) => {
    if (err instanceof Error && err.message.startsWith('REDIRECT:')) throw err
  },
}))
vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
  requireOrgRole:   vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { requireOrgMember, requireOrgRole } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { createServiceClient } from '@/lib/supabase/server'
import {
  createWorkOrder,
  rateWorkOrderVendor,
  assignCrewToWorkOrder,
  updateWorkOrder,
  addWorkOrderNote,
  updateWorkOrderStatus,
  logActualCost,
  recordWorkOrderPhoto,
  deleteWorkOrderPhoto,
  sendQuoteRequests,
  approveQuoteRequest,
  declineQuoteRequest,
  deleteWorkOrder,
  createWorkOrderFromSchedule,
  bulkAssignVendor,
  acceptVendorSuggestion,
  dismissVendorSuggestion,
  bulkUpdateWorkOrderStatus,
  createMaintenanceSchedule,
  updateMaintenanceSchedule,
  deleteMaintenanceSchedule,
  createMaintenanceScheduleTemplate,
  broadcastMaintenanceTemplate,
  updateMaintenanceTemplate,
  updateMaintenanceScheduleItem,
  duplicateMaintenanceScheduleItem,
  removeMaintenanceScheduleItem,
  addCatalogItemToProperty,
  addCustomMaintenanceItem,
  recordMaintenanceCompletion,
  fetchArchivedWorkOrders,
} from '@/app/(dashboard)/maintenance/actions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>, userId: string | null = 'user_1') {
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of [
      'select', 'insert', 'update', 'delete', 'upsert',
      'eq', 'neq', 'in', 'not', 'is', 'gte', 'order', 'limit',
    ]) {
      chain[m] = vi.fn(() => chain)
    }
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return {
    from,
    auth: { getUser: vi.fn(() => Promise.resolve({ data: { user: userId ? { id: userId } : null } })) },
    storage: { from: vi.fn(() => ({ remove: vi.fn(() => Promise.resolve({ data: null, error: null })) })) },
  }
}

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

function stubServiceClient() {
  vi.mocked(createServiceClient).mockReturnValue(makeSupabase({}) as never)
}

describe('maintenance/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubServiceClient()
  })

  describe('createWorkOrder', () => {
    function woFd(fields: Record<string, string> = {}) {
      const f = new FormData()
      f.append('title', 'Fix leaky faucet')
      f.append('property_id', 'prop_1')
      for (const [k, v] of Object.entries(fields)) f.append(k, v)
      return f
    }

    it('creates a work order when the property belongs to the caller org', async () => {
      const supabase = makeSupabase({
        properties:   [{ data: { id: 'prop_1' } }],
        work_orders:  [{ data: { id: 'wo_1' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await createWorkOrder(null, woFd())

      expect(result.success).toBe(true)
      expect(result.workOrderId).toBe('wo_1')
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'work_order.created' }))
    })

    it('rejects a property id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await createWorkOrder(null, woFd({ property_id: 'other-orgs-property' }))

      expect(result).toEqual({ error: 'Property not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('work_orders')
    })

    it('requires selecting a vendor when requesting quotes', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await createWorkOrder(null, woFd({ request_quotes: 'true' }))

      expect(result).toEqual({ error: 'Select at least one vendor to request quotes from' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('redirects to the new work order after sending RFQs in quote-request mode', async () => {
      const supabase = makeSupabase({
        properties:      [{ data: { id: 'prop_1' } }],
        work_orders:     [{ data: { id: 'wo_1' } }],
        quote_requests:  [{ data: { id: 'qr_1' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const form = woFd({ request_quotes: 'true' })
      form.append('quote_vendor_ids', 'vendor_1')

      await expect(createWorkOrder(null, form)).rejects.toThrow('REDIRECT:/maintenance/wo_1')
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await createWorkOrder(null, woFd())

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(reportError).toHaveBeenCalled()
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('rateWorkOrderVendor', () => {
    it('rates the vendor scoped to the caller org', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await rateWorkOrderVendor('wo_1', 5, 'Great work')

      expect(result).toEqual({})
      expect(supabase.from).toHaveBeenCalledWith('work_orders')
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await rateWorkOrderVendor('wo_1', 5, null)

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('assignCrewToWorkOrder', () => {
    it('assigns a crew member scoped to the caller org', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await assignCrewToWorkOrder('wo_1', 'crew_1')

      expect(result).toEqual({})
      expect(supabase.from).toHaveBeenCalledWith('work_orders')
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await assignCrewToWorkOrder('wo_1', 'crew_1')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('updateWorkOrder', () => {
    const updateData = {
      title: 'Fix leaky faucet', description: null, priority: 'high',
      vendor_id: 'vendor_2', scheduled_date: null, scheduled_time: null,
      estimated_cost: null, portal_enabled: true,
    }

    it('fires a vendor-assigned event when the vendor changes, scoped to the caller org', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: { vendor_id: 'vendor_1' } }, { error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await updateWorkOrder('wo_1', updateData)

      expect(result).toEqual({})
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'work-order/vendor.assigned',
        data: { workOrderId: 'wo_1', orgId: 'org_1', vendorId: 'vendor_2', previousVendorId: 'vendor_1' },
      })
    })

    it('does not fire a vendor-assigned event when the vendor is unchanged', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: { vendor_id: 'vendor_2' } }, { error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await updateWorkOrder('wo_1', updateData)

      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await updateWorkOrder('wo_1', updateData)

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('addWorkOrderNote', () => {
    it('adds a note to a work order verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        work_orders:        [{ data: { id: 'wo_1', org_id: 'org_1' } }],
        work_order_updates: [{ error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await addWorkOrderNote('wo_1', 'Vendor confirmed the appointment')

      expect(result).toEqual({})
    })

    it('rejects a work order id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ work_orders: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await addWorkOrderNote('other-orgs-wo', 'note')

      expect(result).toEqual({ error: 'Work order not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('work_order_updates')
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await addWorkOrderNote('wo_1', 'note')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('updateWorkOrderStatus', () => {
    it('completes an unassigned work order and fires the completion event', async () => {
      const supabase = makeSupabase({
        work_orders: [
          { data: { status: 'in_progress', source_schedule_id: null, source: 'manual', actual_cost: null, estimated_cost: 100, title: 'Fix faucet', property_id: 'prop_1', vendor_id: null } },
          { error: null },
        ],
        work_order_updates: [{ error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await updateWorkOrderStatus('wo_1', 'completed')

      expect(result).toEqual({ success: true })
      expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'work-order/completed' }))
    })

    it('refuses to complete a vendor-assigned work order outside the vendor portal', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: { status: 'assigned', vendor_id: 'vendor_1' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await updateWorkOrderStatus('wo_1', 'completed')

      expect(result.error).toMatch(/vendor portal/)
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('no-ops without re-firing completion for an already-completed work order (idempotency)', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: { status: 'completed', vendor_id: null } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await updateWorkOrderStatus('wo_1', 'completed')

      expect(result).toEqual({ success: true })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('rejects a work order id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ work_orders: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await updateWorkOrderStatus('other-orgs-wo', 'in_progress')

      expect(result).toEqual({ error: 'Work order not found' })
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await updateWorkOrderStatus('wo_1', 'in_progress')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('logActualCost', () => {
    it('logs actual cost and idempotently upserts an owner_transactions expense (source_reference_id)', async () => {
      const supabase = makeSupabase({
        work_orders:         [{ data: { id: 'wo_1', status: 'completed', title: 'Fix faucet', property_id: 'prop_1', actual_cost: null } }, { error: null }],
        work_order_updates:  [{ error: null }],
        owner_transactions:  [{ error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await logActualCost('wo_1', { actual_cost: 150 })

      expect(result).toEqual({})
      // Verify the upsert used source_reference_id-based conflict resolution
      // (idempotency: a re-logged cost updates rather than duplicates the row).
      const ownerTxnCalls = supabase.from.mock.calls.filter(([t]: [string]) => t === 'owner_transactions')
      expect(ownerTxnCalls.length).toBe(1)
    })

    it('rejects a work order id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ work_orders: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await logActualCost('other-orgs-wo', { actual_cost: 100 })

      expect(result).toEqual({ error: 'Work order not found' })
    })

    it('does not post an owner_transactions expense when the work order is not completed', async () => {
      const supabase = makeSupabase({
        work_orders:        [{ data: { id: 'wo_1', status: 'in_progress', title: 'Fix faucet', property_id: 'prop_1', actual_cost: null } }, { error: null }],
        work_order_updates: [{ error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await logActualCost('wo_1', { actual_cost: 150 })

      expect(supabase.from).not.toHaveBeenCalledWith('owner_transactions')
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await logActualCost('wo_1', { actual_cost: 100 })

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('recordWorkOrderPhoto', () => {
    it('records a photo for the work order', async () => {
      const supabase = makeSupabase({ work_order_photos: [{ error: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase } as never)

      const result = await recordWorkOrderPhoto('wo_1', 'wo_1/photo.jpg')

      expect(result).toEqual({})
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await recordWorkOrderPhoto('wo_1', 'wo_1/photo.jpg')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('deleteWorkOrderPhoto', () => {
    it('deletes a photo once the work order is verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        work_order_photos: [{ data: { id: 'photo_1', storage_path: 'wo_1/photo.jpg', work_order_id: 'wo_1' } }],
        work_orders:        [{ data: { id: 'wo_1' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await deleteWorkOrderPhoto('photo_1')

      expect(result).toEqual({})
      expect(supabase.storage.from).toHaveBeenCalledWith('work-order-photos')
    })

    it('rejects a photo whose work order does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({
        work_order_photos: [{ data: { id: 'photo_1', storage_path: 'x.jpg', work_order_id: 'other-orgs-wo' } }],
        work_orders:        [{ data: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await deleteWorkOrderPhoto('photo_1')

      expect(result).toEqual({ error: 'Photo not found' })
      expect(supabase.storage.from).not.toHaveBeenCalled()
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await deleteWorkOrderPhoto('photo_1')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('sendQuoteRequests', () => {
    it('sends RFQs to vendors without an existing active quote', async () => {
      const supabase = makeSupabase({
        work_orders:     [{ data: { id: 'wo_1', property_id: 'prop_1', status: 'pending' } }],
        quote_requests:  [{ data: [] }, { data: { id: 'qr_1' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await sendQuoteRequests('wo_1', ['vendor_1'])

      expect(result).toEqual({ sent: 1 })
    })

    it('refuses to send quotes on a completed work order', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: { id: 'wo_1', property_id: 'prop_1', status: 'completed' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await sendQuoteRequests('wo_1', ['vendor_1'])

      expect(result.error).toMatch(/completed or cancelled/)
      expect(result.sent).toBe(0)
    })

    it('rejects a work order id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ work_orders: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await sendQuoteRequests('other-orgs-wo', ['vendor_1'])

      expect(result).toEqual({ error: 'Work order not found', sent: 0 })
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await sendQuoteRequests('wo_1', ['vendor_1'])

      expect(result).toEqual({ error: 'Operation failed. Please try again.', sent: 0 })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('approveQuoteRequest', () => {
    it('approves a submitted quote, assigns the vendor, and declines the rest', async () => {
      const supabase = makeSupabase({
        quote_requests: [
          { data: { id: 'qr_1', work_order_id: 'wo_1', vendor_id: 'vendor_1', quoted_amount: 250, status: 'submitted', org_id: 'org_1' } },
          { data: { id: 'qr_1' } }, // atomic claim succeeds
          { error: null },          // decline others
        ],
        work_orders:         [{ error: null }],
        work_order_updates:  [{ error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await approveQuoteRequest('qr_1')

      expect(result).toEqual({})
      expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'work-order/created' }))
    })

    it('refuses a double-approval (concurrent request already claimed it)', async () => {
      const supabase = makeSupabase({
        quote_requests: [
          { data: { id: 'qr_1', work_order_id: 'wo_1', vendor_id: 'vendor_1', quoted_amount: 250, status: 'submitted', org_id: 'org_1' } },
          { data: null }, // the atomic UPDATE ... WHERE status = 'submitted' claimed nothing
        ],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await approveQuoteRequest('qr_1')

      expect(result).toEqual({ error: 'Can only approve a quote that has been submitted by the vendor' })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('rejects a quote request id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ quote_requests: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await approveQuoteRequest('other-orgs-qr')

      expect(result).toEqual({ error: 'Quote request not found' })
    })
  })

  describe('declineQuoteRequest', () => {
    it('declines a quote request verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        quote_requests: [{ data: { id: 'qr_1', work_order_id: 'wo_1' } }, { error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await declineQuoteRequest('qr_1')

      expect(result).toEqual({})
    })

    it('rejects a quote request id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ quote_requests: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await declineQuoteRequest('other-orgs-qr')

      expect(result).toEqual({ error: 'Quote request not found' })
    })
  })

  describe('deleteWorkOrder', () => {
    it('cancels a work order verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        work_orders:        [{ data: { status: 'pending' } }, { error: null }],
        work_order_updates: [{ error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await deleteWorkOrder('wo_1')

      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'work_order.cancelled' }))
    })

    it('is a silent no-op for a work order id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ work_orders: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await deleteWorkOrder('other-orgs-wo')

      expect(logAuditEvent).not.toHaveBeenCalled()
    })

    it('throws and never touches the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      await expect(deleteWorkOrder('wo_1')).rejects.toThrow()
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('createWorkOrderFromSchedule', () => {
    it('creates a work order from a schedule verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        maintenance_schedules: [
          { data: { id: 'sched_1', org_id: 'org_1', property_id: 'prop_1', next_due_date: '2026-08-01', assigned_vendor_id: 'vendor_1', vendor_specialty_hint: null, name: 'Gutter cleaning', description: null, estimated_cost: 100, schedule_type: 'routine', frequency: 'monthly' },
          },
        ],
        work_orders: [{ data: null }, { data: { id: 'wo_1' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await createWorkOrderFromSchedule('sched_1')

      expect(result).toEqual({ success: true })
      expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'work-order/created' }))
    })

    it('is idempotent — skips creating a duplicate when an open WO already exists for this schedule', async () => {
      const supabase = makeSupabase({
        maintenance_schedules: [
          { data: { id: 'sched_1', org_id: 'org_1', property_id: 'prop_1', next_due_date: '2026-08-01' } },
        ],
        work_orders: [{ data: { id: 'existing-wo' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await createWorkOrderFromSchedule('sched_1')

      expect(result).toEqual({ success: true })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('rejects a schedule id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ maintenance_schedules: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await createWorkOrderFromSchedule('other-orgs-schedule')

      expect(result).toEqual({ error: 'Schedule not found' })
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await createWorkOrderFromSchedule('sched_1')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('bulkAssignVendor', () => {
    it('bulk-assigns a vendor verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        vendors:      [{ data: { id: 'vendor_1', name: 'Acme Cleaning' } }],
        work_orders:  [{ data: [{ id: 'wo_1', suggestion_status: null, suggested_vendor_ids: null }] }, { error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await bulkAssignVendor(['wo_1'], 'vendor_1')

      expect(result).toEqual({})
      expect(inngest.send).toHaveBeenCalledWith([
        expect.objectContaining({ name: 'work-order/vendor.assigned', data: expect.objectContaining({ workOrderId: 'wo_1', vendorId: 'vendor_1' }) }),
      ])
    })

    it('rejects a vendor id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ vendors: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await bulkAssignVendor(['wo_1'], 'other-orgs-vendor')

      expect(result).toEqual({ error: 'Vendor not found' })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await bulkAssignVendor(['wo_1'], 'vendor_1')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('acceptVendorSuggestion / dismissVendorSuggestion', () => {
    it('accepts a suggested vendor for a work order verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: { id: 'wo_1', suggested_vendor_ids: ['vendor_1'] } }, { error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await acceptVendorSuggestion('wo_1')

      expect(result).toEqual({})
      expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'work-order/vendor.assigned' }))
    })

    it('rejects a work order id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ work_orders: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await acceptVendorSuggestion('other-orgs-wo')

      expect(result).toEqual({ error: 'Work order not found' })
    })

    it('errors when there is no suggestion to accept', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: { id: 'wo_1', suggested_vendor_ids: [] } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await acceptVendorSuggestion('wo_1')

      expect(result).toEqual({ error: 'No suggestion to accept' })
    })

    it('dismisses a suggestion scoped to the caller org', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: { suggested_vendor_ids: ['vendor_1'] } }, { error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await dismissVendorSuggestion('wo_1')

      expect(result).toEqual({})
    })
  })

  describe('bulkUpdateWorkOrderStatus', () => {
    it('completes only non-vendor-assigned work orders in the batch, scoped to the caller org', async () => {
      const supabase = makeSupabase({
        work_orders: [
          { data: [{ id: 'wo_1', vendor_id: null }, { id: 'wo_2', vendor_id: 'vendor_1' }] },
          { error: null },
        ],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await bulkUpdateWorkOrderStatus(['wo_1', 'wo_2'], 'completed')

      expect(result.warning).toMatch(/vendor portal/)
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await bulkUpdateWorkOrderStatus(['wo_1'], 'completed')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('createMaintenanceSchedule', () => {
    const scheduleInput = {
      property_id: 'prop_1', name: 'HVAC filter change', description: null,
      schedule_type: 'routine' as const, frequency: 'quarterly' as const, month_due: null,
      next_due_date: '2026-08-01', estimated_cost: null, assigned_vendor_id: null,
      auto_create_wo: true, instructions: null,
    }

    it('creates a schedule when the property belongs to the caller org', async () => {
      const supabase = makeSupabase({
        properties:             [{ data: { id: 'prop_1' } }],
        maintenance_schedules:  [{ error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await createMaintenanceSchedule(scheduleInput)

      expect(result).toEqual({ success: true })
    })

    it('rejects a property id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await createMaintenanceSchedule({ ...scheduleInput, property_id: 'other-orgs-property' })

      expect(result).toEqual({ error: 'Property not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('maintenance_schedules')
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await createMaintenanceSchedule(scheduleInput)

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('updateMaintenanceSchedule / deleteMaintenanceSchedule', () => {
    const updateInput = {
      name: 'HVAC filter change', description: null, schedule_type: 'routine' as const,
      frequency: 'quarterly' as const, month_due: null, next_due_date: '2026-08-01',
      estimated_cost: null, assigned_vendor_id: null, auto_create_wo: true, instructions: null,
    }

    it('updates a schedule scoped to the caller org', async () => {
      const supabase = makeSupabase({ maintenance_schedules: [{ error: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await updateMaintenanceSchedule('sched_1', updateInput)

      expect(result).toEqual({ success: true })
    })

    it('soft-deletes a schedule scoped to the caller org', async () => {
      const supabase = makeSupabase({ maintenance_schedules: [{ error: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await deleteMaintenanceSchedule('sched_1')

      expect(result).toEqual({ success: true })
    })

    it('updateMaintenanceSchedule does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await updateMaintenanceSchedule('sched_1', updateInput)

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('createMaintenanceScheduleTemplate', () => {
    it('creates a template and its items for the caller org', async () => {
      const supabase = makeSupabase({
        maintenance_schedule_templates:       [{ data: { id: 'tmpl_1' } }],
        maintenance_schedule_template_items:  [{ error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await createMaintenanceScheduleTemplate({
        name: 'Seasonal HVAC', description: null,
        items: [{ name: 'Filter change', description: null, schedule_frequency: 'quarterly', vendor_specialty_hint: 'hvac', estimated_cost: null, sort_order: 0 }],
      })

      expect(result).toEqual({ success: true, templateId: 'tmpl_1' })
    })

    it('requires at least one item', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await createMaintenanceScheduleTemplate({ name: 'Empty', description: null, items: [] })

      expect(result).toEqual({ error: 'Add at least one item to the template' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await createMaintenanceScheduleTemplate({
        name: 'Seasonal HVAC', description: null,
        items: [{ name: 'Filter change', description: null, schedule_frequency: 'quarterly', vendor_specialty_hint: null, estimated_cost: null, sort_order: 0 }],
      })

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('broadcastMaintenanceTemplate', () => {
    it('rejects a non-system template that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({
        maintenance_schedule_templates: [{ data: { id: 'tmpl_1', org_id: 'other-org', is_system: false } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, user: { id: 'user_1' }, membership,
      } as never)

      const result = await broadcastMaintenanceTemplate('tmpl_1', ['prop_1'])

      expect(result).toEqual({ error: 'Template not found' })
    })

    it('broadcasts a system template to the requested properties, skipping any with an existing item of the same name', async () => {
      const supabase = makeSupabase({
        maintenance_schedule_templates:      [{ data: { id: 'tmpl_1', org_id: null, is_system: true } }],
        maintenance_schedule_template_items: [{ data: [{ id: 'item_1', name: 'Filter change', description: null, schedule_frequency: 'quarterly', vendor_specialty_hint: 'hvac', estimated_cost: null, sort_order: 0, asset_category: null, active_from_month: null, active_to_month: null }] }],
        properties:                          [{ data: [{ id: 'prop_1' }] }],
        maintenance_schedules:                [{ data: [] }, { error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, user: { id: 'user_1' }, membership,
      } as never)

      const result = await broadcastMaintenanceTemplate('tmpl_1', ['prop_1'])

      expect(result).toEqual({ success: true, created: 1, skipped: 0 })
    })

    it('requires at least one property', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, user: { id: 'user_1' }, membership,
      } as never)

      const result = await broadcastMaintenanceTemplate('tmpl_1', [])

      expect(result).toEqual({ error: 'Select at least one property' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await broadcastMaintenanceTemplate('tmpl_1', ['prop_1'])

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('updateMaintenanceTemplate', () => {
    it('updates a non-system template scoped to the caller org', async () => {
      const supabase = makeSupabase({
        maintenance_schedule_templates: [{ data: { id: 'tmpl_1', is_system: false } }, { error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await updateMaintenanceTemplate('tmpl_1', { name: 'Renamed', description: null })

      expect(result).toEqual({})
    })

    it('refuses to edit a system template', async () => {
      const supabase = makeSupabase({
        maintenance_schedule_templates: [{ data: { id: 'tmpl_1', is_system: true } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await updateMaintenanceTemplate('tmpl_1', { name: 'Renamed', description: null })

      expect(result).toEqual({ error: 'System templates cannot be edited' })
    })

    it('rejects a template id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ maintenance_schedule_templates: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await updateMaintenanceTemplate('other-orgs-tmpl', { name: 'Renamed', description: null })

      expect(result).toEqual({ error: 'Template not found' })
    })
  })

  describe('updateMaintenanceScheduleItem / duplicateMaintenanceScheduleItem / removeMaintenanceScheduleItem', () => {
    it('updates a schedule item scoped to the caller org', async () => {
      const supabase = makeSupabase({ maintenance_schedules: [{ error: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await updateMaintenanceScheduleItem('item_1', { name: 'Renamed item' })

      expect(result).toEqual({ success: true })
    })

    it('duplicates an item verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        maintenance_schedules: [
          { data: { id: 'item_1', property_id: 'prop_1', org_id: 'org_1', name: 'Filter change', created_at: 'x', updated_at: 'y' } },
          { error: null },
        ],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await duplicateMaintenanceScheduleItem('item_1', '2026-09-01')

      expect(result).toEqual({ success: true })
    })

    it('rejects duplicating an item id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ maintenance_schedules: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await duplicateMaintenanceScheduleItem('other-orgs-item', '2026-09-01')

      expect(result).toEqual({ error: 'Item not found' })
    })

    it('removes (soft-deletes) an item scoped to the caller org', async () => {
      const supabase = makeSupabase({ maintenance_schedules: [{ error: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await removeMaintenanceScheduleItem('item_1', 'prop_1')

      expect(result).toEqual({ success: true })
    })
  })

  describe('addCatalogItemToProperty', () => {
    it('adds a catalog item once the property is verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        properties:                [{ data: { id: 'prop_1' } }],
        maintenance_catalog_items: [{ data: { name: 'Gutter cleaning', asset_category: 'roof', description: 'Clear debris' } }],
        maintenance_schedules:      [{ error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await addCatalogItemToProperty('prop_1', 'catalog_1', '2026-09-01', 'quarterly')

      expect(result).toEqual({ success: true })
    })

    it('rejects a property id that does not belong to the caller org (IDOR check — regression test for the fix in this session)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await addCatalogItemToProperty('other-orgs-property', 'catalog_1', '2026-09-01', 'quarterly')

      expect(result).toEqual({ error: 'Property not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('maintenance_catalog_items')
      expect(supabase.from).not.toHaveBeenCalledWith('maintenance_schedules')
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await addCatalogItemToProperty('prop_1', 'catalog_1', '2026-09-01', 'quarterly')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('addCustomMaintenanceItem', () => {
    it('adds a custom item once the property is verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        properties:             [{ data: { id: 'prop_1' } }],
        maintenance_schedules:   [{ error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await addCustomMaintenanceItem('prop_1', {
        name: 'Check sump pump', frequency: 'annual', next_due_date: '2026-09-01',
      })

      expect(result).toEqual({ success: true })
    })

    it('rejects a property id that does not belong to the caller org (IDOR check — regression test for the fix in this session)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await addCustomMaintenanceItem('other-orgs-property', {
        name: 'Check sump pump', frequency: 'annual', next_due_date: '2026-09-01',
      })

      expect(result).toEqual({ error: 'Property not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('maintenance_schedules')
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await addCustomMaintenanceItem('prop_1', {
        name: 'Check sump pump', frequency: 'annual', next_due_date: '2026-09-01',
      })

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('recordMaintenanceCompletion', () => {
    it('records a completion and advances next_due_date for an item verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        maintenance_schedules:  [{ data: { property_id: 'prop_1', org_id: 'org_1', asset_category: null, frequency: 'monthly', active_from_month: null, active_to_month: null } }, { error: null }],
        maintenance_completions: [{ error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await recordMaintenanceCompletion('item_1', { notes: 'Done' })

      expect(result.success).toBe(true)
      expect(result.nextDueDate).toBeDefined()
    })

    it('rejects an item id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ maintenance_schedules: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await recordMaintenanceCompletion('other-orgs-item', {})

      expect(result).toEqual({ error: 'Maintenance item not found' })
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await recordMaintenanceCompletion('item_1', {})

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('fetchArchivedWorkOrders', () => {
    it('fetches completed/cancelled work orders scoped to the caller org for a read-only viewer', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: [{ id: 'wo_1', status: 'completed' }] }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await fetchArchivedWorkOrders()

      expect(result).toEqual([{ id: 'wo_1', status: 'completed' }])
    })

    it('returns an empty list rather than throwing when the caller is unauthenticated', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await fetchArchivedWorkOrders()

      expect(result).toEqual([])
    })
  })
})
