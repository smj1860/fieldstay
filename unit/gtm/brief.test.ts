import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildMetrics, mayNarrate, narrationFacts, renderBrief, renderFacts } from '@/lib/gtm/manager/brief'
import { parseRollup } from '@/lib/gtm/rollup'
import type { TeamSetting } from '@/lib/gtm/policy'
import type { SettingsTeam } from '@/lib/gtm/constants'

const NOW = new Date('2026-11-18T12:00:00Z')
const setting = (team: SettingsTeam, enabled: boolean): TeamSetting => ({
  team, enabled, autonomy: 'propose_only', daily_task_cap: 50, daily_cost_cap_cents: 500,
})
const ALL_OFF = (['global', 'manager', 'lead_gen', 'content_brand', 'sales_ops', 'rev_ops'] as const).map((t) => setting(t, false))
const rollup = parseRollup({
  funnel:  { new: 100, researching: 20, replied: 5, meeting_set: 2, in_trial: 1, won: 3, lost: 10, disqualified: 4 },
  touches: { emailed: 40, called: 5, replied: 8 },
  tasks:   [{ team: 'lead_gen', status: 'needs_approval', count: 4 }, { team: 'lead_gen', status: 'pending', count: 2 }, { team: 'sales_ops', status: 'failed', count: 1 }],
  spend:   [{ team: 'manager', cost_cents: 12.5, calls: 2 }],
  stale_approvals: 2,
})

describe('buildMetrics', () => {
  const m = buildMetrics(rollup, ALL_OFF, NOW)

  it('counts accounts still in play as everything not won, lost or disqualified', () => {
    expect(m.funnelTotal).toBe(145)
    expect(m.funnelActive).toBe(128)
  })

  it('carries the headline stages and the 7-day touches', () => {
    expect([m.replied, m.meetingSet, m.inTrial, m.won]).toEqual([5, 2, 1, 3])
    expect(m.touches7d).toEqual({ emailed: 40, called: 5, replied: 8 })
  })

  it('rolls queue state up per team', () => {
    const lead = m.queue.find((q) => q.team === 'lead_gen')!
    expect(lead).toMatchObject({ open: 6, pending: 2, needsApproval: 4 })
    expect(m.needsApproval).toBe(4)
    expect(m.staleApprovals).toBe(2)
    expect(m.queue.find((q) => q.team === 'sales_ops')!.failed).toBe(1)
  })

  it('reports nothing as running while everything is off', () => {
    expect(m.masterOn).toBe(false)
    expect(m.managerOn).toBe(false)
    expect(m.runningTeams).toEqual([])
  })

  it('lists only teams that are really runnable, so a team held by the master switch is not "running"', () => {
    const settings = ALL_OFF.map((s) => (s.team === 'lead_gen' ? { ...s, enabled: true } : s))
    expect(buildMetrics(rollup, settings, NOW).runningTeams).toEqual([])
    const withMaster = settings.map((s) => (s.team === 'global' ? { ...s, enabled: true } : s))
    expect(buildMetrics(rollup, withMaster, NOW).runningTeams).toEqual(['lead_gen'])
  })

  it('handles a brand-new system with nothing in it', () => {
    const empty = buildMetrics(parseRollup({}), [], NOW)
    expect(empty.funnelTotal).toBe(0)
    expect(renderFacts(empty)).toContain('0 accounts')
  })
})

describe('renderFacts', () => {
  const facts = renderFacts(buildMetrics(rollup, ALL_OFF, NOW))

  it('states the pipeline, the week, the agents, the queues, the spend and what needs a person', () => {
    expect(facts).toContain('Pipeline: 145 accounts, 128 still in play.')
    expect(facts).toContain('Last 7 days: 40 emailed, 5 called, 0 texted, 8 replies (20% of emails).')
    expect(facts).toContain('the master switch is off, so no team is running')
    expect(facts).toContain('Lead Gen: 6 open, 4 need approval')
    expect(facts).toContain('Spend today: $0.13 of $25.00')
    expect(facts).toContain('Needs you: 4 items waiting for approval, 2 waiting more than 48 hours.')
  })

  it('says plainly that the manager has acted on nothing', () => {
    expect(facts).toContain('observe-only')
    expect(facts).toContain('created no tasks')
  })

  it('omits the "needs you" line when nothing is waiting', () => {
    expect(renderFacts(buildMetrics(parseRollup({ funnel: { new: 1 } }), ALL_OFF, NOW))).not.toContain('Needs you')
  })

  it('never divides by zero when nothing was emailed', () => {
    expect(renderFacts(buildMetrics(parseRollup({}), ALL_OFF, NOW))).not.toMatch(/NaN|Infinity|%/)
  })

  // Copy a person reads must not carry an em dash, whatever the numbers are.
  it('contains no em dash', () => {
    expect(facts).not.toContain('—')
  })
})

