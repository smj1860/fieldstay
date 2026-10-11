import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { resolveNeededByDate, resolveNeededByFromNextBooking } from '@/lib/work-orders/needed-by'
import { reportError } from '@/lib/observability/report-error'

type Resp = { data?: unknown; error?: unknown }

/**
 * Records every filter so the tests can assert on the ones that carry the
 * meaning — `status = confirmed` and `checkin_date > today` — rather than only
 * on the value that comes back. A resolver that returned the right date off the
 * wrong filter would pass a value-only assertion.
 */
function makeSupabase(result: Resp) {
  const calls: { method: string; args: unknown[] }[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  for (const m of ['select', 'eq', 'gt', 'order', 'limit']) {
    chain[m] = vi.fn((...args: unknown[]) => { calls.push({ method: m, args }); return chain })
  }
  chain.maybeSingle = vi.fn(() => Promise.resolve(result))
  const from = vi.fn(() => chain)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { client: { from } as any, calls, from }
}

describe('resolveNeededByFromNextBooking', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns the next confirmed check-in date', async () => {
    const { client } = makeSupabase({ data: { checkin_date: '2026-10-17' }, error: null })
    await expect(resolveNeededByFromNextBooking(client, 'org_1', 'prop_1')).resolves.toBe('2026-10-17')
  })

  it('returns null when the property has no upcoming booking', async () => {
    const { client } = makeSupabase({ data: null, error: null })
    await expect(resolveNeededByFromNextBooking(client, 'org_1', 'prop_1')).resolves.toBeNull()
  })

  it('asks only for confirmed bookings, strictly after today', async () => {
    const { client, calls } = makeSupabase({ data: null, error: null })
    await resolveNeededByFromNextBooking(client, 'org_1', 'prop_1')

    const eqs = calls.filter((c) => c.method === 'eq').map((c) => c.args)
    expect(eqs).toEqual(expect.arrayContaining([
      ['org_id', 'org_1'],
      ['property_id', 'prop_1'],
      ['status', 'confirmed'],
    ]))

    // `gt`, not `gte`: a guest arriving TODAY is not a deadline a work order
    // can still be scheduled against, and proposing it would prefill the
    // create form with a date that is already unmeetable.
    const gt = calls.find((c) => c.method === 'gt')
    expect(gt?.args[0]).toBe('checkin_date')
    expect(gt?.args[1]).toBe(new Date().toISOString().slice(0, 10))
  })

  it('reports a query failure as a warning and returns null rather than throwing', async () => {
    const { client } = makeSupabase({ data: null, error: { message: 'boom' } })

    // The default is a convenience. Refusing to create the work order because
    // the booking calendar was unreadable would trade a missing date for a
    // missing work order.
    await expect(resolveNeededByFromNextBooking(client, 'org_1', 'prop_1')).resolves.toBeNull()
    expect(reportError).toHaveBeenCalledWith(
      { message: 'boom' },
      expect.objectContaining({ level: 'warning', orgId: 'org_1' }),
    )
  })
})

describe('resolveNeededByDate', () => {
  beforeEach(() => vi.clearAllMocks())

  it('never overrules a date the PM typed, even when a nearer booking exists', async () => {
    const { client, from } = makeSupabase({ data: { checkin_date: '2026-10-12' }, error: null })

    await expect(resolveNeededByDate(client, 'org_1', 'prop_1', '2026-11-30'))
      .resolves.toEqual({ date: '2026-11-30', derived: false })

    // Not merely the right answer: it must not have asked at all. A supplied
    // value is a human decision, so the derivation is skipped rather than
    // computed and discarded.
    expect(from).not.toHaveBeenCalled()
  })

  it('derives from the next booking when the PM left it blank', async () => {
    const { client } = makeSupabase({ data: { checkin_date: '2026-10-17' }, error: null })
    await expect(resolveNeededByDate(client, 'org_1', 'prop_1', null))
      .resolves.toEqual({ date: '2026-10-17', derived: true })
  })

  it('reports derived=false when nothing could be derived', async () => {
    const { client } = makeSupabase({ data: null, error: null })

    // `derived` describes whether a date was INVENTED for the PM, so a null
    // result is not "derived null" — the caller uses this to decide whether to
    // tell them where the date came from.
    await expect(resolveNeededByDate(client, 'org_1', 'prop_1', null))
      .resolves.toEqual({ date: null, derived: false })
  })

  it('does not query when there is no property yet', async () => {
    const { client, from } = makeSupabase({ data: null, error: null })
    await expect(resolveNeededByDate(client, 'org_1', '', null))
      .resolves.toEqual({ date: null, derived: false })
    expect(from).not.toHaveBeenCalled()
  })
})
