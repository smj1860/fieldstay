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
vi.mock('@/lib/inngest/client', () => {
  const send = vi.fn()
  return {
    inngest: { send },
    sendEventAsync: (...args: unknown[]) => { void Promise.resolve(send(...args)).catch(() => undefined) },
  }
})
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
  updateMaintenanceScheduleItem,
  duplicateMaintenanceScheduleItem,
  removeMaintenanceScheduleItem,
  addCatalogItemToProperty,
  addCustomMaintenanceItem,
  fetchArchivedWorkOrders,
} from '@/app/(dashboard)/maintenance/actions'
import {
  createMaintenanceScheduleTemplate,
  broadcastMaintenanceTemplate,
  updateMaintenanceTemplate,
} from '@/app/(dashboard)/maintenance/maintenance-template-actions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(
  queue: Record<string, Resp[]>,
  userId: string | null = 'user_1',
  rpcs: Record<string, Resp> = {},
) {
  // Every chained call is recorded so tests can assert on the payload/filters —
  // notably that the completing UPDATE carries completed_date and the
  // .neq('status', 'completed') claim.
  const calls: { table: string; method: string; args: unknown[] }[] = []

  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of [
      'select', 'insert', 'update', 'delete', 'upsert',
      'eq', 'neq', 'in', 'not', 'is', 'gte', 'order', 'limit',
      // `range` is needed by the fetchAllRows() pagination that replaced the
      // unbounded existing-schedules read in broadcastMaintenanceTemplate.
      'range',
    ]) {
      chain[m] = vi.fn((...args: unknown[]) => { calls.push({ table, method: m, args }); return chain })
    }
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  // Recorded into the SAME `calls` array as `.from()` chains, so a test can
  // assert that a multi-table action did NOT also write outside its
  // transactional RPC.
  const rpc = vi.fn((name: string, args: unknown) => {
    calls.push({ table: `rpc:${name}`, method: 'rpc', args: [args] })
    return Promise.resolve(rpcs[name] ?? { data: null, error: null })
  })
  return {
    from,
    rpc,
    calls,
    auth: { getUser: vi.fn(() => Promise.resolve({ data: { user: userId ? { id: userId } : null } })) },
    storage: { from: vi.fn(() => ({ remove: vi.fn(() => Promise.resolve({ data: null, error: null })) })) },
  }
}

