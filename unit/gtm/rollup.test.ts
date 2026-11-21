import { describe, it, expect } from 'vitest'
import { EMPTY_ROLLUP, fetchRollup, openTaskCount, parseRollup, spentTodayCents, taskCount } from '@/lib/gtm/rollup'

describe('parseRollup', () => {
  it('reads the shape gtm_dashboard_counts returns', () => {
    const r = parseRollup({
      funnel:  { new: 2, replied: '1' },
      touches: { emailed: 4 },
      tasks:   [{ team: 'lead_gen', status: 'pending', count: 3 }, { team: 'lead_gen', status: 'needs_approval', count: 2 }],
      spend:   [{ team: 'manager', cost_cents: '1.5', calls: 2 }],
      stale_approvals: 1,
    })
    expect(r.funnel).toEqual({ new: 2, replied: 1 })
    expect(r.touches).toEqual({ emailed: 4 })
    expect(taskCount(r, 'lead_gen', 'pending')).toBe(3)
    expect(openTaskCount(r, 'lead_gen')).toBe(5)
    expect(spentTodayCents(r, 'manager')).toBe(1.5)
    expect(r.staleApprovals).toBe(1)
  })

  // A dashboard that shows a zero for a field it could not parse is wrong in a
  // visible way. One that throws hides the rest of the page.
  it.each([null, undefined, 'x', 7, [], [1]])('narrows %j to an empty rollup rather than throwing', (bad) => {
    expect(parseRollup(bad)).toEqual(EMPTY_ROLLUP)
  })

  it('drops rows it does not recognise and keeps the ones it does', () => {
    const r = parseRollup({
      tasks: [{ team: 'intern', status: 'pending', count: 9 }, { team: 'rev_ops', status: 'shipped', count: 9 }, { team: 'rev_ops', status: 'done', count: 1 }],
      spend: [{ team: 'global', cost_cents: 5, calls: 1 }, { team: 'rev_ops', cost_cents: 2, calls: 1 }],
    })
    expect(r.tasks).toEqual([{ team: 'rev_ops', status: 'done', count: 1 }])
    expect(r.spend).toEqual([{ team: 'rev_ops', cost_cents: 2, calls: 1 }])
  })

  it('reads garbage numbers as zero instead of NaN', () => {
    expect(parseRollup({ funnel: { new: 'lots' }, stale_approvals: 'many' }).funnel).toEqual({ new: 0 })
    expect(parseRollup({ stale_approvals: 'many' }).staleApprovals).toBe(0)
  })
})

describe('fetchRollup', () => {
  const window = { touchesSince: new Date('2026-11-11T00:00:00Z'), spendSince: new Date('2026-11-18T06:00:00Z') }
  const client = (result: { data: unknown; error: { message: string } | null }) => ({
    rpc: (...args: unknown[]) => { calls.push(args); return Promise.resolve(result) },
  }) as never
  const calls: unknown[][] = []

  it('passes both window starts to the function as ISO strings', async () => {
    const res = await fetchRollup(client({ data: { funnel: { new: 1 } }, error: null }), window)
    expect(res).toMatchObject({ ok: true })
    expect(calls.at(-1)).toEqual(['gtm_dashboard_counts', {
      p_touches_since: '2026-11-11T00:00:00.000Z',
      p_spend_since:   '2026-11-18T06:00:00.000Z',
    }])
  })

  it('reports a failed call instead of returning zeros that look like an empty funnel', async () => {
    expect(await fetchRollup(client({ data: null, error: { message: 'permission denied' } }), window))
      .toEqual({ ok: false, error: 'permission denied' })
  })
})