describe('renderBrief', () => {
  const m = buildMetrics(rollup, ALL_OFF, NOW)

  it('leads with the kind and date, then the narrative, then the facts', () => {
    const brief = renderBrief('morning_plan', m, 'A quiet morning.')
    expect(brief.startsWith('Morning plan, 2026-11-18')).toBe(true)
    expect(brief.indexOf('A quiet morning.')).toBeLessThan(brief.indexOf('Pipeline:'))
  })

  // The facts are the brief. The narrative is decoration that may not exist.
  it('is complete with no narrative at all', () => {
    const brief = renderBrief('manual', m, null)
    expect(brief).toContain('Pipeline:')
    expect(brief).not.toContain('null')
  })
})

describe('mayNarrate', () => {
  const ok = { managerRunnable: true, spentCents: 0, capCents: 100, hasApiKey: true }
  it('allows a model call only when the manager is on, keyed and under its cap', () => {
    expect(mayNarrate(ok)).toBe(true)
    expect(mayNarrate({ ...ok, managerRunnable: false })).toBe(false)
    expect(mayNarrate({ ...ok, hasApiKey: false })).toBe(false)
    expect(mayNarrate({ ...ok, spentCents: 100 })).toBe(false)
    expect(mayNarrate({ ...ok, capCents: 0 })).toBe(false)
  })
})

describe('narrationFacts', () => {
  const facts = narrationFacts(buildMetrics(rollup, ALL_OFF, NOW))

  // An allowlist, not a pattern: a new field reaching the model should be a
  // decision someone made here, not a side effect of adding it to the metrics.
  it('hands the model exactly these counts and nothing else', () => {
    expect(Object.keys(facts).sort()).toEqual([
      'accounts_in_play', 'accounts_total', 'approvals_over_48h', 'approvals_waiting', 'in_trial',
      'master_switch_on', 'meetings_set', 'queue', 'replied', 'spend_today_cents',
      'teams_running', 'touches_last_7_days', 'won',
    ])
  })

  it('carries only numbers, flags and team names: no account, contact or address', () => {
    expect(JSON.stringify(facts)).not.toContain('@')
    const scalars = JSON.stringify(facts).match(/"[^"]*":("[^"]*")/g) ?? []
    // The only strings in the payload are team names and status words.
    for (const s of scalars) expect(s).toMatch(/"(team)":"(lead_gen|content_brand|sales_ops|rev_ops)"/)
  })
})

describe('narrateBrief', () => {
  const create = vi.fn()
  beforeEach(() => { vi.resetModules(); create.mockReset() })

  async function load() {
    vi.doMock('@/lib/support/anthropic-client', () => ({ getAnthropicClient: () => ({ messages: { create } }) }))
    vi.doMock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
    return import('@/lib/gtm/manager/narrate')
  }
  const metrics = buildMetrics(rollup, ALL_OFF, NOW)

  it('returns the text, the model and the token counts to bill', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: ' All quiet. ' }], usage: { input_tokens: 300, output_tokens: 40 } })
    const { narrateBrief, MANAGER_MODEL } = await load()
    expect(await narrateBrief(metrics)).toEqual({ ok: true, text: 'All quiet.', model: MANAGER_MODEL, inputTokens: 300, outputTokens: 40 })
    // A timeout is passed, so a hung call cannot hang the cron.
    expect(create.mock.calls[0][1]).toMatchObject({ timeout: expect.any(Number) })
  })

  it('removes any em dash the model produced anyway', async () => {
    create.mockResolvedValue({ content: [{ type: 'text', text: 'Calm — nothing to do.' }], usage: { input_tokens: 1, output_tokens: 1 } })
    const { narrateBrief } = await load()
    const res = await narrateBrief(metrics)
    expect(res.ok && res.text).toBe('Calm , nothing to do.')
  })

  it('degrades to "no narrative" on an empty answer or an API failure, never a thrown error', async () => {
    const { narrateBrief } = await load()
    create.mockResolvedValue({ content: [], usage: { input_tokens: 1, output_tokens: 0 } })
    expect(await narrateBrief(metrics)).toEqual({ ok: false, reason: 'no_text' })
    create.mockRejectedValue(new Error('overloaded'))
    expect(await narrateBrief(metrics)).toEqual({ ok: false, reason: 'error' })
  })
})
