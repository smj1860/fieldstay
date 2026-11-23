import { describe, it, expect } from 'vitest'
import {
  AUTO_APPROVABLE, budgetVerdict, centralDateKey, centralDayStart, childDepth, estimateCostCents, finishStatus, isTeamRunnable, isWorkingHours, managerApproves,
  type TeamSetting,
} from '@/lib/gtm/policy'
import { MAX_TASK_DEPTH, type SettingsTeam } from '@/lib/gtm/constants'

const row = (team: SettingsTeam, enabled: boolean): TeamSetting => ({
  team, enabled, autonomy: 'propose_only', daily_task_cap: 50, daily_cost_cap_cents: 500,
})

describe('isTeamRunnable', () => {
  it('needs BOTH the master switch and the team on', () => {
    expect(isTeamRunnable([row('global', true), row('lead_gen', true)], 'lead_gen')).toBe(true)
    expect(isTeamRunnable([row('global', false), row('lead_gen', true)], 'lead_gen')).toBe(false)
    expect(isTeamRunnable([row('global', true), row('lead_gen', false)], 'lead_gen')).toBe(false)
  })

  // The inverse default would let an empty or unreadable settings table switch every agent on.
  it('reads a missing row as OFF, never on', () => {
    expect(isTeamRunnable([], 'lead_gen')).toBe(false)
    expect(isTeamRunnable([row('global', true)], 'lead_gen')).toBe(false)
    expect(isTeamRunnable([row('lead_gen', true)], 'lead_gen')).toBe(false)
  })
})

describe('childDepth', () => {
  it('starts a manager or human origin at 0 and counts each handoff', () => {
    expect(childDepth(null)).toBe(0)
    expect(childDepth(0)).toBe(1)
    expect(childDepth(MAX_TASK_DEPTH - 1)).toBe(MAX_TASK_DEPTH)
  })

  it('refuses to go past the ceiling, and refuses nonsense', () => {
    expect(childDepth(MAX_TASK_DEPTH)).toBeNull()
    expect(childDepth(-1)).toBeNull()
    expect(childDepth(1.5)).toBeNull()
  })

  it('matches the CHECK in the schema', () => {
    expect(MAX_TASK_DEPTH).toBe(4)
  })
})

describe('budgetVerdict', () => {
  const base = { tasksToday: 0, taskCap: 10, spentCents: 0, costCapCents: 100 }

  it('is ok under both ceilings', () => {
    expect(budgetVerdict(base)).toBe('ok')
  })

  it('stops at a ceiling rather than one past it', () => {
    expect(budgetVerdict({ ...base, tasksToday: 10 })).toBe('task_cap')
    expect(budgetVerdict({ ...base, spentCents: 100 })).toBe('cost_cap')
  })

  it('reports the spend ceiling first, since it is the one that bills', () => {
    expect(budgetVerdict({ ...base, tasksToday: 10, spentCents: 100 })).toBe('cost_cap')
  })

  // A cap of 0 must mean "do nothing today", not "unlimited".
  it('treats a cap of zero as no work allowed', () => {
    expect(budgetVerdict({ ...base, taskCap: 0 })).toBe('task_cap')
    expect(budgetVerdict({ ...base, costCapCents: 0 })).toBe('cost_cap')
  })
})

describe('finishStatus', () => {
  it('lets a propose-only team finish nothing itself, whatever the task says', () => {
    expect(finishStatus({ requiresApproval: false, autonomy: 'propose_only' })).toBe('needs_approval')
    expect(finishStatus({ requiresApproval: true,  autonomy: 'propose_only' })).toBe('needs_approval')
  })

  it('lets the per-task flag ask for MORE review, never less', () => {
    expect(finishStatus({ requiresApproval: true,  autonomy: 'auto_low_risk' })).toBe('needs_approval')
    expect(finishStatus({ requiresApproval: false, autonomy: 'auto_low_risk' })).toBe('done')
  })
})

describe('estimateCostCents', () => {
  it('prices a Haiku call from the reported tokens', () => {
    // 1,000 in at $1/M + 500 out at $5/M = $0.0035 = 0.35 cents
    expect(estimateCostCents('claude-haiku-4-5-20251001', 1_000, 500)).toBe(0.35)
  })

  it('prices an unknown model at the dearest rate so a cap errs toward stopping', () => {
    const unknown = estimateCostCents('some-new-model', 1_000_000, 0)
    expect(unknown).toBe(estimateCostCents('claude-opus-9', 1_000_000, 0))
    expect(unknown).toBeGreaterThan(estimateCostCents('claude-haiku-4-5', 1_000_000, 0))
  })

  it('never returns a negative amount', () => {
    expect(estimateCostCents('claude-haiku', -5, -5)).toBe(0)
  })
})

