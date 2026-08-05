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
vi.mock('@/lib/rate-limit', async () => {
  // checkLimit() is now the only sanctioned way to consult a limiter
  // (lib/rate-limit.ts). The stub delegates to the limiter doubles below
  // so existing `.limit` assertions and fail-policy tests still apply.
  const { checkLimitStub, retryAfterSecondsStub } = await import('@/unit/stubs/rate-limit')
  return {
    // dispatchWorkOrderToVendor consults this before sending; without it here
    // the import resolves to undefined and the stub throws inside the action's
    // try/catch, which surfaces as the generic error rather than the real one.
    emailSendActionLimiter: { limit: vi.fn(async () => ({ success: true })) },
    checkLimit:         checkLimitStub(),
    retryAfterSeconds:  retryAfterSecondsStub,
  }
})

import { requireOrgMember } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'
import { normalizePhoneToE164, sendSMS } from '@/lib/sms/telnyx'
import { dispatchWorkOrderToVendor } from '@/app/actions/work-order-public'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  // args captured for path assertions
  const uploadMock = vi.fn(async (_path: string, _file: unknown, _opts?: unknown) => ({ error: null }))
  // Every .update() payload, in order, tagged with its table. This mock cannot
  // type-check a column — which is how a 64-char hex written to a `uuid`
  // column passed every test in this file while failing 22P02 in production —
  // so the payloads have to be asserted explicitly instead.
  const updates: Array<{ table: string; payload: Record<string, unknown> }> = []
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'eq', 'is', 'ilike', 'limit']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.update = vi.fn((payload: Record<string, unknown>) => {
      updates.push({ table, payload })
      return chain
    })
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  const storage = { from: vi.fn(() => ({ upload: uploadMock })) }
  return { from, storage, uploadMock, updates }
}

