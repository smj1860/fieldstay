import { describe, it, expect, vi } from 'vitest'
import { nudgeDueDateIntoVacancy } from '@/lib/maintenance/vacant-due-date'
import type { SupabaseClient } from '@supabase/supabase-js'

// ============================================================================
// The DB half of the vacancy nudge. `gaps.test.ts` covers the arithmetic; what
// is left here is the QUERY — which bookings it asks for, and what it does when
// the read fails.
// ============================================================================

interface Filter { method: string; args: unknown[] }

function makeClient(result: { data?: unknown[]; error?: { message: string } }) {
  const filters: Filter[] = []
  const builder: Record<string, unknown> = {}
  for (const m of ['select', 'eq', 'in', 'lte', 'gte', 'limit']) {
    builder[m] = (...args: unknown[]) => { filters.push({ method: m, args }); return builder }
  }
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: result.data ?? null, error: result.error ?? null }).then(resolve)

  const client = { from: () => builder } as unknown as SupabaseClient
  const arg = (method: string, index: number) =>
    filters.find((f) => f.method === method && f.args[0] === index)?.args[1]
  return { client, filters, arg }
}

const b = (checkin_date: string, checkout_date: string) => ({ checkin_date, checkout_date })

describe('nudgeDueDateIntoVacancy', () => {
  it('asks for bookings OVERLAPPING the month, not contained in it', () => {
    // A booking that starts in the prior month and ends in this one occupies
    // the first days of it. A containment filter would miss it entirely and
    // call those days free — which is the whole failure mode this replaces.
    const { client, filters } = makeClient({ data: [] })
    return nudgeDueDateIntoVacancy(client, 'org-1', 'prop-1', '2026-09-15').then(() => {
      const lte = filters.find((f) => f.method === 'lte')!
      const gte = filters.find((f) => f.method === 'gte')!
      expect(lte.args).toEqual(['checkin_date',  '2026-09-30'])
      expect(gte.args).toEqual(['checkout_date', '2026-09-01'])
    })
  })

  it('scopes to the org as well as the property', async () => {
    // The Inngest caller runs on a service-role client where RLS is not a
    // backstop, so the tenant scope has to be in the query itself.
    const { client, filters } = makeClient({ data: [] })
    await nudgeDueDateIntoVacancy(client, 'org-1', 'prop-1', '2026-09-15')

    const eqs = filters.filter((f) => f.method === 'eq').map((f) => f.args)
    expect(eqs).toContainEqual(['org_id', 'org-1'])
    expect(eqs).toContainEqual(['property_id', 'prop-1'])
  })

  it('counts confirmed and tentative as occupied — and never blocked', async () => {
    // `blocked` is an owner block, which this codebase already treats as a
    // vacancy WINDOW (vacancy-suggestions.ts's Phase 30 path exists to schedule
    // maintenance into exactly those). Counting it as occupied here would make
    // one block mean opposite things in two places.
    const { client, filters } = makeClient({ data: [] })
    await nudgeDueDateIntoVacancy(client, 'org-1', 'prop-1', '2026-09-15')

    const statuses = filters.find((f) => f.method === 'in')!.args[1] as string[]
    expect([...statuses].sort()).toEqual(['confirmed', 'tentative'])
  })

  it('bounds the read', async () => {
    const { client, filters } = makeClient({ data: [] })
    await nudgeDueDateIntoVacancy(client, 'org-1', 'prop-1', '2026-09-15')
    expect(filters.some((f) => f.method === 'limit')).toBe(true)
  })

  it('moves the date onto a free day', async () => {
    const { client } = makeClient({ data: [b('2026-09-10', '2026-09-20')] })
    expect(await nudgeDueDateIntoVacancy(client, 'org-1', 'prop-1', '2026-09-12'))
      .toBe('2026-09-09')
  })

  it('FAILS SOFT on a read error — the occurrence outranks its date', async () => {
    // Failing the schedule advance over a scheduling nicety would trade a real
    // occurrence for a better date.
    const { client } = makeClient({ error: { message: 'connection reset' } })
    expect(await nudgeDueDateIntoVacancy(client, 'org-1', 'prop-1', '2026-09-15'))
      .toBe('2026-09-15')
  })

  it('returns the date unchanged for a property with no bookings on file', async () => {
    const { client } = makeClient({ data: [] })
    expect(await nudgeDueDateIntoVacancy(client, 'org-1', 'prop-1', '2026-09-15'))
      .toBe('2026-09-15')
  })
})

describe('nudgeDueDateIntoVacancy — the leading-gap horizon', () => {
  it('a month that opens before the first booking is free from the 1st', async () => {
    // Without a horizon the derivation only emits gaps that open when a guest
    // LEAVES, so a month whose first booking is on the 20th would produce no
    // gap covering the 1st–19th and the date would sit unmoved inside the stay.
    // Booked the 20th–30th. The nearest free day to the 22nd is the 19th,
    // which only exists as a candidate because of the horizon — without it the
    // only gap starts at the 30th checkout and the answer would be the 30th.
    const { client } = makeClient({ data: [b('2026-09-20', '2026-09-30')] })
    expect(await nudgeDueDateIntoVacancy(client, 'org-1', 'prop-1', '2026-09-22'))
      .toBe('2026-09-19')
  })
})

describe('nudgeDueDateIntoVacancy — no accidental sends', () => {
  it('reads bookings and writes nothing', async () => {
    const from = vi.fn(() => {
      const builder: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'in', 'lte', 'gte', 'limit']) builder[m] = () => builder
      builder.then = (r: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(r)
      return builder
    })
    const client = { from } as unknown as SupabaseClient

    await nudgeDueDateIntoVacancy(client, 'org-1', 'prop-1', '2026-09-15')
    expect(from).toHaveBeenCalledTimes(1)
    expect(from).toHaveBeenCalledWith('bookings')
  })
})