describe('the Central Time day the caps reset on', () => {
  it('starts the day at local midnight, in standard time', () => {
    // 20:00Z in November is 14:00 CST (UTC-6), so the day began at 06:00Z.
    expect(centralDayStart(new Date('2026-11-18T20:00:00Z')).toISOString()).toBe('2026-11-18T06:00:00.000Z')
  })

  it('starts the day at local midnight, in daylight time', () => {
    // 20:00Z in July is 15:00 CDT (UTC-5), so the day began at 05:00Z.
    expect(centralDayStart(new Date('2026-07-15T20:00:00Z')).toISOString()).toBe('2026-07-15T05:00:00.000Z')
  })

  it('keeps an early-UTC instant on the previous Central day', () => {
    // 03:00Z on the 19th is still 21:00 CST on the 18th.
    expect(centralDateKey(new Date('2026-11-19T03:00:00Z'))).toBe('2026-11-18')
    expect(centralDayStart(new Date('2026-11-19T03:00:00Z')).toISOString()).toBe('2026-11-18T06:00:00.000Z')
  })

  it('gives the same key for every instant of one Central day', () => {
    expect(centralDateKey(new Date('2026-11-18T06:00:00Z'))).toBe(centralDateKey(new Date('2026-11-19T05:59:59Z')))
  })
})

describe('managerApproves', () => {
  const auto = (team: SettingsTeam): TeamSetting => ({ ...row(team, true), autonomy: 'auto_low_risk' })
  const on = [row('global', true), row('manager', true), auto('lead_gen'), auto('rev_ops'), auto('sales_ops')]

  it('approves the three low-risk task types when the team is set to auto and the manager is running', () => {
    expect(managerApproves(on, 'lead_gen', 'enrich_account')).toBe(true)
    expect(managerApproves(on, 'lead_gen', 'queue_candidates')).toBe(true)
    expect(managerApproves(on, 'rev_ops', 'weekly_funnel_report')).toBe(true)
  })

  // The last step of an email is a person's. A Sales Ops team set to auto still gets none of its work approved.
  it('NEVER approves a Sales Ops draft or call brief, however the team is set', () => {
    expect(managerApproves(on, 'sales_ops', 'draft_outreach')).toBe(false)
    expect(managerApproves(on, 'sales_ops', 'call_brief')).toBe(false)
    expect([...AUTO_APPROVABLE].some((k) => k.startsWith('sales_ops/'))).toBe(false)
  })

  it('needs the team set to auto: turning an agent on does not by itself turn auto-approval on', () => {
    const propose = [row('global', true), row('manager', true), row('lead_gen', true)]
    expect(managerApproves(propose, 'lead_gen', 'enrich_account')).toBe(false)
  })

  it('needs the manager itself running, and the master switch', () => {
    expect(managerApproves([row('global', true), row('manager', false), auto('lead_gen')], 'lead_gen', 'enrich_account')).toBe(false)
    expect(managerApproves([row('global', false), row('manager', true), auto('lead_gen')], 'lead_gen', 'enrich_account')).toBe(false)
    expect(managerApproves([auto('lead_gen')], 'lead_gen', 'enrich_account')).toBe(false)
  })

  it('does not approve a task type that is not on the list', () => {
    expect(managerApproves(on, 'lead_gen', 'anything_else')).toBe(false)
  })
})

describe('isWorkingHours (8am to 6pm Central)', () => {
  // November is CST (UTC-6); July is CDT (UTC-5), so the same wall-clock hour is a different UTC hour.
  it.each([
    ['2026-11-19T13:59:59Z', false], // 7:59am CST
    ['2026-11-19T14:00:00Z', true],  // 8:00am CST
    ['2026-11-19T23:59:59Z', true],  // 5:59pm CST
    ['2026-11-20T00:00:00Z', false], // 6:00pm CST
    ['2026-07-15T12:59:59Z', false], // 7:59am CDT
    ['2026-07-15T13:00:00Z', true],  // 8:00am CDT
    ['2026-07-15T22:59:59Z', true],  // 5:59pm CDT
    ['2026-07-15T23:00:00Z', false], // 6:00pm CDT
  ])('%s -> %s', (iso, expected) => {
    expect(isWorkingHours(new Date(iso))).toBe(expected)
  })
})