// isVendorHardBlocked() fails CLOSED: a missing vendor_compliance_status row
// (the harness default) now BLOCKS assignment, because a vendor with no row is
// a vendor not in the caller's org. Tests that expect an assignment to succeed
// must therefore stub a compliant row explicitly — the previous implicit pass
// was the fail-open bug.
// A factory, not a shared constant: makeSupabase's queue shift() mutates the
// array it is handed, so a module-level array would be drained by the first
// test that used it.
const compliant = () => [{ data: { compliance_status: 'compliant' } }]

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

    // ── TENANT ISOLATION: assigned_crew_member_id ────────────────────────
    // work_orders_select grants read on an OR'd branch keyed by this column:
    // "any work order whose assigned_crew_member_id is one of YOUR
    // crew_members rows". Writing a FOREIGN org's crew id therefore handed
    // that other tenant's crew user read access to this work order. The id
    // came straight from the client and was never checked.
    it('rejects a crew member id belonging to another org', async () => {
      const supabase = makeSupabase({
        properties:   [{ data: { id: 'prop_1' } }],
        // The in-org lookup finds nothing: this crew id is not in org_1.
        crew_members: [{ data: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await createWorkOrder(null, woFd({ assigned_crew_member_id: 'crew_other_org' }))

      expect(result.error).toBe('That crew member is not part of your organization.')
      // And critically: no work order was written at all.
      expect(supabase.calls.some((c) => c.table === 'work_orders' && c.method === 'insert')).toBe(false)
    })

    it('scopes the crew lookup to the caller org, not just the crew id', async () => {
      const supabase = makeSupabase({
        properties:   [{ data: { id: 'prop_1' } }],
        crew_members: [{ data: { id: 'crew_1' } }],
        work_orders:  [{ data: { id: 'wo_1' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await createWorkOrder(null, woFd({ assigned_crew_member_id: 'crew_1' }))

      const crewEqs = supabase.calls.filter((c) => c.table === 'crew_members' && c.method === 'eq')
      expect(crewEqs.map((c) => c.args)).toEqual([['id', 'crew_1'], ['org_id', 'org_1']])
    })

    it('FAILS CLOSED when the crew lookup itself errors', async () => {
      // "We could not confirm this crew member is yours" must never resolve to
      // "assign them" — that is the direction that leaks a work order.
      const supabase = makeSupabase({
        properties:   [{ data: { id: 'prop_1' } }],
        crew_members: [{ data: null, error: { message: 'db unavailable' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await createWorkOrder(null, woFd({ assigned_crew_member_id: 'crew_1' }))

      expect(result.error).toBe('Could not verify the selected crew member. Please try again.')
      expect(supabase.calls.some((c) => c.table === 'work_orders' && c.method === 'insert')).toBe(false)
    })

    it('does not query crew_members at all when no crew member was supplied', async () => {
      const supabase = makeSupabase({
        properties:  [{ data: { id: 'prop_1' } }],
        work_orders: [{ data: { id: 'wo_1' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await createWorkOrder(null, woFd())

      expect(result.success).toBe(true)
      expect(supabase.calls.some((c) => c.table === 'crew_members')).toBe(false)
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
        // RFQ recipients are now org-verified and compliance-checked before
        // the work order is created, same as a direct vendor assignment.
        // createWorkOrder now dispatches through sendQuoteRequests rather than
        // a separate sender, so the queues cover BOTH passes: the pre-flight
        // vendor check before the insert, then the action's own work-order
        // re-read, vendor check, dedup read and insert.
        vendors:         [{ data: [{ id: 'vendor_1' }] }, { data: [{ id: 'vendor_1' }] }],
        vendor_compliance_status: [...compliant(), ...compliant()],
        work_orders:     [
          { data: { id: 'wo_1' } },
          { data: { id: 'wo_1', property_id: 'prop_1', status: 'quote_requested' } },
        ],
        quote_requests:  [{ data: [] }, { data: { id: 'qr_1' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const form = woFd({ request_quotes: 'true' })
      form.append('quote_vendor_ids', 'vendor_1')

      await expect(createWorkOrder(null, form)).rejects.toThrow('REDIRECT:/maintenance/wo_1')
    })

    // The create modal used to reach the database through its own exported
    // sender, which had no dedup filter, no vendor-id validation and no
    // work-order status check — and swallowed every insert failure. Both paths
    // are now the same action, so a failed send surfaces as a warning instead
    // of a redirect past it. redirect() throws, so returning is the only way
    // to carry the warning at all.
    it('warns instead of redirecting when the RFQ send fails, and does not lose the work order', async () => {
      const supabase = makeSupabase({
        properties:      [{ data: { id: 'prop_1' } }],
        vendors:         [{ data: [{ id: 'vendor_1' }] }, { data: [{ id: 'vendor_1' }] }],
        vendor_compliance_status: [...compliant(), ...compliant()],
        work_orders:     [
          { data: { id: 'wo_1' } },
          { data: { id: 'wo_1', property_id: 'prop_1', status: 'quote_requested' } },
        ],
        quote_requests:  [
          { data: [] },
          { data: null, error: { message: 'deadlock detected', code: '40P01' } },
        ],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const form = woFd({ request_quotes: 'true' })
      form.append('quote_vendor_ids', 'vendor_1')

      const result = await createWorkOrder(null, form)

      expect(result).toMatchObject({ success: true, workOrderId: 'wo_1' })
      expect(result?.warning).toMatch(/quote requests were not all sent/)
    })

    // ── Regression: the RFQ path routed around the vendor gates ──────────
    // `quote_vendor_ids` went straight from the form to a separate sender
    // with NO org check and NO compliance check. Both tests below created the
    // work order and dispatched RFQs against the pre-fix code.
    it('refuses to RFQ a vendor id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({
        properties: [{ data: { id: 'prop_1' } }],
        vendors:    [{ data: [] }],   // neither id resolves inside this org
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const form = woFd({ request_quotes: 'true' })
      form.append('quote_vendor_ids', 'other-orgs-vendor')

      const result = await createWorkOrder(null, form)

      expect(result).toEqual({ error: 'Vendor not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('work_orders')
      expect(supabase.from).not.toHaveBeenCalledWith('quote_requests')
    })

    it('refuses to RFQ a compliance hard-blocked vendor', async () => {
      const supabase = makeSupabase({
        properties: [{ data: { id: 'prop_1' } }],
        vendors:    [{ data: [{ id: 'vendor_1' }] }],
        vendor_compliance_status: [{ data: { compliance_status: 'hard_blocked' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const form = woFd({ request_quotes: 'true' })
      form.append('quote_vendor_ids', 'vendor_1')

      const result = await createWorkOrder(null, form)

      expect(result.error).toMatch(/hard-blocked/)
      expect(supabase.from).not.toHaveBeenCalledWith('quote_requests')
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
      const supabase = makeSupabase({ work_orders: [{ data: { id: 'wo_1' } }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await rateWorkOrderVendor('wo_1', 5, 'Great work')

      expect(result).toEqual({})
      expect(supabase.from).toHaveBeenCalledWith('work_orders')
    })

    it('reports a refused rating instead of returning success', async () => {
      const supabase = makeSupabase({ work_orders: [{ data: null, error: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await rateWorkOrderVendor('wo_1', 5, 'Great work')

      expect(result.error).toMatch(/permission|no longer exists/)
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

  describe('sendQuoteRequests', () => {
    it('sends RFQs to vendors without an existing active quote', async () => {
      const supabase = makeSupabase({
        work_orders:     [{ data: { id: 'wo_1', property_id: 'prop_1', status: 'pending' } }],
        vendors:         [{ data: [{ id: 'vendor_1' }] }],
        vendor_compliance_status: compliant(),
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

    // Regression: this action validated the work order but never the vendor
    // ids — pre-fix both cases below inserted quote_requests rows and fired
    // work-order/quote-requested.
    it('rejects a vendor id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: { id: 'wo_1', property_id: 'prop_1', status: 'pending' } }],
        vendors:     [{ data: [] }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await sendQuoteRequests('wo_1', ['other-orgs-vendor'])

      expect(result).toEqual({ error: 'Vendor not found', sent: 0 })
      expect(supabase.from).not.toHaveBeenCalledWith('quote_requests')
    })

    it('refuses to RFQ a compliance hard-blocked vendor', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: { id: 'wo_1', property_id: 'prop_1', status: 'pending' } }],
        vendors:     [{ data: [{ id: 'vendor_1' }] }],
        vendor_compliance_status: [{ data: { compliance_status: 'hard_blocked' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await sendQuoteRequests('wo_1', ['vendor_1'])

      expect(result.error).toMatch(/hard-blocked/)
      expect(result.sent).toBe(0)
      expect(supabase.from).not.toHaveBeenCalledWith('quote_requests')
    })

    // isVendorHardBlocked FAILS CLOSED — a compliance read that errors must
    // block the RFQ, not fall through as "not blocked".
    it('blocks the RFQ when the compliance read itself errors', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: { id: 'wo_1', property_id: 'prop_1', status: 'pending' } }],
        vendors:     [{ data: [{ id: 'vendor_1' }] }],
        vendor_compliance_status: [{ data: null, error: { message: 'permission denied', code: '42501' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await sendQuoteRequests('wo_1', ['vendor_1'])

      expect(result.error).toBeTruthy()
      expect(result.sent).toBe(0)
      expect(supabase.from).not.toHaveBeenCalledWith('quote_requests')
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

    // ── The failure that used to be invisible ────────────────────────────
    //
    // Both RFQ senders discarded a failed insert: this action returned
    // `false` for that vendor and reported only the successful count, and
    // the create modal's separate sender returned void and swallowed it
    // entirely. Either way a vendor the PM ticked silently never
    // received a request, and the work order sat in "Awaiting Quote" looking
    // exactly like one where every RFQ went out.
    it('reports a partial send instead of quietly returning the successful count', async () => {
      const supabase = makeSupabase({
        work_orders:              [{ data: { id: 'wo_1', property_id: 'prop_1', status: 'pending' } }],
        vendors:                  [{ data: [{ id: 'vendor_1' }, { id: 'vendor_2' }] }],
        // One entry per vendor: isVendorHardBlocked fails CLOSED, so a missing
        // row would block vendor_2 before any insert is attempted.
        vendor_compliance_status: [...compliant(), ...compliant()],
        quote_requests: [
          { data: [] },                                              // dedup read: none active
          { data: { id: 'qr_1' } },                                  // vendor_1 inserted
          { data: null, error: { message: 'deadlock detected', code: '40P01' } }, // vendor_2 failed
        ],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await sendQuoteRequests('wo_1', ['vendor_1', 'vendor_2'])

      expect(result.sent).toBe(1)
      expect(result.error).toMatch(/Sent 1 of 2/)
    })

    it('reports a total send failure as an error rather than sent: 0 with no explanation', async () => {
      const supabase = makeSupabase({
        work_orders:              [{ data: { id: 'wo_1', property_id: 'prop_1', status: 'pending' } }],
        vendors:                  [{ data: [{ id: 'vendor_1' }] }],
        vendor_compliance_status: compliant(),
        quote_requests: [
          { data: [] },
          { data: null, error: { message: 'permission denied', code: '42501' } },
        ],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await sendQuoteRequests('wo_1', ['vendor_1'])

      expect(result.sent).toBe(0)
      expect(result.error).toMatch(/Could not send/)
    })
  })

  describe('approveQuoteRequest', () => {
    it('approves a submitted quote, assigns the vendor, and declines the rest', async () => {
      const supabase = makeSupabase({
        quote_requests: [
          { data: { id: 'qr_1', work_order_id: 'wo_1', vendor_id: 'vendor_1', quoted_amount: 250, status: 'submitted', org_id: 'org_1' } },
        ],
        vendor_compliance_status: compliant(),
      }, 'user_1', {
        approve_quote_request: {
          data: { ok: true, work_order_id: 'wo_1', vendor_id: 'vendor_1', quoted_amount: 250, declined: 2 },
        },
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await approveQuoteRequest('qr_1')

      expect(result).toEqual({})
      expect(supabase.rpc).toHaveBeenCalledWith('approve_quote_request', expect.objectContaining({
        p_quote_request_id: 'qr_1',
        p_org_id:           'org_1',
      }))
      // The ids the event carries come from what the transaction actually
      // committed, not from the pre-read.
      expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({
        name: 'work-order/created',
        data: expect.objectContaining({ work_order_id: 'wo_1', vendor_id: 'vendor_1' }),
      }))
    })

    it('never writes the claim, the declines or the assignment outside the transaction', async () => {
      // The regression this encodes: as four sequential writes, a failure on
      // the work-order UPDATE left the winning quote 'approved', every rival
      // 'declined', and the work order UNASSIGNED with no live RFQ left —
      // unrecoverable from the UI.
      const supabase = makeSupabase({
        quote_requests: [
          { data: { id: 'qr_1', work_order_id: 'wo_1', vendor_id: 'vendor_1', quoted_amount: 250, status: 'submitted', org_id: 'org_1' } },
        ],
        vendor_compliance_status: compliant(),
      }, 'user_1', {
        approve_quote_request: {
          data: { ok: true, work_order_id: 'wo_1', vendor_id: 'vendor_1', quoted_amount: 250, declined: 2 },
        },
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      await approveQuoteRequest('qr_1')

      const writes = supabase.calls.filter(
        (c) => ['update', 'insert'].includes(c.method) &&
               ['quote_requests', 'work_orders', 'work_order_updates'].includes(c.table),
      )
      expect(writes).toEqual([])
    })

    it('refuses a double-approval (concurrent request already claimed it)', async () => {
      const supabase = makeSupabase({
        quote_requests: [
          { data: { id: 'qr_1', work_order_id: 'wo_1', vendor_id: 'vendor_1', quoted_amount: 250, status: 'submitted', org_id: 'org_1' } },
        ],
        vendor_compliance_status: compliant(),
      }, 'user_1', {
        // The claim inside the function matched nothing — another request had
        // already moved it off 'submitted'.
        approve_quote_request: { data: { ok: false, reason: 'not_submitted' } },
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await approveQuoteRequest('qr_1')

      expect(result).toEqual({ error: 'Can only approve a quote that has been submitted by the vendor' })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('refuses when the work order behind the quote is gone, leaving the quotes untouched', async () => {
      const supabase = makeSupabase({
        quote_requests: [
          { data: { id: 'qr_1', work_order_id: 'wo_1', vendor_id: 'vendor_1', quoted_amount: 250, status: 'submitted', org_id: 'org_1' } },
        ],
        vendor_compliance_status: compliant(),
      }, 'user_1', {
        approve_quote_request: { data: { ok: false, reason: 'work_order_not_found' } },
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await approveQuoteRequest('qr_1')

      expect(result).toEqual({ error: 'The work order for this quote no longer exists.' })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('reports a cancelled or completed work order distinctly, not as "not submitted"', async () => {
      // Greptile caught this: the RPC gained a work_order_not_assignable reason
      // (it refuses to resurrect a cancelled/completed WO) and the action's
      // union did not, so the case fell through to the vendor-submission
      // message — describing entirely the wrong problem.
      const supabase = makeSupabase({
        quote_requests: [
          { data: { id: 'qr_1', work_order_id: 'wo_1', vendor_id: 'vendor_1', quoted_amount: 250, status: 'submitted', org_id: 'org_1' } },
        ],
        vendor_compliance_status: compliant(),
      }, 'user_1', {
        approve_quote_request: { data: { ok: false, reason: 'work_order_not_assignable' } },
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await approveQuoteRequest('qr_1')

      expect(result).toEqual({
        error: 'That work order is already completed or cancelled, so a quote can no longer be approved against it.',
      })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('surfaces an RPC error rather than reporting the approval as done', async () => {
      const supabase = makeSupabase({
        quote_requests: [
          { data: { id: 'qr_1', work_order_id: 'wo_1', vendor_id: 'vendor_1', quoted_amount: 250, status: 'submitted', org_id: 'org_1' } },
        ],
        vendor_compliance_status: compliant(),
      }, 'user_1', {
        approve_quote_request: { data: null, error: { message: 'deadlock detected' } },
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await approveQuoteRequest('qr_1')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('rejects a quote request id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ quote_requests: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await approveQuoteRequest('other-orgs-qr')

      expect(result).toEqual({ error: 'Quote request not found' })
    })

    // ── Regression: approval is where the vendor is actually assigned ────
    // (vendor_id set, portal_enabled: true, a completion token issued) and it
    // never called isVendorHardBlocked at all. Pre-fix, a vendor whose COI
    // lapsed 46+ days ago could be RFQ'd, quote, be approved, and be
    // dispatched. The check runs BEFORE the atomic claim, so a blocked vendor
    // does not leave the quote stranded in 'approved'.
    it('refuses to approve a quote from a compliance hard-blocked vendor', async () => {
      const supabase = makeSupabase({
        quote_requests: [
          { data: { id: 'qr_1', work_order_id: 'wo_1', vendor_id: 'vendor_1', quoted_amount: 250, status: 'submitted', org_id: 'org_1' } },
        ],
        vendor_compliance_status: [{ data: { compliance_status: 'hard_blocked' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await approveQuoteRequest('qr_1')

      expect(result.error).toMatch(/hard-blocked/)
      expect(supabase.from).not.toHaveBeenCalledWith('work_orders')
      expect(inngest.send).not.toHaveBeenCalled()
      // The quote must NOT have been claimed — only one quote_requests read.
      expect(supabase.calls.filter((c) => c.table === 'quote_requests' && c.method === 'update')).toHaveLength(0)
    })

    it('blocks approval when the compliance read itself errors (fail closed)', async () => {
      const supabase = makeSupabase({
        quote_requests: [
          { data: { id: 'qr_1', work_order_id: 'wo_1', vendor_id: 'vendor_1', quoted_amount: 250, status: 'submitted', org_id: 'org_1' } },
        ],
        vendor_compliance_status: [{ data: null, error: { message: 'permission denied', code: '42501' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await approveQuoteRequest('qr_1')

      expect(result.error).toBeTruthy()
      expect(supabase.from).not.toHaveBeenCalledWith('work_orders')
      expect(inngest.send).not.toHaveBeenCalled()
    })
  })

  describe('declineQuoteRequest', () => {
    it('declines a quote request verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        quote_requests: [{ data: { id: 'qr_1', work_order_id: 'wo_1' } }, { data: { id: 'qr_1' }, error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await declineQuoteRequest('qr_1')

      expect(result).toEqual({})
    })

    // approveQuoteRequest goes through a transactional RPC; this twin threw its
    // write result away entirely and returned success unconditionally, so a
    // refused or failed decline closed the dialog as though it had worked.
    it('reports a refused decline instead of closing the dialog as though it worked', async () => {
      const supabase = makeSupabase({
        quote_requests: [{ data: { id: 'qr_1', work_order_id: 'wo_1' } }, { data: null, error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await declineQuoteRequest('qr_1')

      expect(result.error).toMatch(/permission|no longer exists/)
    })

    it('reports a failed decline rather than returning success', async () => {
      const supabase = makeSupabase({
        quote_requests: [
          { data: { id: 'qr_1', work_order_id: 'wo_1' } },
          { data: null, error: { message: 'deadlock detected', code: '40P01' } },
        ],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await declineQuoteRequest('qr_1')

      expect(result.error).toBeTruthy()
      expect(reportError).toHaveBeenCalled()
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
        vendor_compliance_status: compliant(),
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
        work_orders:  [{ data: [{ id: 'wo_1', suggestion_status: null, suggested_vendor_ids: null }] }, { data: [{ id: 'wo_1' }], error: null }],
        vendor_compliance_status: compliant(),
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

    // acceptVendorSuggestion — the other way a PM assigns a vendor — has always
    // written status: 'assigned' alongside vendor_id. This path wrote only
    // vendor_id, so a bulk-assigned work order kept reading 'pending' while
    // carrying a vendor who had already been emailed. Production had two of
    // those, and not one work order in 'assigned' or 'in_progress' at all.
    // `.in('id', ...)` matching FEWER rows than asked for is silent — no error,
    // just a shorter result — so a bulk assign where every id was foreign or
    // refused wrote nothing and still told the PM the vendor was assigned.
    it('reports a batch where the update claimed no rows, without dispatching', async () => {
      const supabase = makeSupabase({
        vendors:      [{ data: { id: 'vendor_1', name: 'Acme Cleaning' } }],
        work_orders:  [{ data: [{ id: 'wo_1', suggestion_status: null, suggested_vendor_ids: null }] }, { data: [], error: null }],
        vendor_compliance_status: compliant(),
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await bulkAssignVendor(['wo_1'], 'vendor_1')

      expect(result.error).toMatch(/permission|no longer exists/)
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('advances the status to assigned, not just the vendor', async () => {
      const supabase = makeSupabase({
        vendors:      [{ data: { id: 'vendor_1', name: 'Acme Cleaning' } }],
        work_orders:  [{ data: [{ id: 'wo_1', suggestion_status: null, suggested_vendor_ids: null }] }, { data: [{ id: 'wo_1' }], error: null }, { error: null }],
        vendor_compliance_status: compliant(),
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await bulkAssignVendor(['wo_1'], 'vendor_1')

      const updates = supabase.calls.filter((c) => c.table === 'work_orders' && c.method === 'update')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(updates.some((c) => (c.args[0] as any).vendor_id === 'vendor_1')).toBe(true)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(updates.some((c) => (c.args[0] as any).status === 'assigned')).toBe(true)
    })

    // The status must only move FORWARD. A reassignment on a work order that is
    // already in_progress must not drag it back to 'assigned' — hence a second,
    // filtered statement rather than one more column on the vendor update.
    it('only advances a status that is still pending or awaiting quotes', async () => {
      const supabase = makeSupabase({
        vendors:      [{ data: { id: 'vendor_1', name: 'Acme Cleaning' } }],
        work_orders:  [{ data: [{ id: 'wo_1', suggestion_status: null, suggested_vendor_ids: null }] }, { data: [{ id: 'wo_1' }], error: null }, { error: null }],
        vendor_compliance_status: compliant(),
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await bulkAssignVendor(['wo_1'], 'vendor_1')

      const statusFilter = supabase.calls.find(
        (c) => c.table === 'work_orders' && c.method === 'in' && c.args[0] === 'status',
      )
      expect(statusFilter?.args[1]).toEqual(['pending', 'quote_requested'])
    })

    // The vendor IS assigned and about to be emailed by the time this runs.
    // Failing the action would tell the PM nothing happened when the outbound
    // email is already on its way.
    it('does not fail the assignment when only the status advance errors', async () => {
      const supabase = makeSupabase({
        vendors:      [{ data: { id: 'vendor_1', name: 'Acme Cleaning' } }],
        work_orders:  [
          { data: [{ id: 'wo_1', suggestion_status: null, suggested_vendor_ids: null }] },
          { data: [{ id: 'wo_1' }], error: null },
          { error: { message: 'deadlock detected', code: '40P01' } },
        ],
        vendor_compliance_status: compliant(),
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await bulkAssignVendor(['wo_1'], 'vendor_1')

      expect(result).toEqual({})
      expect(inngest.send).toHaveBeenCalled()
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
        work_orders: [{ data: { id: 'wo_1', status: 'pending', suggested_vendor_ids: ['vendor_1'] } }, { data: { id: 'wo_1' }, error: null }, { error: null }],
        vendor_compliance_status: compliant(),
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

    // Same defect as the turnover board's acceptSuggestion, on the other board.
    // bulkAssignVendor already split the vendor write from the status advance
    // so the status only moves FORWARD; this path still folded
    // `status: 'assigned'` into one unconditional update, so accepting a
    // suggestion on a completed work order reopened it.
    it.each([
      ['completed', /already complete/],
      ['cancelled', /was cancelled/],
    ])('refuses to reopen a %s work order, writing nothing', async (status, message) => {
      const supabase = makeSupabase({
        work_orders: [{ data: { id: 'wo_1', status, suggested_vendor_ids: ['vendor_1'] } }],
        vendor_compliance_status: compliant(),
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await acceptVendorSuggestion('wo_1')

      expect(result.error).toMatch(message)
      expect(supabase.calls.some(c => c.method === 'update')).toBe(false)
      expect(inngest.send).not.toHaveBeenCalled()
    })

    // Accepting on a work order already in_progress records WHO — it must not
    // walk the status backwards to `assigned`.
    it('advances the status only from the two pre-vendor statuses', async () => {
      const supabase = makeSupabase({
        work_orders: [
          { data: { id: 'wo_1', status: 'in_progress', suggested_vendor_ids: ['vendor_1'] } },
          { data: { id: 'wo_1' }, error: null },
          { error: null },
        ],
        vendor_compliance_status: compliant(),
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await acceptVendorSuggestion('wo_1')

      expect(result).toEqual({})
      // The vendor write carries no `status` column at all …
      const vendorWrite = supabase.calls.find(
        c => c.table === 'work_orders' && c.method === 'update' &&
             (c.args[0] as { vendor_id?: string })?.vendor_id === 'vendor_1',
      )
      expect(vendorWrite?.args[0]).not.toHaveProperty('status')
      // … and the advance is filtered to pending/quote_requested, which
      // in_progress is not in.
      expect(
        supabase.calls.some(c => c.table === 'work_orders' && c.method === 'in' &&
          c.args[0] === 'status' &&
          Array.isArray(c.args[1]) && (c.args[1] as string[]).join() === 'pending,quote_requested'),
      ).toBe(true)
    })

    // A refused UPDATE returns 0 rows and NO error; this path discarded the
    // row count entirely and reported success for a change that never happened.
    it('reports a refused write instead of claiming the suggestion was accepted', async () => {
      const supabase = makeSupabase({
        work_orders: [
          { data: { id: 'wo_1', status: 'pending', suggested_vendor_ids: ['vendor_1'] } },
          { data: null, error: null },
        ],
        vendor_compliance_status: compliant(),
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await acceptVendorSuggestion('wo_1')

      expect(result.error).toMatch(/permission|no longer exists/)
      expect(inngest.send).not.toHaveBeenCalled()
    })

    // Fail-closed regression: the compliance gate is the enforcement boundary
    // for every assignment path. It previously discarded its error, so an RLS
    // denial or a transient failure returned "not blocked" and dispatched an
    // uninsured vendor to a customer's property.
    it('blocks the assignment when the compliance read itself errors', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: { id: 'wo_1', status: 'pending', suggested_vendor_ids: ['vendor_1'] } }],
        vendor_compliance_status: [{ data: null, error: { message: 'permission denied', code: '42501' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await acceptVendorSuggestion('wo_1')

      expect(result.error).toBeTruthy()
      expect(inngest.send).not.toHaveBeenCalled()
    })

    // Allowlist, not denylist: the vendor_compliance_status view is being
    // corrected and may gain a new state. An unrecognized status must block.
    it('blocks the assignment on an unrecognized compliance status', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: { id: 'wo_1', status: 'pending', suggested_vendor_ids: ['vendor_1'] } }],
        vendor_compliance_status: [{ data: { compliance_status: 'documents_invalid' } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await acceptVendorSuggestion('wo_1')

      expect(result.error).toBeTruthy()
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('errors when there is no suggestion to accept', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: { id: 'wo_1', status: 'pending', suggested_vendor_ids: [] } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await acceptVendorSuggestion('wo_1')

      expect(result).toEqual({ error: 'No suggestion to accept' })
    })

    it('dismisses a suggestion scoped to the caller org', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: { suggested_vendor_ids: ['vendor_1'] } }, { data: { id: 'wo_1' }, error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await dismissVendorSuggestion('wo_1')

      expect(result).toEqual({})
    })

    // A refused dismissal returns 0 rows and NO error. Without the row count
    // it still wrote the negative training signal below it and reported
    // success — the turnovers-side dismissSuggestion already carried this fix.
    it('does not record a training signal when the dismissal itself was refused', async () => {
      const supabase = makeSupabase({
        work_orders: [{ data: { suggested_vendor_ids: ['vendor_1'] } }, { data: null, error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await dismissVendorSuggestion('wo_1')

      expect(result.error).toMatch(/permission|no longer exists/)
      expect(createServiceClient).not.toHaveBeenCalled()
    })

    // A PostgREST builder RESOLVES with { error } — it never rejects — so the
    // bare `await service.from(...).upsert(...)` these two paths used meant
    // their try/catch caught nothing and the failure they exist to report
    // could not fire.
    it.each([
      ['acceptVendorSuggestion', () => acceptVendorSuggestion('wo_1'), true],
      ['dismissVendorSuggestion', () => dismissVendorSuggestion('wo_1'), false],
    ])('%s reports an outcome-upsert failure instead of swallowing it', async (_name, run, isAccept) => {
      const service = makeSupabase({
        vendor_assignment_outcomes: [{ error: { message: 'permission denied', code: '42501' } }],
      })
      vi.mocked(createServiceClient).mockReturnValue(service as never)

      const supabase = makeSupabase({
        work_orders: [
          { data: { id: 'wo_1', status: 'pending', suggested_vendor_ids: ['vendor_1'] } },
          { data: { id: 'wo_1' }, error: null },
          { error: null },
        ],
        vendor_compliance_status: compliant(),
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      // Non-blocking is correct — the assignment/dismissal itself stands …
      const result = await run()
      expect(result).toEqual({})
      // … but invisible is not.
      expect(reportError).toHaveBeenCalledWith(
        expect.objectContaining({ code: '42501' }),
        expect.objectContaining({
          site: isAccept
            ? 'serverAction.maintenance.acceptVendorSuggestion'
            : 'serverAction.maintenance.dismissVendorSuggestion',
        }),
      )
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

    // ── Regression: the bulk path had NO completion side effects at all ──
    // It wrote `status = 'completed'` and stopped. No work-order/completed
    // event (so no maintenance expense on the owner P&L), no completed_date,
    // no work_order_updates row, and no schedule advance — so the nightly
    // cron re-created every recurring WO a PM had just bulk-completed.
    // Every assertion below fails against the pre-fix code.
    it('fires one work-order/completed per claimed row, stamps completed_date, logs the change, and advances the source schedule', async () => {
      const supabase = makeSupabase({
        work_orders: [
          { data: [{ id: 'wo_1', vendor_id: null, status: 'in_progress' }, { id: 'wo_2', vendor_id: null, status: 'assigned' }] },
          { data: [
            { id: 'wo_1', property_id: 'prop_1', org_id: 'org_1', source_schedule_id: 'sched_1', source: 'maintenance_schedule', actual_cost: 120, estimated_cost: 100 },
            { id: 'wo_2', property_id: 'prop_2', org_id: 'org_1', source_schedule_id: null,      source: 'manual',               actual_cost: null, estimated_cost: 80 },
          ] },
        ],
        work_order_updates:    [{ error: null }],
        maintenance_schedules: [
          { data: [{ id: 'sched_1', schedule_type: 'routine', frequency: 'monthly', next_due_date: '2026-08-01', auto_create_wo: true }] },
          { error: null },
        ],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await bulkUpdateWorkOrderStatus(['wo_1', 'wo_2'], 'completed')

      expect(result).toEqual({})

      // One event per work order, batched into a single send.
      expect(inngest.send).toHaveBeenCalledWith([
        expect.objectContaining({ name: 'work-order/completed', data: expect.objectContaining({ work_order_id: 'wo_1', actual_cost: 120 }) }),
        expect.objectContaining({ name: 'work-order/completed', data: expect.objectContaining({ work_order_id: 'wo_2', actual_cost: 80 }) }),
      ])

      // completed_date was never set by the bulk path.
      const woUpdate = supabase.calls.find((c) => c.table === 'work_orders' && c.method === 'update')
      expect(woUpdate?.args[0]).toMatchObject({ status: 'completed' })
      expect((woUpdate?.args[0] as Record<string, unknown>).completed_date).toBeTruthy()

      // The claim guard lives on the WHERE clause, not on the pre-read.
      expect(supabase.calls).toContainEqual(
        expect.objectContaining({ table: 'work_orders', method: 'neq', args: ['status', 'completed'] })
      )

      // Status-change log row + source-schedule advance.
      expect(supabase.from).toHaveBeenCalledWith('work_order_updates')
      expect(supabase.from).toHaveBeenCalledWith('maintenance_schedules')
    })

    it('does not fan out when the completing UPDATE claims no rows', async () => {
      const supabase = makeSupabase({
        work_orders: [
          { data: [{ id: 'wo_1', vendor_id: null, status: 'completed' }] },
          { data: [] },   // already completed — .neq('status','completed') matched nothing
        ],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await bulkUpdateWorkOrderStatus(['wo_1'], 'completed')

      expect(inngest.send).not.toHaveBeenCalled()
      expect(supabase.from).not.toHaveBeenCalledWith('work_order_updates')
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

    // ── next_due_date must never be stored NULL for a datable schedule ──────
    //
    // A NULL next_due_date does not mean "undated", it means INERT. Every
    // consumer selects on that column with a comparison — the maintenance
    // cron's .lt(...) for overdue and .lte(...) for the alert window, and
    // cron-daily-wrapup's due section — and a NULL satisfies no comparison in
    // SQL, so the row is absent from all of them. The only writer of the
    // column anywhere is the roll-forward that ADVANCES an existing date;
    // nothing bootstraps a missing one, so NULL is permanent.
    //
    // Two live callers were storing exactly that. schedules-browser.tsx's
    // "add schedule" hard-codes next_due_date: null with auto_create_wo: true,
    // and maintenance-board.tsx reads a form field the PM may leave blank.
    // Both rendered as a healthy active schedule that silently never fired.
    function insertedRow(supabase: ReturnType<typeof makeSupabase>) {
      // from() is called twice: properties (ownership check), then the insert.
      return supabase.from.mock.results[1]!.value.insert.mock.calls[0]![0]
    }

    it.each([
      ['weekly',      'weekly'],
      ['quarterly',   'quarterly'],
      ['annual',      'annual'],
    ])('derives a first due date for a routine %s schedule when none is given', async (_label, frequency) => {
      const supabase = makeSupabase({
        properties:            [{ data: { id: 'prop_1' } }],
        maintenance_schedules: [{ error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      await createMaintenanceSchedule({
        ...scheduleInput,
        frequency:     frequency as typeof scheduleInput.frequency,
        next_due_date: null,
      })

      const due = insertedRow(supabase).next_due_date
      expect(due).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      // Strictly in the future: a date already past would fire a work order on
      // the next cron pass, which is not what "add a quarterly schedule" means.
      expect(new Date(due).getTime()).toBeGreaterThan(Date.now())
    })

    // The frequency column is nullable even for routine schedules, so the
    // derivation must not fall through to NULL on that path.
    it('still derives a date for a routine schedule with no frequency', async () => {
      const supabase = makeSupabase({
        properties:            [{ data: { id: 'prop_1' } }],
        maintenance_schedules: [{ error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      await createMaintenanceSchedule({ ...scheduleInput, frequency: null, next_due_date: null })

      expect(insertedRow(supabase).next_due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('derives the next occurrence of the month for a seasonal schedule', async () => {
      const supabase = makeSupabase({
        properties:            [{ data: { id: 'prop_1' } }],
        maintenance_schedules: [{ error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      await createMaintenanceSchedule({
        ...scheduleInput,
        schedule_type: 'seasonal',
        frequency:     null,
        month_due:     3,
        next_due_date: null,
      })

      expect(insertedRow(supabase).next_due_date).toMatch(/^\d{4}-03-01$/)
    })

    // The one case nothing can be derived from — there is no month and no
    // frequency to project forward. Storing an invented date would be worse
    // than storing NULL; the schedules browser flags it as "Not scheduled".
    it('leaves the date NULL for a seasonal schedule with no month', async () => {
      const supabase = makeSupabase({
        properties:            [{ data: { id: 'prop_1' } }],
        maintenance_schedules: [{ error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      await createMaintenanceSchedule({
        ...scheduleInput, schedule_type: 'seasonal', frequency: null, month_due: null, next_due_date: null,
      })

      expect(insertedRow(supabase).next_due_date).toBeNull()
    })

    it('never overrides a date the caller did supply', async () => {
      const supabase = makeSupabase({
        properties:            [{ data: { id: 'prop_1' } }],
        maintenance_schedules: [{ error: null }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      await createMaintenanceSchedule({ ...scheduleInput, next_due_date: '2026-08-01' })

      expect(insertedRow(supabase).next_due_date).toBe('2026-08-01')
    })
  })

  describe('updateMaintenanceSchedule / deleteMaintenanceSchedule', () => {
    const updateInput = {
      name: 'HVAC filter change', description: null, schedule_type: 'routine' as const,
      frequency: 'quarterly' as const, month_due: null, next_due_date: '2026-08-01',
      estimated_cost: null, assigned_vendor_id: null, auto_create_wo: true, instructions: null,
    }

    it('updates a schedule scoped to the caller org', async () => {
      const supabase = makeSupabase({ maintenance_schedules: [{ data: { id: 'sched_1' }, error: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await updateMaintenanceSchedule('sched_1', updateInput)

      expect(result).toEqual({ success: true })
    })

    // The inline row editor sends the WHOLE row on every Save, so clearing the
    // date box is one keystroke from re-opening the hole create just closed.
    // Pausing a schedule is is_active = false; a blank date has never meant
    // "paused", it means invisible to every cron that reads the column.
    it('re-derives the due date when an edit clears it', async () => {
      const supabase = makeSupabase({ maintenance_schedules: [{ error: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      await updateMaintenanceSchedule('sched_1', { ...updateInput, next_due_date: null })

      const patch = supabase.from.mock.results[0]!.value.update.mock.calls[0]![0]
      expect(patch.next_due_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    // Every one of these has a WHERE clause of just id + org, so 0 rows can
    // only mean refused or gone — never "already in that state". Each one
    // previously bound `error` alone and reported success on 0 rows.
    it.each([
      ['updateMaintenanceSchedule',     () => updateMaintenanceSchedule('sched_1', updateInput)],
      ['deleteMaintenanceSchedule',     () => deleteMaintenanceSchedule('sched_1')],
      ['updateMaintenanceScheduleItem', () => updateMaintenanceScheduleItem('item_1', { name: 'Renamed' })],
      ['removeMaintenanceScheduleItem', () => removeMaintenanceScheduleItem('item_1', 'prop_1')],
    ])('%s reports a refused write instead of returning success', async (_name, run) => {
      const supabase = makeSupabase({ maintenance_schedules: [{ data: null, error: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({ supabase, membership } as never)

      const result = await run()

      expect(result.success).toBeUndefined()
      expect(result.error).toMatch(/permission|no longer exists/)
    })

    it('soft-deletes a schedule scoped to the caller org', async () => {
      const supabase = makeSupabase({ maintenance_schedules: [{ data: { id: 'sched_1' }, error: null }] })
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

    // ── Regression: max_rows = 1000 silently truncated the dedupe set ────
    // The existing-schedules read is the ONLY duplicate guard (there is no
    // unique constraint on maintenance_schedules, and there deliberately
    // can't be — duplicateMaintenanceScheduleItem copies a name onto the same
    // property on purpose). Pre-fix it was a single unbounded select, so
    // anything past row 1000 was invisible and the schedule was re-created.
    // Pre-fix this asserts created: 0 / skipped: 1 but gets created: 1.
    it('sees an existing schedule that lands on the SECOND page of the dedupe read', async () => {
      const filler = Array.from({ length: 1000 }, (_, i) => ({ property_id: 'prop_other', name: `filler ${i}` }))
      const supabase = makeSupabase({
        maintenance_schedule_templates:      [{ data: { id: 'tmpl_1', org_id: null, is_system: true } }],
        maintenance_schedule_template_items: [{ data: [{ id: 'item_1', name: 'Filter change', description: null, schedule_frequency: 'quarterly', vendor_specialty_hint: 'hvac', estimated_cost: null, sort_order: 0, asset_category: null, active_from_month: null, active_to_month: null }] }],
        properties:                          [{ data: [{ id: 'prop_1' }] }],
        maintenance_schedules: [
          { data: filler },                                                 // page 1 — full page, drain continues
          { data: [{ property_id: 'prop_1', name: 'Filter change' }] },     // page 2 — the row that must not be duplicated
        ],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, user: { id: 'user_1' }, membership,
      } as never)

      const result = await broadcastMaintenanceTemplate('tmpl_1', ['prop_1'])

      expect(result).toEqual({ success: true, created: 0, skipped: 1 })
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
      const supabase = makeSupabase({ maintenance_schedules: [{ data: { id: 'item_1' }, error: null }] })
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
      const supabase = makeSupabase({ maintenance_schedules: [{ data: { id: 'item_1' }, error: null }] })
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
