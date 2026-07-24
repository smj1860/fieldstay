import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/sms/templates', () => ({ renderSmsBody: vi.fn(async () => 'sms body') }))
vi.mock('@/lib/assets/manual-lookup', () => ({ getManualUrlForAsset: vi.fn(async () => null) }))
vi.mock('@/lib/sms/telnyx', () => ({
  normalizePhoneToE164: vi.fn(),
  sendSMS:              vi.fn(async () => undefined),
}))
vi.mock('@/lib/rate-limit', () => ({
  signOffRatelimit: { limit: vi.fn(async () => ({ success: true })) },
}))

import { requireOrgMember } from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'
import { normalizePhoneToE164, sendSMS } from '@/lib/sms/telnyx'
import { signOffRatelimit } from '@/lib/rate-limit'
import {
  dispatchWorkOrderToVendor,
  getWorkOrderByToken,
  submitWorkOrderSignOff,
} from '@/app/actions/work-order-public'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const uploadMock = vi.fn(async () => ({ error: null }))
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'eq']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  const storage = { from: vi.fn(() => ({ upload: uploadMock })) }
  return { from, storage, uploadMock }
}

const VALID_TOKEN = 'a'.repeat(64)

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

describe('actions/work-order-public', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(signOffRatelimit.limit).mockResolvedValue({ success: true } as never)
  })

  describe('dispatchWorkOrderToVendor — authenticated PM action', () => {
    function baseWo(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        id: 'wo_1', wo_number: 'WO-1', status: 'assigned', org_id: 'org_1',
        property_id: 'prop_1', asset_id: null, title: 'Fix sink',
        description: 'leaky', nte_amount: 100, access_notes: null,
        lockbox_code: null, parking_notes: null,
        properties: { name: 'Lakeview Cabin', address: '1 Lake Rd' },
        vendors: { name: 'Ace Plumbing', email: 'vendor@example.com' },
        ...overrides,
      }
    }

    it('dispatches a work order verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: baseWo(), error: null }, { error: null }],
        profiles:    [{ data: { full_name: 'Sam Jones', phone: null } }],
        organizations: [{ data: { name: 'Lake Martin Delivery' } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await dispatchWorkOrderToVendor({
        workOrderId: 'wo_1', vendorEmail: 'vendor@example.com', vendorName: 'Ace Plumbing',
      })

      expect(result.success).toBe(true)
      expect(result.token).toMatch(/^[a-f0-9]{64}$/)
      expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({
        name: 'work-order/dispatched',
        data: expect.objectContaining({ workOrderId: 'wo_1', vendorEmail: 'vendor@example.com' }),
      }))
      expect(sendSMS).not.toHaveBeenCalled()
    })

    it('sends an SMS alongside the dispatch email when a vendor phone is provided', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: baseWo(), error: null }, { error: null }],
        profiles:    [{ data: { full_name: 'Sam Jones', phone: null } }],
        organizations: [{ data: { name: 'Lake Martin Delivery' } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)
      vi.mocked(normalizePhoneToE164).mockReturnValue('+12065551234')

      const result = await dispatchWorkOrderToVendor({
        workOrderId: 'wo_1', vendorEmail: 'vendor@example.com', vendorName: 'Ace Plumbing',
        vendorPhone: '(206) 555-1234',
      })

      expect(result.success).toBe(true)
      expect(sendSMS).toHaveBeenCalledWith('+12065551234', 'sms body')
    })

    it('rejects a work order id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ work_orders: [{ data: null, error: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await dispatchWorkOrderToVendor({
        workOrderId: 'other-orgs-wo', vendorEmail: 'vendor@example.com', vendorName: 'Ace Plumbing',
      })

      expect(result).toEqual({ error: 'Work order not found' })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('rejects dispatching a cancelled work order', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: baseWo({ status: 'cancelled' }), error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await dispatchWorkOrderToVendor({
        workOrderId: 'wo_1', vendorEmail: 'vendor@example.com', vendorName: 'Ace Plumbing',
      })

      expect(result).toEqual({ error: 'This work order has been cancelled' })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await dispatchWorkOrderToVendor({
        workOrderId: 'wo_1', vendorEmail: 'vendor@example.com', vendorName: 'Ace Plumbing',
      })

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('getWorkOrderByToken — public, token-gated', () => {
    function baseWo(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        id: 'wo_1', wo_number: 'WO-1', status: 'assigned', title: 'Fix sink',
        description: 'leaky', nte_amount: 100, access_notes: null,
        lockbox_code: null, parking_notes: null,
        public_token_expires_at: null, public_viewed_at: '2026-07-01T00:00:00.000Z',
        public_signed_off_at: null, sign_off_notes: null, vendor_dispatch_email: null,
        properties: { id: 'prop_1', name: 'Lakeview Cabin', address: '1 Lake Rd' },
        vendors: { id: 'vendor_1', name: 'Ace Plumbing' },
        organizations: { name: 'Lake Martin Delivery' },
        ...overrides,
      }
    }

    it('returns the work order for a valid, unexpired token', async () => {
      const supabase = makeSupabase({ work_orders: [{ data: baseWo(), error: null }] })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await getWorkOrderByToken(VALID_TOKEN)

      expect(result.data?.id).toBe('wo_1')
      expect(result.error).toBeUndefined()
    })

    it('rejects a malformed token before hitting the DB', async () => {
      const supabase = makeSupabase({})
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await getWorkOrderByToken('too-short')

      expect(result).toEqual({ error: 'Invalid link' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects an unrecognized token (mismatched/invalid token check)', async () => {
      const supabase = makeSupabase({ work_orders: [{ data: null, error: { message: 'not found' } }] })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await getWorkOrderByToken(VALID_TOKEN)

      expect(result).toEqual({ error: 'Work order not found or link has expired' })
    })

    it('rejects an expired token', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: baseWo({ public_token_expires_at: '2020-01-01T00:00:00.000Z' }), error: null }],
      })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await getWorkOrderByToken(VALID_TOKEN)

      expect(result).toEqual({ error: 'This work order link has expired. Contact your property manager.' })
    })
  })

  describe('submitWorkOrderSignOff — public, token-gated', () => {
    function baseWo(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        id: 'wo_1', wo_number: 'WO-1', status: 'assigned', title: 'Fix sink', org_id: 'org_1',
        public_token_expires_at: null, public_signed_off_at: null,
        vendor_dispatch_email: 'vendor@example.com',
        properties: { name: 'Lakeview Cabin', address: '1 Lake Rd' },
        organizations: { name: 'Lake Martin Delivery' },
        ...overrides,
      }
    }

    it('records a sign-off for a valid, unexpired token', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: baseWo(), error: null }, { error: null }],
      })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await submitWorkOrderSignOff(VALID_TOKEN, 'All done', undefined, 150)

      expect(result).toEqual({ success: true })
      expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({
        name: 'work-order/signed-off',
        data: expect.objectContaining({ workOrderId: 'wo_1', orgId: 'org_1' }),
      }))
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'work_order.vendor_signoff', orgId: 'org_1', targetId: 'wo_1',
      }))
    })

    it('rejects a malformed token before hitting the DB', async () => {
      const supabase = makeSupabase({})
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await submitWorkOrderSignOff('too-short', 'All done')

      expect(result).toEqual({ error: 'Invalid link' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects an unrecognized token (mismatched/invalid token check)', async () => {
      const supabase = makeSupabase({ work_orders: [{ data: null, error: { message: 'not found' } }] })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await submitWorkOrderSignOff(VALID_TOKEN, 'All done')

      expect(result).toEqual({ error: 'Work order not found' })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('rejects a sign-off already recorded (double-submit guard)', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: baseWo({ public_signed_off_at: '2026-07-01T00:00:00.000Z' }), error: null }],
      })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await submitWorkOrderSignOff(VALID_TOKEN, 'All done')

      expect(result).toEqual({ error: 'This work order has already been signed off' })
    })

    it('rejects sign-off on a cancelled work order', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: baseWo({ status: 'cancelled' }), error: null }],
      })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await submitWorkOrderSignOff(VALID_TOKEN, 'All done')

      expect(result).toEqual({ error: 'This work order has been cancelled' })
    })

    it('rejects an expired token', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: baseWo({ public_token_expires_at: '2020-01-01T00:00:00.000Z' }), error: null }],
      })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await submitWorkOrderSignOff(VALID_TOKEN, 'All done')

      expect(result).toEqual({ error: 'This work order link has expired' })
    })

    it('rejects when the per-token rate limit is exceeded', async () => {
      vi.mocked(signOffRatelimit.limit).mockResolvedValue({ success: false } as never)
      const supabase = makeSupabase({})
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await submitWorkOrderSignOff(VALID_TOKEN, 'All done')

      expect(result).toEqual({ error: 'Too many requests. Please try again in a few minutes.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects more than the maximum allowed photos', async () => {
      const supabase = makeSupabase({})
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)
      const photos = Array.from({ length: 6 }, (_, i) =>
        new File(['x'], `p${i}.jpg`, { type: 'image/jpeg' }))

      const result = await submitWorkOrderSignOff(VALID_TOKEN, 'All done', photos)

      expect(result).toEqual({ error: 'Maximum 5 photos allowed' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects an invalid actual cost before hitting the DB', async () => {
      const supabase = makeSupabase({})
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await submitWorkOrderSignOff(VALID_TOKEN, 'All done', undefined, -5)

      expect(result).toEqual({ error: 'Cost must be a valid amount' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('uploads sign-off photos and inserts work_order_photos rows', async () => {
      const supabase = makeSupabase({
        work_orders:        [{ data: baseWo(), error: null }, { error: null }],
        work_order_photos:  [{ error: null }],
      })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)
      const photos = [new File(['x'], 'p0.jpg', { type: 'image/jpeg' })]

      const result = await submitWorkOrderSignOff(VALID_TOKEN, 'All done', photos)

      expect(result).toEqual({ success: true })
      expect(supabase.storage.from).toHaveBeenCalledWith('work-order-photos')
      expect(supabase.uploadMock).toHaveBeenCalled()
    })
  })
})
