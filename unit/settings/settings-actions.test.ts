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
  requireOrgRole:   vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}))
vi.mock('@/lib/geocoding', () => ({
  geocodeZip: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent:  vi.fn(),
  logAuditEvents: vi.fn(),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))
vi.mock('@/lib/stripe/client', () => ({
  stripe: {
    billingPortal: { sessions: { create: vi.fn() } },
    checkout:      { sessions: { create: vi.fn() } },
    subscriptions: { list: vi.fn(async () => ({ data: [] })) },
  },
  PLANS: {
    starter:   { monthlyPriceId: 'price_starter_m', annualPriceId: 'price_starter_a' },
    growth:    { monthlyPriceId: 'price_growth_m',   annualPriceId: 'price_growth_a' },
    portfolio: { monthlyPriceId: 'price_portfolio_m', annualPriceId: 'price_portfolio_a' },
  },
}))
vi.mock('@/emails/crew-invite', () => ({
  renderCrewInviteEmail: vi.fn(async () => '<html>invite</html>'),
}))
vi.mock('@/lib/sms/templates', () => ({
  renderSmsBody: vi.fn(async () => 'sms body'),
}))
// Dynamically imported inside inviteCrewMember/inviteAllUninvitedCrew — must
// still be mocked at module level since vi.mock hoists regardless of how the
// consumer imports it.
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn(async () => ({ error: null })) } },
  FROM:   'FieldStay <noreply@fieldstay.app>',
}))
vi.mock('@/lib/sms/telnyx', () => ({
  normalizePhoneToE164: vi.fn((raw: string) => `+1${raw.replace(/\D/g, '')}`),
  sendSMS:              vi.fn(async () => ({ sent: true })),
}))

import {
  updateOrgSettings,
  addCrewMember,
  updateCrewMember,
  deactivateCrewMember,
  addVendor,
  updateVendor,
  deactivateVendor,
  inviteCrewMember,
  inviteAllUninvitedCrew,
  updateAutoAssignMode,
  createCheckoutSession,
} from '@/app/(dashboard)/settings/actions'
import { requireOrgMember, requireOrgRole } from '@/lib/auth'
import { stripe } from '@/lib/stripe/client'
import { revalidatePath } from 'next/cache'
import { geocodeZip } from '@/lib/geocoding'
import { logAuditEvent, logAuditEvents } from '@/lib/audit'

interface QueuedByTable {
  [table: string]: unknown[]
}

