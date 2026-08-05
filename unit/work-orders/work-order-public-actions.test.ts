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
    signOffRatelimit: { limit: vi.fn(async () => ({ success: true })) },
    // dispatchWorkOrderToVendor consults this before sending; without it here
    // the import resolves to undefined and the stub throws inside the action's
    // try/catch, which surfaces as the generic error rather than the real one.
    emailSendActionLimiter: { limit: vi.fn(async () => ({ success: true })) },
    checkLimit:         checkLimitStub(),
    retryAfterSeconds:  retryAfterSecondsStub,
  }
})

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
    // `.is(...)` is the sign-off UPDATE's TOCTOU precondition
    // (.is('public_signed_off_at', null)); `.maybeSingle()` is how it reads
    // back whether it actually matched a row.
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
        // 2nd entry = the conditional UPDATE's own
        // .select('id').maybeSingle() readback: a row means this request won
        // the .is('public_signed_off_at', null) claim.
        work_orders: [{ data: baseWo(), error: null }, { data: { id: 'wo_1' }, error: null }],
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

    // M-3: the read above is only a nicer error message. The real guard is the
    // precondition inside the UPDATE — two concurrent submits both pass the
    // read, and exactly one matches the .is('public_signed_off_at', null)
    // clause. The loser must NOT go on to upload photos, log an audit event,
    // or fire the downstream notification.
    it('TOCTOU: the concurrent loser is rejected even though its pre-read saw an unsigned work order', async () => {
      const supabase = makeSupabase({
        work_orders: [
          { data: baseWo(), error: null },        // pre-read: not signed off yet
          { data: null, error: null },            // conditional UPDATE matched ZERO rows
        ],
      })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await submitWorkOrderSignOff(VALID_TOKEN, 'All done', undefined, 150)

      expect(result).toEqual({ error: 'This work order has already been signed off' })
      expect(logAuditEvent).not.toHaveBeenCalled()
      expect(inngest.send).not.toHaveBeenCalled()
      expect(supabase.uploadMock).not.toHaveBeenCalled()
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

    // NaN is the one that mattered: `cost < 0 || cost > 1_000_000` is false for
    // NaN on both sides, so it reached the write, and supabase-js serializes it
    // to JSON null — the vendor's cost silently became a NULL actual_cost with
    // no error anywhere. Infinity took the same path past the lower bound.
    it.each([
      ['negative',  -5,                        'Amount cannot be negative.'],
      ['NaN',       Number.NaN,                'Enter a valid amount.'],
      ['Infinity',  Number.POSITIVE_INFINITY,  'Enter a valid amount.'],
      ['over $1M',  5_000_000,                 'Amount must be under $1,000,000.'],
    ])('rejects a %s actual cost before hitting the DB', async (_label, cost, message) => {
      const supabase = makeSupabase({})
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await submitWorkOrderSignOff(VALID_TOKEN, 'All done', undefined, cost)

      expect(result).toEqual({ error: message })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    // A Server Action's parameter types are a compile-time claim about values
    // the caller supplies, and Next.js registers every exported action at a
    // stable endpoint — so these are reachable by a direct POST whether or not
    // any page renders them.
    it.each([
      ['an object masquerading as a 64-char token', { length: 64 }, 'All done', 'Invalid link'],
      ['a null token',                              null,           'All done', 'Invalid link'],
      ['null notes',                                VALID_TOKEN,    null,       'Invalid sign-off notes'],
    ])('rejects %s instead of throwing', async (_label, token, notes, message) => {
      const supabase = makeSupabase({})
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)

      const result = await submitWorkOrderSignOff(
        token as unknown as string,
        notes as unknown as string,
      )

      expect(result).toEqual({ error: message })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('uploads sign-off photos and inserts work_order_photos rows', async () => {
      const supabase = makeSupabase({
        work_orders:        [{ data: baseWo(), error: null }, { data: { id: 'wo_1' }, error: null }],
        work_order_photos:  [{ error: null }],
      })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)
      const photos = [new File(['x'], 'p0.jpg', { type: 'image/jpeg' })]

      const result = await submitWorkOrderSignOff(VALID_TOKEN, 'All done', photos)

      expect(result).toEqual({ success: true })
      expect(supabase.storage.from).toHaveBeenCalledWith('work-order-photos')
      expect(supabase.uploadMock).toHaveBeenCalled()

      // M4: the object path must start with the owning org's id — the
      // work-order-photos bucket moves to private + org-scoped storage RLS
      // keyed on (storage.foldername(name))[1].
      const uploadedPath = String((supabase.uploadMock.mock.calls as unknown as unknown[][])[0]![0])
      expect(uploadedPath.startsWith('org_1/')).toBe(true)
    })

    it('still completes but WARNS when a photo upload fails', async () => {
      // The uploads run after the completing UPDATE has committed and the
      // token has been spent by the public_signed_off_at guard, so the vendor
      // cannot resubmit. Reporting a bare `{ success: true }` told them their
      // evidence was filed when it had gone nowhere.
      const supabase = makeSupabase({
        work_orders:       [{ data: baseWo(), error: null }, { data: { id: 'wo_1' }, error: null }],
        work_order_photos: [{ error: null }],
      })
      supabase.uploadMock.mockResolvedValueOnce({ error: { message: 'storage down' } } as never)
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)
      const photos = [new File(['x'], 'p0.jpg', { type: 'image/jpeg' })]

      const result = await submitWorkOrderSignOff(VALID_TOKEN, 'All done', photos)

      // The sign-off itself stands — a lost photo must not un-complete a
      // finished work order.
      expect(result.success).toBe(true)
      expect(result.error).toBeUndefined()
      expect(result.warning).toContain('1 photo failed to upload')
    })

    it('warns when the photo row insert fails even though the object uploaded', async () => {
      // An object in the bucket that is linked to no work order is, from the
      // work order's point of view, the same as never having been uploaded.
      const supabase = makeSupabase({
        work_orders:       [{ data: baseWo(), error: null }, { data: { id: 'wo_1' }, error: null }],
        work_order_photos: [{ error: { message: 'insert failed' } }],
      })
      vi.mocked(createServiceClient).mockReturnValue(supabase as never)
      const photos = [new File(['x'], 'p0.jpg', { type: 'image/jpeg' })]

      const result = await submitWorkOrderSignOff(VALID_TOKEN, 'All done', photos)

      expect(result.success).toBe(true)
      expect(result.warning).toContain('1 photo failed to upload')
    })
  })
})