/** work_orders.completion_token is `uuid` — anything else takes a 22P02. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

describe('actions/work-order-public', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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
        vendors:     [{ data: { id: 'ven_1', name: 'Ace Plumbing', email: 'vendor@example.com', phone: null }, error: null }],
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
      // Was /^[a-f0-9]{64}$/ — this assertion PINNED the bug. completion_token
      // is a `uuid` column, so the 64-char hex it demanded could never be
      // stored; every dispatch failed with 22P02 while this test stayed green.
      expect(result.token).toMatch(UUID_RE)
      expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({
        name: 'work-order/dispatched',
        data: expect.objectContaining({ workOrderId: 'wo_1', vendorEmail: 'vendor@example.com' }),
      }))
      expect(sendSMS).not.toHaveBeenCalled()
    })

    it('writes a UUID token and opens the portal the emailed link points at', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: baseWo(), error: null }, { error: null }],
        vendors:     [{ data: { id: 'ven_1', name: 'Ace Plumbing', email: 'vendor@example.com', phone: null }, error: null }],
        profiles:    [{ data: { full_name: 'Sam Jones', phone: null } }],
        organizations: [{ data: { name: 'Lake Martin Delivery' } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await dispatchWorkOrderToVendor({
        workOrderId: 'wo_1', vendorEmail: 'vendor@example.com', vendorName: 'Ace Plumbing',
      })

      const dispatch = supabase.updates.find((u) => u.table === 'work_orders')
      expect(dispatch).toBeDefined()

      // The column is `uuid`. A hex string of any other length is not a
      // "formatting" difference — Postgres rejects the whole UPDATE.
      expect(dispatch!.payload.completion_token).toMatch(UUID_RE)
      expect(dispatch!.payload.completion_token).toBe(result.token)

      // app/work-orders/[token]/page.tsx filters .eq('portal_enabled', true).
      // Without this the token is valid and the page still renders notFound(),
      // which is indistinguishable to the vendor from a dead link.
      expect(dispatch!.payload.portal_enabled).toBe(true)

      // The emailed link must address the portal that reads completion_token,
      // not the unreachable /wo/[token] one keyed on public_token.
      expect(result.publicUrl).toContain(`/work-orders/${result.token}`)
    })

    it('does not let a LIKE wildcard select an arbitrary vendor to dispatch to', async () => {
      // '%' matched EVERY vendor in the org and .limit(1) then picked one, so
      // the email, the SMS and the portal token went to a vendor the PM never
      // named while the UI reported the address they typed. The escape is the
      // real fix; the equality re-check below it is what makes a failure a
      // refused dispatch rather than a misdirected one.
      const supabase = makeSupabase({
        work_orders: [{ data: baseWo(), error: null }, { error: null }],
        vendors:     [{ data: { id: 'ven_1', name: 'Ace Plumbing', email: 'vendor@example.com', phone: null }, error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await dispatchWorkOrderToVendor({
        workOrderId: 'wo_1', vendorEmail: '%', vendorName: 'Whoever',
      })

      expect(result.error).toBe('That vendor is not in your address book, or has no email on file.')
      expect(inngest.send).not.toHaveBeenCalled()
      expect(sendSMS).not.toHaveBeenCalled()
    })

    it('escapes LIKE metacharacters so a real address containing "_" matches only itself', async () => {
      // Underscores are legal and common in email local parts, and unescaped
      // they match any single character — confirmed against Postgres, where
      // the unescaped pattern matched both first_last@ and firstXlast@.
      const supabase = makeSupabase({
        work_orders: [{ data: baseWo(), error: null }, { error: null }],
        vendors:     [{ data: { id: 'ven_1', name: 'Ace', email: 'first_last@example.com', phone: null }, error: null }],
        profiles:    [{ data: { full_name: 'Sam Jones', phone: null } }],
        organizations: [{ data: { name: 'Lake Martin Delivery' } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await dispatchWorkOrderToVendor({
        workOrderId: 'wo_1', vendorEmail: 'first_last@example.com', vendorName: 'Ace',
      })

      expect(result.success).toBe(true)
      const ilikeCall = supabase.from.mock.results
        .flatMap((r) => (r.value as { ilike?: { mock: { calls: unknown[][] } } }).ilike?.mock.calls ?? [])
        .find((args) => args[0] === 'email')
      expect(ilikeCall?.[1]).toBe('first\\_last@example.com')
    })

    it('sends an SMS alongside the dispatch email when a vendor phone is provided', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: baseWo(), error: null }, { error: null }],
        vendors:     [{ data: { id: 'ven_1', name: 'Ace Plumbing', email: 'vendor@example.com', phone: '(206) 555-1234' }, error: null }],
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
      expect(sendSMS).toHaveBeenCalledWith('+12065551234', 'sms body', { orgId: 'org_1' })
    })

    // The recipient must come from our own vendors table, never from the
    // request body: this action sends both an email and an SMS, and relaying
    // to a caller-supplied address made it a general-purpose mail/SMS relay
    // for any authenticated trial user.
    it('refuses to send to an address that is not a vendor in the caller org', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: baseWo(), error: null }, { error: null }],
        vendors:     [{ data: null, error: null }],   // no such vendor in this org
        profiles:    [{ data: { full_name: 'Sam Jones', phone: null } }],
        organizations: [{ data: { name: 'Lake Martin Delivery' } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await dispatchWorkOrderToVendor({
        workOrderId: 'wo_1', vendorEmail: 'attacker@evil.example', vendorName: 'Ace Plumbing',
        vendorPhone: '(206) 555-9999',
      })

      expect(result.success).toBeUndefined()
      expect(result.error).toMatch(/not in your address book/i)
      expect(inngest.send).not.toHaveBeenCalled()
      expect(sendSMS).not.toHaveBeenCalled()
    })

    it('sends to the vendor row contact details, ignoring what the caller supplied', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: baseWo(), error: null }, { error: null }],
        vendors:     [{ data: { id: 'ven_1', name: 'Ace Plumbing', email: 'real@vendor.example', phone: null }, error: null }],
        profiles:    [{ data: { full_name: 'Sam Jones', phone: null } }],
        organizations: [{ data: { name: 'Lake Martin Delivery' } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await dispatchWorkOrderToVendor({
        workOrderId: 'wo_1', vendorEmail: 'real@vendor.example', vendorName: 'Attacker Display Name',
      })

      expect(result.success).toBe(true)
      expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          vendorEmail: 'real@vendor.example',
          vendorName:  'Ace Plumbing',   // from the DB row, NOT input.vendorName
        }),
      }))
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
})
