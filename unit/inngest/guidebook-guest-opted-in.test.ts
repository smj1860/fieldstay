import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/sms/telnyx', () => ({
  sendSMS: vi.fn(async () => ({ sent: true })),
}))
vi.mock('@/lib/sms/templates', () => ({
  renderSmsBody: vi.fn(async () => 'rendered door code sms'),
}))

import { guidebookGuestOptedIn } from '@/lib/inngest/functions/guidebook-guest-opted-in'
import { createServiceClient } from '@/lib/supabase/server'
import { sendSMS } from '@/lib/sms/telnyx'
import { renderSmsBody } from '@/lib/sms/templates'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock — same convention as checklist-broadcast
// and cron-vendor-compliance-grace-check. `guidebook_guest_sms_optins` is
// queried for the atomic claim and (on a failed send) again for the
// rollback, so a fixed per-table response isn't enough — order matters.
function makeSupabase(
  queued: Record<string, { data?: unknown; error?: unknown }[]>,
  rpcResult: { data?: unknown; error?: unknown } = { data: null, error: null }
) {
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
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.is     = (...a: unknown[]) => record('is', a)
    chain.update = (...a: unknown[]) => record('update', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  const rpc = vi.fn(async () => rpcResult)

  return { from, rpc, calls }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function optedInEvent(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      optinId:    'optin_1',
      bookingId:  'bk_1',
      propertyId: 'prop_1',
      phoneE164:  '+15551234567',
      ...overrides,
    },
  }
}

const propertyRow = { id: 'prop_1', name: 'Lake House', door_code_secret_id: 'vault_sec_1', org_id: 'org_1' }
const bookingRow   = { guidebook_token: 'tok_abc123' }

describe('guidebookGuestOptedIn', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('decrypts the door code, claims the send atomically, and texts the guest', async () => {
    const supabase = makeSupabase(
      {
        properties: [{ data: propertyRow, error: null }],
        bookings:   [{ data: bookingRow, error: null }],
        guidebook_guest_sms_optins: [{ data: { id: 'optin_1' }, error: null }], // claim succeeds
      },
      { data: '4321', error: null } // decrypted door code
    )
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guidebookGuestOptedIn, { event: optedInEvent(), step: makeStep() })

    expect(supabase.rpc).toHaveBeenCalledWith('read_property_door_code', {
      p_property_id: 'prop_1',
      p_org_id:      'org_1',
    })
    expect(renderSmsBody).toHaveBeenCalledWith('org_1', 'door_code', {
      property_name: 'Lake House',
      door_code:     '4321',
      portal_url:    expect.stringContaining('/g/b/tok_abc123'),
    })
    expect(sendSMS).toHaveBeenCalledWith('+15551234567', 'rendered door code sms', { orgId: 'org_1' })
    expect(result).toEqual({ optinId: 'optin_1', sentDoorCode: true })
  })

  it('skips entirely when the property has no door code configured — never calls the decrypt RPC', async () => {
    const supabase = makeSupabase({
      properties: [{ data: { ...propertyRow, door_code_secret_id: null }, error: null }],
      bookings:   [{ data: bookingRow, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guidebookGuestOptedIn, { event: optedInEvent(), step: makeStep() })

    expect(supabase.rpc).not.toHaveBeenCalled()
    expect(sendSMS).not.toHaveBeenCalled()
    expect(result).toEqual({ optinId: 'optin_1', sentDoorCode: false })
  })

  it('skips the send when the decrypted door code comes back empty', async () => {
    const supabase = makeSupabase(
      {
        properties: [{ data: propertyRow, error: null }],
        bookings:   [{ data: bookingRow, error: null }],
      },
      { data: null, error: null }
    )
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guidebookGuestOptedIn, { event: optedInEvent(), step: makeStep() })

    expect(sendSMS).not.toHaveBeenCalled()
    expect(supabase.calls.some((c) => c.table === 'guidebook_guest_sms_optins')).toBe(false)
    expect(result).toEqual({ optinId: 'optin_1', sentDoorCode: true })
  })

  it('idempotency: skips the send when a prior successful run already claimed door_code_sent_at', async () => {
    const supabase = makeSupabase(
      {
        properties: [{ data: propertyRow, error: null }],
        bookings:   [{ data: bookingRow, error: null }],
        // The atomic UPDATE ... WHERE door_code_sent_at IS NULL affected 0
        // rows because a prior run already claimed it — maybeSingle() finds
        // nothing.
        guidebook_guest_sms_optins: [{ data: null, error: null }],
      },
      { data: '4321', error: null }
    )
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(guidebookGuestOptedIn, { event: optedInEvent(), step: makeStep() })

    expect(sendSMS).not.toHaveBeenCalled()
    expect(result).toEqual({ optinId: 'optin_1', sentDoorCode: true })
  })

  // The two exits below are NOT the same event, and conflating them is what
  // shipped: sendSMS THROWS on a real send failure (dispatchToTelnyx throws on
  // a timeout or any non-2xx) and returns {sent:false} only for a DELIBERATE
  // skip. One test used to feed a {sent:false} and assert a throw, which
  // asserted the wrong half of both behaviours at once.

  it('releases the claim and rethrows when the SMS send THROWS, so the Inngest retry can send again', async () => {
    const supabase = makeSupabase(
      {
        properties: [{ data: propertyRow, error: null }],
        bookings:   [{ data: bookingRow, error: null }],
        guidebook_guest_sms_optins: [
          { data: { id: 'optin_1' }, error: null }, // claim succeeds
          { data: null, error: null },              // claim release
        ],
      },
      { data: '4321', error: null }
    )
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(sendSMS as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Telnyx 502'))

    await expect(
      invokeHandler(guidebookGuestOptedIn, { event: optedInEvent(), step: makeStep() })
    ).rejects.toThrow('Telnyx 502')

    // Without the release, the retry hits `.is('door_code_sent_at', null)`,
    // matches zero rows, returns `already_sent` — and the guest never gets
    // their door code while the run reports success.
    const releaseCall = supabase.calls.filter(
      (c) => c.table === 'guidebook_guest_sms_optins' && c.method === 'update'
    )[1]
    expect(releaseCall?.args[0]).toEqual({ door_code_sent_at: null })
  })

  it('releases the claim and ends cleanly — no throw — when sendSMS reports a deliberate skip', async () => {
    const supabase = makeSupabase(
      {
        properties: [{ data: propertyRow, error: null }],
        bookings:   [{ data: bookingRow, error: null }],
        guidebook_guest_sms_optins: [
          { data: { id: 'optin_1' }, error: null }, // claim succeeds
          { data: null, error: null },              // claim release
        ],
      },
      { data: '4321', error: null }
    )
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(sendSMS as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ sent: false, reason: 'SMS_ENABLED is not true' })

    // SMS_ENABLED=false is production's current state. Throwing here made
    // EVERY guest opt-in a failing, retried Inngest run reading "SMS send
    // failed" — untrue, and noise that would mask real failures once SMS is
    // switched on. A retry cannot change an env var.
    const result = await invokeHandler(guidebookGuestOptedIn, {
      event: optedInEvent(),
      step:  makeStep(),
    })
    expect(result).toEqual({ optinId: 'optin_1', sentDoorCode: true })

    // Still released, for the opposite reason: so the send can happen once
    // the skip no longer applies.
    const releaseCall = supabase.calls.filter(
      (c) => c.table === 'guidebook_guest_sms_optins' && c.method === 'update'
    )[1]
    expect(releaseCall?.args[0]).toEqual({ door_code_sent_at: null })
  })
})
