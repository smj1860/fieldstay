import { describe, it, expect } from 'vitest'
import { DECISION_RULES, buildSettingsUpdate, isDecision } from '@/lib/gtm/validate'

describe('buildSettingsUpdate', () => {
  it('accepts a valid edit to a worker team', () => {
    expect(buildSettingsUpdate('lead_gen', { enabled: true, daily_task_cap: 25, daily_cost_cap_cents: 300 })).toEqual({
      team: 'lead_gen', update: { enabled: true, daily_task_cap: 25, daily_cost_cap_cents: 300 },
    })
  })

  it('refuses an unknown team', () => {
    expect(buildSettingsUpdate('interns', { enabled: true })).toEqual({ error: 'Unknown team.' })
  })

  it('refuses an enabled value that is not a real boolean', () => {
    expect(buildSettingsUpdate('lead_gen', { enabled: 'true' })).toHaveProperty('error')
    expect(buildSettingsUpdate('lead_gen', { enabled: 1 })).toHaveProperty('error')
  })

  // A typo must not become an unbounded run.
  it.each([-1, 1.5, '5', null, Number.NaN, 10_001])('refuses a task cap of %j', (cap) => {
    expect(buildSettingsUpdate('lead_gen', { daily_task_cap: cap })).toHaveProperty('error')
  })

  it.each([-1, 0.5, '100', 100_001])('refuses a spend cap of %j', (cap) => {
    expect(buildSettingsUpdate('lead_gen', { daily_cost_cap_cents: cap })).toHaveProperty('error')
  })

  it('allows a cap of zero, which means do nothing today', () => {
    expect(buildSettingsUpdate('lead_gen', { daily_task_cap: 0 })).toEqual({ team: 'lead_gen', update: { daily_task_cap: 0 } })
  })

  it('lets the master switch be a switch and nothing more', () => {
    expect(buildSettingsUpdate('global', { enabled: false })).toEqual({ team: 'global', update: { enabled: false } })
    expect(buildSettingsUpdate('global', { daily_task_cap: 5 })).toHaveProperty('error')
    expect(buildSettingsUpdate('global', { autonomy: 'propose_only' })).toHaveProperty('error')
  })

  it('keeps the manager observe-only, since routing is not built', () => {
    expect(buildSettingsUpdate('manager', { autonomy: 'propose_only' })).toHaveProperty('update')
    expect(buildSettingsUpdate('manager', { autonomy: 'auto_low_risk' })).toHaveProperty('error')
    expect(buildSettingsUpdate('sales_ops', { autonomy: 'auto_low_risk' })).toHaveProperty('update')
  })

  it('refuses an empty edit and an unknown autonomy', () => {
    expect(buildSettingsUpdate('lead_gen', {})).toEqual({ error: 'Nothing to change.' })
    expect(buildSettingsUpdate('lead_gen', { autonomy: 'yolo' })).toHaveProperty('error')
  })
})

describe('decisions', () => {
  it('recognises only the three decisions', () => {
    expect(['approve', 'reject', 'cancel'].every(isDecision)).toBe(true)
    expect(isDecision('delete')).toBe(false)
  })

  it('lets only a waiting item be approved or rejected', () => {
    expect(DECISION_RULES.approve.from).toEqual(['needs_approval'])
    expect(DECISION_RULES.reject.from).toEqual(['needs_approval'])
  })

  it('never lets a running or finished task be cancelled from the inbox', () => {
    for (const bad of ['in_progress', 'done', 'failed', 'rejected', 'cancelled']) {
      expect(DECISION_RULES.cancel.from).not.toContain(bad)
    }
  })
})
