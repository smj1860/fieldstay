import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/ical/conflict-detection', () => ({ detectAndFlagOverlaps: vi.fn() }))

import { requireOrgMember } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'
import { detectAndFlagOverlaps } from '@/lib/ical/conflict-detection'
import { createBooking, cancelBooking, triggerSync } from '@/app/(dashboard)/bookings/actions'

type Resp = { data?: unknown; error?: unknown; count?: number }

function makeSupabase(queue: Record<string, Resp[]>) {
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'in', 'not']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
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

describe('bookings/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('createBooking', () => {
    function bookingFd(overrides: Partial<Record<string, string>> = {}) {
      return fd({
        property_id:   'prop_1',
        checkin_date:  '2026-07-23',
        checkout_date: '2026-07-25',
        ...overrides,
      })
    }

    it('creates a booking when the property belongs to the caller org', async () => {
      const supabase = makeSupabase({
        properties: [{ data: { id: 'prop_1', name: 'Lakeview Cabin', checkin_time: '16:00', checkout_time: '10:00' } }],
        bookings:   [{ data: { id: 'booking_1' }, error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await createBooking(null, bookingFd())

      expect(result).toEqual({ success: true })
      expect(detectAndFlagOverlaps).toHaveBeenCalledWith(supabase, 'prop_1')
      expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({
        name: 'booking/detected',
        data: expect.objectContaining({ booking_id: 'booking_1', property_id: 'prop_1', org_id: 'org_1' }),
      }))
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'booking.created', orgId: 'org_1', targetId: 'booking_1',
      }))
    })

    it('rejects a property id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await createBooking(null, bookingFd({ property_id: 'other-orgs-property' }))

      expect(result).toEqual({ error: 'Property not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('bookings')
      expect(inngest.send).not.toHaveBeenCalled()
      expect(detectAndFlagOverlaps).not.toHaveBeenCalled()
    })

    it('rejects when required fields are missing', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await createBooking(null, bookingFd({ property_id: '' }))

      expect(result).toEqual({ error: 'Property is required' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects when check-out is not after check-in', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await createBooking(null, bookingFd({ checkin_date: '2026-07-25', checkout_date: '2026-07-23' }))

      expect(result).toEqual({ error: 'Check-out must be after check-in' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('returns a friendly conflict message on a unique-constraint violation', async () => {
      const supabase = makeSupabase({
        properties: [{ data: { id: 'prop_1', checkin_time: null, checkout_time: null } }],
        bookings:   [{ data: null, error: { code: '23505' } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await createBooking(null, bookingFd())

      expect(result).toEqual({ error: 'A booking already exists for these dates at this property.' })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await createBooking(null, bookingFd())

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('cancelBooking', () => {
    it('cancels a booking scoped to the caller org and reverses linked revenue', async () => {
      const supabase = makeSupabase({
        bookings:           [{ data: { property_id: 'prop_1' }, error: null }],
        turnovers:          [{ data: null, error: null }],
        owner_transactions: [
          { data: { id: 'txn_1', amount: 150, property_id: 'prop_1' } }, // existing revenue txn lookup
          { data: null, error: null, count: 0 },                        // reversal-exists count check
          { error: null },                                              // reversal insert
        ],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await cancelBooking('booking_1')

      expect(result).toEqual({})
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'booking.cancelled', orgId: 'org_1', targetId: 'booking_1',
      }))
      expect(detectAndFlagOverlaps).toHaveBeenCalledWith(supabase, 'prop_1')
    })

    it('scopes both the booking update and the linked turnover update to the caller org', async () => {
      const supabase = makeSupabase({
        bookings:           [{ data: { property_id: 'prop_1' }, error: null }],
        turnovers:          [{ data: null, error: null }],
        owner_transactions: [{ data: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await cancelBooking('other-orgs-booking')

      expect(supabase.from).toHaveBeenCalledWith('bookings')
      expect(supabase.from).toHaveBeenCalledWith('turnovers')
    })

    it('returns a generic error when the update itself errors', async () => {
      const supabase = makeSupabase({
        bookings: [{ data: null, error: { code: 'PGRST000', message: 'boom' } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await cancelBooking('booking_1')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(logAuditEvent).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await cancelBooking('booking_1')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('triggerSync', () => {
    it('sends the sync-all event scoped to the caller org', async () => {
      vi.mocked(requireOrgMember).mockResolvedValue({ membership } as never)

      await triggerSync()

      expect(inngest.send).toHaveBeenCalledWith({ name: 'ical/sync.all.requested', data: { org_id: 'org_1' } })
    })

    it('rethrows when the caller is unauthenticated', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      await expect(triggerSync()).rejects.toThrow('REDIRECT:/login')
      expect(inngest.send).not.toHaveBeenCalled()
    })
  })
})
