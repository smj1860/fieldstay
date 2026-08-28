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
    hosts:     { name: 'Hosts',     maxProperties: 4,   monthlyPriceId: 'price_hosts_m',     annualPriceId: 'price_hosts_a' },
    starter:   { name: 'Starter',   maxProperties: 15,  monthlyPriceId: 'price_starter_m',   annualPriceId: 'price_starter_a' },
    growth:    { name: 'Growth',    maxProperties: 50,  monthlyPriceId: 'price_growth_m',    annualPriceId: 'price_growth_a' },
    portfolio: { name: 'Portfolio', maxProperties: 100, monthlyPriceId: 'price_portfolio_m', annualPriceId: 'price_portfolio_a' },
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
  bulkImportCrew,
  updateAutoAssignMode,
  createCheckoutSession,
  saveOrgSmsTemplate,
  updateSlackWebhook,
} from '@/app/(dashboard)/settings/actions'
import {
  checkoutIdempotencyKey,
  CHECKOUT_IDEMPOTENCY_WINDOW_MS,
} from '@/app/(dashboard)/settings/checkout-idempotency'
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
    chain.upsert = (...a: unknown[]) => record('upsert', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.is     = (...a: unknown[]) => record('is', a)
    chain.or     = (...a: unknown[]) => record('or', a)
    chain.limit  = (...a: unknown[]) => record('limit', a)

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

  describe('addCrewMember — auto-assign eligibility', () => {
    // An unchecked checkbox submits NOTHING, which is indistinguishable from a
    // form that has no such field. Both of this action's callers matter here:
    // crew-manage offers the control, and the onboarding form does not. The UI
    // therefore pairs a hidden 'false' with the checkbox's 'true' so presence
    // of ANY value means "this form asked".
    const eligibilityIn = (insertCall?: { args: unknown[] }) =>
      (insertCall?.args[0] as Record<string, unknown> | undefined)

    it('omits the column entirely when the form does not offer the control', async () => {
      // THE ONBOARDING CASE, and the one worth getting right: reading a bare
      // checkbox here would have made every crew member added during setup
      // ineligible, silently inverting the column's DEFAULT true for the
      // people least likely to notice.
      const supabase = makeSupabase({ crew_members: [{ data: { id: 'crew_1' }, error: null }] })
      mockAuthed(supabase)

      await addCrewMember(null, formData({ name: 'Jamie', email: 'jamie@example.com' }))

      const insert = supabase.calls.find((c) => c.table === 'crew_members' && c.method === 'insert')
      expect(eligibilityIn(insert)).not.toHaveProperty('auto_assign_eligible')
    })

    it('stores false when the box was present and unticked', async () => {
      const supabase = makeSupabase({ crew_members: [{ data: { id: 'crew_1' }, error: null }] })
      mockAuthed(supabase)

      // Hidden field only — exactly what the browser sends for an unticked box.
      const fd = new FormData()
      fd.set('name', 'Jamie')
      fd.set('email', 'jamie@example.com')
      fd.append('auto_assign_eligible', 'false')

      await addCrewMember(null, fd)

      const insert = supabase.calls.find((c) => c.table === 'crew_members' && c.method === 'insert')
      expect(eligibilityIn(insert)).toMatchObject({ auto_assign_eligible: false })
    })

    it('stores true when the box was ticked, despite the hidden false also being sent', async () => {
      // Both values arrive, in DOM order. Reading .get() would return the
      // hidden 'false' and store the opposite of what the PM chose.
      const supabase = makeSupabase({ crew_members: [{ data: { id: 'crew_1' }, error: null }] })
      mockAuthed(supabase)

      const fd = new FormData()
      fd.set('name', 'Jamie')
      fd.set('email', 'jamie@example.com')
      fd.append('auto_assign_eligible', 'false')
      fd.append('auto_assign_eligible', 'true')

      await addCrewMember(null, fd)

      const insert = supabase.calls.find((c) => c.table === 'crew_members' && c.method === 'insert')
      expect(eligibilityIn(insert)).toMatchObject({ auto_assign_eligible: true })
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

    // The recipient fan-out is what this action actually spends, and the
    // per-call limiter above it counts calls, not people. Without a bound on
    // the query itself, one allowed call reached every uninvited row (capped
    // only by PostgREST's max_rows = 1000), so 20 calls/hour meant up to
    // 20,000 emails and 20,000 SMS per hour to third-party addresses.
    it('bounds the recipient list so one call cannot fan out unbounded', async () => {
      const supabase = makeSupabase({ crew_members: [{ data: [], error: null }] })
      mockAuthed(supabase, 'admin')

      await inviteAllUninvitedCrew()

      const limitCall = supabase.calls.find((c) => c.table === 'crew_members' && c.method === 'limit')
      expect(limitCall).toBeDefined()
      expect(limitCall!.args[0]).toBeLessThanOrEqual(200)
    })
  })

  describe('bulkImportCrew — fan-out staging bound', () => {
    it('rejects an oversized import without writing anything', async () => {
      const supabase = makeSupabase()
      mockAuthed(supabase, 'admin')

      const rows = Array.from({ length: 501 }, (_, i) => ({ name: `Crew ${i}`, email: `c${i}@example.com` }))
      const result = await bulkImportCrew(rows)

      expect(result.imported).toBe(0)
      expect(result.error).toMatch(/too many rows/i)
      // The staging write must not happen — these rows are the address list
      // inviteAllUninvitedCrew would later mail.
      expect(supabase.calls.some((c) => c.table === 'crew_members' && c.method === 'insert')).toBe(false)
    })

    it('accepts an import at the cap', async () => {
      const supabase = makeSupabase({ crew_members: [{ data: null, error: null }] })
      mockAuthed(supabase, 'admin')

      const rows = Array.from({ length: 500 }, (_, i) => ({ name: `Crew ${i}` }))
      const result = await bulkImportCrew(rows)

      expect(result.error).toBeUndefined()
      expect(result.imported).toBe(500)
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

    // Stripe Checkout hides the promotion-code field unless the session asks
    // for it, and the omission is SILENT: the page renders, takes a card and
    // charges full price. A customer holding a code has nowhere to type it and
    // nothing tells them so. Found the first time a checkout page was reached
    // for real — there was no field on it.
    it('lets the customer enter a promotion code', async () => {
      const supabase = makeSupabase({
        organizations: [{ data: { stripe_customer_id: null, billing_email: 'pm@example.com' }, error: null }],
        integration_connections: [{ data: null, error: null }],
      })
      mockRoleAuthed(supabase)
      vi.mocked(stripe.checkout.sessions.create).mockResolvedValue({ url: 'https://checkout' } as never)

      await createCheckoutSession('growth', 'monthly')

      const [params] = vi.mocked(stripe.checkout.sessions.create).mock.calls[0]!
      expect(params).toMatchObject({ allow_promotion_codes: true })
      // Stripe rejects a session that sets both, so this is not merely
      // redundant — it is the difference between a working session and a 400.
      expect(params).not.toHaveProperty('discounts')
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
        expect.objectContaining({ idempotencyKey: checkoutIdempotencyKey(ORG_ID, 'growth', 'annual') }),
      )
    })

    // ── The key must EXPIRE ─────────────────────────────────────────────
    // Stripe saves the status and body of the first request under a key and
    // replays it for every later request with that key — errors included. A
    // key with no time component therefore pins a FAILURE for the 24h Stripe
    // holds it: the 2026-08-28 archived-product error would have kept coming
    // back, from cache, for the rest of the day after the product was
    // un-archived, with a fresh Sentry report each time that read as "the fix
    // did not work".
    //
    // Asserted as behaviour over two instants rather than by matching the key
    // string, so this still fails if someone reverts to a constant key while
    // leaving the helper's name in place.
    it('rotates the idempotency key so a fixed config can be retried', () => {
      const t0    = 1_800_000_000_000
      const key   = (at: number) => checkoutIdempotencyKey(ORG_ID, 'growth', 'annual', at)

      // Inside one window a double-click collapses — the thing the key is for.
      expect(key(t0)).toBe(key(t0 + 5_000))

      // Past the window it does not, so a retry actually reaches Stripe.
      expect(key(t0)).not.toBe(key(t0 + CHECKOUT_IDEMPOTENCY_WINDOW_MS + 1))

      // And the window is short enough to be useful: well under the 24h
      // Stripe caches a response for. A key that rotated daily would satisfy
      // the assertion above and still leave the billing path untestable for a
      // day after a fix.
      expect(CHECKOUT_IDEMPOTENCY_WINDOW_MS).toBeLessThanOrEqual(30 * 60 * 1000)

      // Distinct plans and orgs stay distinct — the bucket must not have
      // flattened the key into something two callers share.
      expect(key(t0)).not.toBe(checkoutIdempotencyKey(ORG_ID, 'starter', 'annual', t0))
      expect(key(t0)).not.toBe(checkoutIdempotencyKey(ORG_ID, 'growth', 'monthly', t0))
      expect(key(t0)).not.toBe(checkoutIdempotencyKey('other-org', 'growth', 'annual', t0))
    })

    // ── Property-cap guard ──────────────────────────────────────────────
    // max_properties is written straight from PLANS[plan].maxProperties by
    // the Stripe webhook, with no reference to what the org actually has. So
    // buying an under-sized plan left an org permanently over cap: existing
    // properties keep working (the cap is only checked when ADDING one), so
    // nothing breaks loudly — they just pay for less than they use, forever,
    // with no signal. Adding the $89 Hosts tier made it one click away for a
    // trialing org sitting at the 15-property trial cap.
    it('refuses a plan that covers fewer properties than the org already has', async () => {
      const supabase = makeSupabase({
        properties: [{ data: null, error: null, count: 10 } as never],
      })
      mockRoleAuthed(supabase)

      const result = await createCheckoutSession('hosts', 'monthly')

      expect(result).toEqual({
        error: 'Hosts covers up to 4 properties, but you have 10 active properties. ' +
               'Choose a plan that fits, or archive the extras first.',
      })
      // Refused BEFORE any Stripe call — no session to abandon, no customer
      // record touched.
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
      expect(stripe.subscriptions.list).not.toHaveBeenCalled()
    })

    it('allows a plan the org fits exactly at', async () => {
      // Boundary: 4 properties on a 4-property plan is COVERED, not over. The
      // add-property gate uses >= because it asks "can I fit one MORE"; this
      // asks "does this plan cover what I have" — a different question.
      const supabase = makeSupabase({
        properties: [{ data: null, error: null, count: 4 } as never],
        organizations: [{ data: { stripe_customer_id: null, billing_email: 'pm@example.com' }, error: null }],
        integration_connections: [{ data: null, error: null }],
      })
      mockRoleAuthed(supabase)
      vi.mocked(stripe.checkout.sessions.create).mockResolvedValue({ url: 'https://checkout' } as never)

      const result = await createCheckoutSession('hosts', 'monthly')

      expect(result).toEqual({ redirectUrl: 'https://checkout' })
    })

    it('fails CLOSED when the property count read errors — never bills a plan it could not verify', async () => {
      // Guessing "probably fits" here charges a customer for a plan that may
      // not cover them, which is the exact outcome the guard exists to stop.
      const supabase = makeSupabase({
        properties: [{ data: null, error: { message: 'statement timeout', code: '57014' } } as never],
      })
      mockRoleAuthed(supabase)

      const result = await createCheckoutSession('hosts', 'monthly')

      expect(result).toEqual({ error: 'We could not verify your property count. Please try again.' })
      expect(stripe.checkout.sessions.create).not.toHaveBeenCalled()
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

// ─────────────────────────────────────────────────────────────────────────────
// saveOrgSmsTemplate — the opt-out notice and the template key
//
// An org override REPLACES the built-in body wholesale (lib/sms/templates.ts's
// renderSmsBody prefers it unconditionally), and all ten built-in defaults end
// with "Reply STOP to opt out." Nothing downstream re-adds it — sendSMS hands
// the body straight to Telnyx. So before these guards, saving one template
// without an opt-out line silently stripped the opt-out instruction from every
// message that org sent, guest and crew alike, for as long as the override
// existed. That is the compliance requirement SMS_ENABLED is being held shut
// for until 10DLC verification clears.
// ─────────────────────────────────────────────────────────────────────────────
describe('saveOrgSmsTemplate', () => {
  beforeEach(() => vi.clearAllMocks())

  it('refuses a body with no opt-out instruction, and writes nothing', async () => {
    const supabase = makeSupabase()
    mockAuthed(supabase)

    const result = await saveOrgSmsTemplate(
      'morning_nudge',
      'Good morning! It is {{temperature}}°F at {{property_name}} today.'
    )

    expect(result.error).toMatch(/opt out/i)
    expect(supabase.calls.some((c) => c.method === 'upsert')).toBe(false)
  })

  it('accepts alternative opt-out wording — the keyword is what carriers act on', async () => {
    const supabase = makeSupabase()
    mockAuthed(supabase)

    // A PM who writes their own phrasing has satisfied the requirement just as
    // well as our default sentence; the guard must not force our exact copy.
    const result = await saveOrgSmsTemplate(
      'morning_nudge',
      'Morning from {{property_name}}! Text STOP to unsubscribe.'
    )

    expect(result).toEqual({})
    expect(supabase.calls.some((c) => c.method === 'upsert')).toBe(true)
  })

  it('does not mistake "stop" inside another word for an opt-out instruction', async () => {
    const supabase = makeSupabase()
    mockAuthed(supabase)

    // Prose that merely contains the letters is not opt-out instructions.
    // "NON-STOP" is the one that matters: a plain \bSTOP\b matches it, because
    // a hyphen counts as a word boundary — this exact body was accepted by the
    // first version of hasOptOutNotice.
    const result = await saveOrgSmsTemplate(
      'morning_nudge',
      'The shuttle stops right outside {{property_name}} — NON-STOP to the lake!'
    )

    expect(result.error).toMatch(/opt out/i)
    expect(supabase.calls.some((c) => c.method === 'upsert')).toBe(false)
  })

  it('rejects a key that is not in the registry, and writes nothing', async () => {
    const supabase = makeSupabase()
    mockAuthed(supabase)

    // A Server Action is an HTTP endpoint any authenticated caller can invoke
    // directly, so the typed `SmsTemplateKey` at the UI call site proves
    // nothing. An unrecognised key wrote a row renderSmsBody can never read.
    const result = await saveOrgSmsTemplate('not_a_real_key', 'Hi. Reply STOP to opt out.')

    expect(result.error).toBe('Unknown template.')
    expect(supabase.calls.some((c) => c.method === 'upsert')).toBe(false)
  })

  it('scopes the upsert to the caller\'s own org', async () => {
    const supabase = makeSupabase()
    mockAuthed(supabase)

    await saveOrgSmsTemplate('door_code', 'Code is {{door_code}}. Reply STOP to opt out.')

    const upsert = supabase.calls.find((c) => c.method === 'upsert')
    expect((upsert?.args[0] as { org_id: string }).org_id).toBe(ORG_ID)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The five org-settings writes are admin-only in the DATABASE — `orgs_update`
// is is_org_member(id, ARRAY['admin']) — and a Postgres UPDATE whose rows RLS
// filters out matches ZERO rows and returns NO error.
//
// So gating these on bare requireOrgMember() meant a manager, viewer or crew
// member got the whole happy path: `{ success: true }`, "Settings saved
// successfully" in the UI, and an audit row recording a change that never
// happened. The audit rows are the worst of it — a log that records changes
// which did not occur actively misleads whoever reads it in an investigation.
// ─────────────────────────────────────────────────────────────────────────────
describe('org-settings writes are gated to admin/owner, matching orgs_update RLS', () => {
  beforeEach(() => vi.clearAllMocks())

  const DENIED = /Only an admin or the account owner/

  it.each(['manager', 'viewer', 'crew'])(
    'refuses a %s: no write, and no audit row claiming one happened',
    async (role) => {
      const supabase = makeSupabase()
      mockAuthed(supabase, role)

      const result = await updateOrgSettings(null, formData({ name: 'New Name' }))

      expect(result.error).toMatch(DENIED)
      expect(supabase.from).not.toHaveBeenCalled()
      expect(logAuditEvent).not.toHaveBeenCalled()
    }
  )

  it.each(['admin', 'owner'])('still lets a %s through', async (role) => {
    const supabase = makeSupabase({ organizations: [{ data: null, error: null }] })
    mockAuthed(supabase, role)

    const result = await updateOrgSettings(null, formData({ name: 'New Name' }))

    expect(result).toEqual({ success: true })
    expect(supabase.calls.some((c) => c.table === 'organizations' && c.method === 'update')).toBe(true)
  })

  it('refuses a manager on updateAutoAssignMode — the one with ongoing side effects', async () => {
    const supabase = makeSupabase()
    mockAuthed(supabase, 'manager')

    // Reported as saved, this is the setting that keeps auto-assigning crew to
    // every new turnover after the PM believes they switched it off.
    const result = await updateAutoAssignMode('disabled')

    expect(result.error).toMatch(DENIED)
    expect(supabase.from).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('refuses a manager on updateSlackWebhook', async () => {
    const supabase = makeSupabase()
    mockAuthed(supabase, 'manager')

    const result = await updateSlackWebhook(
      null,
      formData({ slack_webhook_url: 'https://hooks.slack.com/services/T/B/x' })
    )

    expect(result.error).toMatch(DENIED)
    expect(supabase.from).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })
})

describe('updateSlackWebhook — blank no longer means "clear it"', () => {
  beforeEach(() => vi.clearAllMocks())

  it('refuses a blank submit instead of wiping the configured webhook', async () => {
    const supabase = makeSupabase()
    mockAuthed(supabase, 'admin')

    // The field now renders EMPTY even when a webhook is set, because the
    // stored URL is a bearer credential and is no longer sent to the browser.
    // Under the old "blank means null" rule, that empty field wiped the
    // webhook on any unrelated save of this form.
    const result = await updateSlackWebhook(null, formData({ slack_webhook_url: '   ' }))

    expect(result.error).toMatch(/Remove/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('clears it only on an explicit remove intent', async () => {
    const supabase = makeSupabase({ organizations: [{ data: null, error: null }] })
    mockAuthed(supabase, 'admin')

    const result = await updateSlackWebhook(null, formData({ slack_webhook_url: '', intent: 'remove' }))

    expect(result).toEqual({ success: true })
    const update = supabase.calls.find((c) => c.table === 'organizations' && c.method === 'update')
    expect((update?.args[0] as { slack_webhook_url: string | null }).slack_webhook_url).toBeNull()
  })

  it('still rejects a non-Slack URL', async () => {
    const supabase = makeSupabase()
    mockAuthed(supabase, 'admin')

    const result = await updateSlackWebhook(null, formData({ slack_webhook_url: 'https://evil.example.com/hook' }))

    expect(result.error).toMatch(/Slack Incoming Webhook/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('never puts the URL in the audit metadata', async () => {
    const supabase = makeSupabase({ organizations: [{ data: null, error: null }] })
    mockAuthed(supabase, 'admin')

    const url = 'https://hooks.slack.com/services/T000/B000/secret'
    await updateSlackWebhook(null, formData({ slack_webhook_url: url }))

    const logged = vi.mocked(logAuditEvent).mock.calls[0]?.[0]
    expect(JSON.stringify(logged)).not.toContain('secret')
    expect(logged).toEqual(
      expect.objectContaining({ metadata: expect.objectContaining({ configured: true }) })
    )
  })
})