// Queue-based `.from(table)` mock, following the pattern established in
// unit/owner-portal/load-owner-portal-data.test.ts and
// unit/inngest/work-order-dispatch.test.ts — each call to `.single()` /
// `.maybeSingle()` / a direct `await` on the chain consumes the next queued
// response for that table. `calls` records every filter invocation so tests
// can assert exactly which org_id / id a query or mutation was scoped to —
// that's the entire tenant-isolation/IDOR surface this file needs to prove.
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
    chain.insert = (...a: unknown[]) => record('insert', a)
    chain.update = (...a: unknown[]) => record('update', a)
    chain.delete = (...a: unknown[]) => record('delete', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.is     = (...a: unknown[]) => record('is', a)
    chain.or     = (...a: unknown[]) => record('or', a)

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

function mockAuthed(supabase: ReturnType<typeof makeSupabase>, role = 'admin') {
  vi.mocked(requireOrgMember).mockResolvedValue({
    user:       { id: USER_ID } as never,
    supabase:   supabase as never,
    membership: membership(role) as never,
  })
}

function formData(fields: Record<string, string>): FormData {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}

describe('settings/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('updateOrgSettings', () => {
    it('rejects when requireOrgMember rejects, without touching the DB', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      await expect(
        updateOrgSettings(null, formData({ name: 'New Name' }))
      ).resolves.toEqual({ error: 'Operation failed. Please try again.' })
    })

    it('updates the org scoped to the caller org_id on the happy path', async () => {
      const supabase = makeSupabase({ organizations: [{ data: null, error: null }] })
      mockAuthed(supabase)

      const result = await updateOrgSettings(null, formData({ name: 'New Name', billing_email: 'billing@example.com' }))

      expect(result).toEqual({ success: true })
      const updateCall = supabase.calls.find((c) => c.table === 'organizations' && c.method === 'update')
      expect(updateCall).toBeDefined()
      const eqCall = supabase.calls.find((c) => c.table === 'organizations' && c.method === 'eq')
      expect(eqCall?.args).toEqual(['id', ORG_ID])
      expect(revalidatePath).toHaveBeenCalledWith('/settings')
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_ID, actorId: USER_ID, action: 'org.settings.updated' })
      )
    })

    it('rejects a blank name before touching the DB', async () => {
      const supabase = makeSupabase()
      mockAuthed(supabase)

      const result = await updateOrgSettings(null, formData({ name: '  ' }))

      expect(result).toEqual({ error: 'Organization name is required' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('addCrewMember', () => {
    it('rejects when requireOrgMember rejects, without touching the DB', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await addCrewMember(null, formData({ name: 'Jamie', email: 'jamie@example.com' }))

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
    })

    it('inserts the crew member scoped to the caller org_id', async () => {
      const supabase = makeSupabase({
        crew_members: [{ data: { id: 'crew_1' }, error: null }],
      })
      mockAuthed(supabase)

      const result = await addCrewMember(null, formData({
        name: 'Jamie', email: 'jamie@example.com', role: 'cleaning',
      }))

      expect(result.success).toBe(true)
      const insertCall = supabase.calls.find((c) => c.table === 'crew_members' && c.method === 'insert')
      expect(insertCall).toBeDefined()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((insertCall!.args[0] as any).org_id).toBe(ORG_ID)
      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ orgId: ORG_ID, action: 'crew.member.created' })
      )
    })

    it('rejects when neither email nor phone is provided', async () => {
      const supabase = makeSupabase()
      mockAuthed(supabase)

      const result = await addCrewMember(null, formData({ name: 'Jamie' }))

      expect(result).toEqual({ error: 'Email or phone is required' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('geocodes and patches lat/lng when a home ZIP is provided', async () => {
      const supabase = makeSupabase({
        crew_members: [{ data: { id: 'crew_1' }, error: null }],
      })
      mockAuthed(supabase)
      vi.mocked(geocodeZip).mockResolvedValue({ lat: 32.6, lng: -85.9 })

      await addCrewMember(null, formData({ name: 'Jamie', email: 'jamie@example.com', home_zip: '36853' }))

      expect(geocodeZip).toHaveBeenCalledWith('36853')
      const updateCall = supabase.calls.find((c) => c.table === 'crew_members' && c.method === 'update')
      expect(updateCall).toBeDefined()
    })
  })

  describe('updateCrewMember — tenant isolation (IDOR)', () => {
    it('scopes both the existing-row lookup and the update to the caller org_id, not just the row id', async () => {
      const supabase = makeSupabase({
        crew_members: [
          { data: { home_zip: '36853' }, error: null }, // existing lookup
          { data: null, error: null },                   // update result
        ],
      })
      mockAuthed(supabase)

      await updateCrewMember('crew_other_org', { name: 'Updated Name' })

      const eqCalls = supabase.calls.filter((c) => c.table === 'crew_members' && c.method === 'eq')
      // Every eq() call chained off crew_members must include the caller's
      // org_id — an id from the request is not itself proof of ownership.
      expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
      expect(eqCalls.some((c) => c.args[0] === 'id' && c.args[1] === 'crew_other_org')).toBe(true)
    })

    it('rejects when requireOrgMember rejects, without touching the DB', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await updateCrewMember('crew_1', { name: 'X' })

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
    })

    it('logs a role_changed audit event only when role is part of the update', async () => {
      const supabase = makeSupabase({
        crew_members: [{ data: { home_zip: null }, error: null }, { data: null, error: null }],
      })
      mockAuthed(supabase)

      await updateCrewMember('crew_1', { role: 'maintenance' })

      expect(logAuditEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'crew.member.role_changed', targetId: 'crew_1' })
      )
    })
  })

  describe('deactivateCrewMember', () => {
    it('scopes the deactivation update to the caller org_id', async () => {
      const supabase = makeSupabase({ crew_members: [{ data: null, error: null }] })
      mockAuthed(supabase)

      await deactivateCrewMember('crew_1')

      const eqCalls = supabase.calls.filter((c) => c.table === 'crew_members' && c.method === 'eq')
      expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
      expect(eqCalls.some((c) => c.args[0] === 'id' && c.args[1] === 'crew_1')).toBe(true)
    })

    it('propagates (throws) when requireOrgMember rejects', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      await expect(deactivateCrewMember('crew_1')).rejects.toThrow('REDIRECT:/login')
    })
  })

  describe('addVendor', () => {
    it('requires an email address before touching the DB', async () => {
      const supabase = makeSupabase()
      mockAuthed(supabase)

      const result = await addVendor(null, formData({ name: 'Ace Plumbing' }))

      expect(result.error).toMatch(/email/i)
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('inserts the vendor scoped to the caller org_id', async () => {
      const supabase = makeSupabase({ vendors: [{ data: { id: 'vendor_1' }, error: null }] })
      mockAuthed(supabase)

      const result = await addVendor(null, formData({ name: 'Ace Plumbing', email: 'ace@example.com' }))

      expect(result.success).toBe(true)
      const insertCall = supabase.calls.find((c) => c.table === 'vendors' && c.method === 'insert')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((insertCall!.args[0] as any).org_id).toBe(ORG_ID)
    })
  })

  describe('updateVendor — tenant isolation (IDOR)', () => {
    it('scopes both the existing-row lookup and the update to the caller org_id', async () => {
      const supabase = makeSupabase({
        vendors: [{ data: { service_zip: null }, error: null }, { data: null, error: null }],
      })
      mockAuthed(supabase)

      await updateVendor('vendor_other_org', null, formData({ name: 'Ace Plumbing' }))

      const eqCalls = supabase.calls.filter((c) => c.table === 'vendors' && c.method === 'eq')
      expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
      expect(eqCalls.some((c) => c.args[0] === 'id' && c.args[1] === 'vendor_other_org')).toBe(true)
    })
  })

  describe('deactivateVendor', () => {
    it('scopes the deactivation update to the caller org_id', async () => {
      const supabase = makeSupabase({ vendors: [{ data: null, error: null }] })
      mockAuthed(supabase)

      await deactivateVendor('vendor_1')

      const eqCalls = supabase.calls.filter((c) => c.table === 'vendors' && c.method === 'eq')
      expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
    })
  })

  describe('inviteCrewMember — role gate', () => {
    it('denies a crew-role caller before reading any crew_members row', async () => {
      const supabase = makeSupabase()
      mockAuthed(supabase, 'crew')

      const result = await inviteCrewMember('crew_1')

      expect(result).toEqual({ error: 'Permission denied' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('denies a viewer-role caller', async () => {
      const supabase = makeSupabase()
      mockAuthed(supabase, 'viewer')

      const result = await inviteCrewMember('crew_1')

      expect(result).toEqual({ error: 'Permission denied' })
    })

    it('allows a manager-role caller to invite (manager is in the allowed list)', async () => {
      const supabase = makeSupabase({
        crew_members: [
          { data: { id: 'crew_1', name: 'Jamie', email: 'jamie@example.com', phone: null, invite_token: 'tok', user_id: null, invite_sent_at: null }, error: null },
          { data: { id: 'crew_1' }, error: null }, // atomic claim update
          { data: { name: 'Lake Martin Delivery' }, error: null }, // org lookup
        ],
      })
      mockAuthed(supabase, 'manager')

      const result = await inviteCrewMember('crew_1')

      expect(result).toEqual({ success: true })
    })

    it('rejects when the crew member does not belong to the caller org (IDOR)', async () => {
      // The lookup itself is scoped by .eq('org_id', ...) — simulate that
      // scoping returning no row for a crew member in a different org.
      const supabase = makeSupabase({ crew_members: [{ data: null, error: null }] })
      mockAuthed(supabase, 'admin')

      const result = await inviteCrewMember('crew_in_other_org')

      expect(result).toEqual({ error: 'Crew member not found' })
      const eqCalls = supabase.calls.filter((c) => c.table === 'crew_members' && c.method === 'eq')
      expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
    })
  })

  describe('inviteAllUninvitedCrew — role gate', () => {
    it('denies a crew-role caller before querying crew_members', async () => {
      const supabase = makeSupabase()
      mockAuthed(supabase, 'crew')

      const result = await inviteAllUninvitedCrew()

      expect(result).toEqual({ sent: 0, error: 'Permission denied' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('scopes the uninvited-crew query to the caller org_id and sends nothing when empty', async () => {
      const supabase = makeSupabase({ crew_members: [{ data: [], error: null }] })
      mockAuthed(supabase, 'admin')

      const result = await inviteAllUninvitedCrew()

      expect(result).toEqual({ sent: 0 })
      const eqCalls = supabase.calls.filter((c) => c.table === 'crew_members' && c.method === 'eq')
      expect(eqCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === ORG_ID)).toBe(true)
      expect(logAuditEvents).not.toHaveBeenCalled()
    })
  })

  describe('updateAutoAssignMode', () => {
    it('rejects when requireOrgMember rejects, without touching the DB', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await updateAutoAssignMode('autopilot')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
    })

    it('scopes the organizations update to the caller org_id', async () => {
      const supabase = makeSupabase({ organizations: [{ data: null, error: null }] })
      mockAuthed(supabase)

      const result = await updateAutoAssignMode('autopilot')

      expect(result).toEqual({ success: true })
      const eqCall = supabase.calls.find((c) => c.table === 'organizations' && c.method === 'eq')
      expect(eqCall?.args).toEqual(['id', ORG_ID])
    })
  })

  describe('createCheckoutSession', () => {
    // An org that already has a live subscription must never be handed a
    // second Checkout: mode:'subscription' creates a NEW subscription every
    // time it completes, so an existing subscriber clicking a plan card ended
    // up billed twice, with the older subscription invisible in the app (the
    // webhook handler overwrites the single stripe_subscription_id column).
    function mockRoleAuthed(supabase: ReturnType<typeof makeSupabase>) {
      vi.mocked(requireOrgRole).mockResolvedValue({
        user:       { id: USER_ID } as never,
        supabase:   supabase as never,
        membership: membership('admin') as never,
      })
    }

    it('sends an org with an active subscription to the billing portal instead of a second checkout', async () => {
      const supabase = makeSupabase({
        organizations: [{ data: { stripe_customer_id: 'cus_1', billing_email: 'pm@example.com' }, error: null }],
      })
      mockRoleAuthed(supabase)
      vi.mocked(stripe.subscriptions.list).mockResolvedValue({ data: [{ status: 'active' }] } as never)
      vi.mocked(stripe.billingPortal.sessions.create).mockResolvedValue({ url: 'https://portal' } as never)

      const result = await createCheckoutSession('growth', 'monthly')

      expect(result).toEqual({ redirectUrl: 'https://portal' })
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
    })

    it('treats trialing and past_due as live too', async () => {
      for (const status of ['trialing', 'past_due', 'unpaid', 'paused']) {
        vi.clearAllMocks()
        const supabase = makeSupabase({
          organizations: [{ data: { stripe_customer_id: 'cus_1', billing_email: null }, error: null }],
        })
        mockRoleAuthed(supabase)
        vi.mocked(stripe.subscriptions.list).mockResolvedValue({ data: [{ status }] } as never)
        vi.mocked(stripe.billingPortal.sessions.create).mockResolvedValue({ url: 'https://portal' } as never)

        const result = await createCheckoutSession('growth', 'monthly')

        expect(result, status).toEqual({ redirectUrl: 'https://portal' })
        expect(stripe.checkout.sessions.create, status).not.toHaveBeenCalled()
      }
    })

    it('still allows checkout after a failed first payment (incomplete is not live)', async () => {
      // Stripe leaves a failed first charge as 'incomplete' for ~23h. Blocking
      // on it would lock the customer out of retrying entirely.
      const supabase = makeSupabase({
        organizations: [{ data: { stripe_customer_id: 'cus_1', billing_email: null }, error: null }],
        integration_connections: [{ data: null, error: null }],
      })
      mockRoleAuthed(supabase)
      vi.mocked(stripe.subscriptions.list).mockResolvedValue({
        data: [{ status: 'incomplete' }, { status: 'incomplete_expired' }, { status: 'canceled' }],
      } as never)
      vi.mocked(stripe.checkout.sessions.create).mockResolvedValue({ url: 'https://checkout' } as never)

      const result = await createCheckoutSession('growth', 'monthly')

      expect(result).toEqual({ redirectUrl: 'https://checkout' })
      expect(stripe.billingPortal.sessions.create).not.toHaveBeenCalled()
    })

    it('passes an idempotency key so a double-click cannot mint two sessions', async () => {
      const supabase = makeSupabase({
        organizations: [{ data: { stripe_customer_id: null, billing_email: 'pm@example.com' }, error: null }],
        integration_connections: [{ data: null, error: null }],
      })
      mockRoleAuthed(supabase)
      vi.mocked(stripe.checkout.sessions.create).mockResolvedValue({ url: 'https://checkout' } as never)

      await createCheckoutSession('growth', 'annual')

      expect(stripe.checkout.sessions.create).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ idempotencyKey: `checkout:${ORG_ID}:growth:annual` }),
      )
    })

    it('does not query Stripe at all for an org with no customer yet', async () => {
      const supabase = makeSupabase({
        organizations: [{ data: { stripe_customer_id: null, billing_email: 'pm@example.com' }, error: null }],
        integration_connections: [{ data: null, error: null }],
      })
      mockRoleAuthed(supabase)
      vi.mocked(stripe.checkout.sessions.create).mockResolvedValue({ url: 'https://checkout' } as never)

      const result = await createCheckoutSession('starter', 'monthly')

      expect(result).toEqual({ redirectUrl: 'https://checkout' })
      expect(stripe.subscriptions.list).not.toHaveBeenCalled()
    })
  })
})
