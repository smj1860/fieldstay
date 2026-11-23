import { describe, it, expect } from 'vitest'
import { ACTION_KINDS, type InstructionFacts, type InstructionRecord } from '@/lib/gtm/manager/instructions'
import {
  MAX_PLAN_ACTIONS,
  OPEN_LEAD_GEN_CEILING,
  OPEN_SALES_OPS_CEILING,
  PLAN_REJECTION_COOLDOWN_DAYS,
  TRIGGERS,
  buildPlan,
  describeTrigger,
  recentlyRejectedKinds,
  triggerFires,
} from '@/lib/gtm/manager/triggers'

// ============================================================================
// When an instruction type is warranted. One definition serves two readers (the
// morning plan proposes, a standing run executes), so what matters is that it
// fires on exactly the counts it names, and not inside its minimum gap.
// ============================================================================

const NOW = new Date('2026-11-24T12:20:00Z')
const quiet: InstructionFacts = {
  failedByTeam: {}, rejectedDraftAccounts: 0, ownerrezNeedingContact: 0, waitingForApproval: 0, openLeadGenTasks: 0, openSalesOpsTasks: 0,
}
const busy: InstructionFacts = {
  failedByTeam: { lead_gen: 2, sales_ops: 1 }, rejectedDraftAccounts: 4, ownerrezNeedingContact: 31, waitingForApproval: 0, openLeadGenTasks: 0, openSalesOpsTasks: 0,
}
const fire = (kind: (typeof ACTION_KINDS)[number], facts: InstructionFacts, lastRunAt: string | null = null) =>
  triggerFires(kind, { facts, now: NOW, lastRunAt, cadenceDays: 7 })

describe('condition triggers', () => {
  it('fire on the counts they name and stay quiet without them', () => {
    expect(fire('requeue_failed', busy)).toBe(true)
    expect(fire('redraft_rejected', busy)).toBe(true)
    expect(fire('enrich_ownerrez', busy)).toBe(true)
    for (const kind of ['requeue_failed', 'redraft_rejected', 'enrich_ownerrez'] as const) {
      expect(fire(kind, quiet)).toBe(false)
    }
  })

  it('do not pile onto an unfinished batch', () => {
    expect(fire('redraft_rejected', { ...busy, openSalesOpsTasks: OPEN_SALES_OPS_CEILING })).toBe(false)
    expect(fire('redraft_rejected', { ...busy, openSalesOpsTasks: OPEN_SALES_OPS_CEILING - 1 })).toBe(true)
    expect(fire('enrich_ownerrez', { ...busy, openLeadGenTasks: OPEN_LEAD_GEN_CEILING })).toBe(false)
  })

  it('never fire inside their minimum gap, however true the condition stays', () => {
    expect(fire('requeue_failed', busy, '2026-11-23T20:00:00Z')).toBe(false)   // 16h ago, gap is 24h
    expect(fire('requeue_failed', busy, '2026-11-23T12:00:00Z')).toBe(true)    // 24h20m ago
    expect(fire('redraft_rejected', busy, '2026-11-22T00:00:00Z')).toBe(false) // 60h ago, gap is 72h
    expect(fire('enrich_ownerrez', busy, '2026-11-22T00:00:00Z')).toBe(true)   // 60h ago, gap is 48h
  })

  it('say why, in the counts that made them true', () => {
    const trigger = TRIGGERS.requeue_failed
    expect(trigger.type === 'condition' && trigger.reason(busy)).toBe('3 tasks failed in the last 7 days')
    expect(trigger.type === 'condition' && trigger.reason({ ...quiet, failedByTeam: { lead_gen: 1 } })).toBe('1 task failed in the last 7 days')
  })
})

describe('schedule triggers', () => {
  it('follow the person\'s rhythm, whatever the counts say', () => {
    expect(fire('run_funnel_report', quiet, null)).toBe(true)
    expect(fire('run_funnel_report', quiet, '2026-11-20T12:00:00Z')).toBe(false)
    expect(fire('run_funnel_report', quiet, '2026-11-16T12:00:00Z')).toBe(true)
  })
})

describe('describeTrigger', () => {
  it('says how each type comes due, so a person knows what they would be handing over', () => {
    expect(describeTrigger('requeue_failed', 7)).toBe('Runs when tasks have failed in the last 7 days, at most once a day.')
    expect(describeTrigger('run_funnel_report', 7)).toBe('Repeats about every 7 days, the rhythm you showed.')
    expect(describeTrigger('run_funnel_report', 1)).toBe('Repeats about every 1 day, the rhythm you showed.')
  })
})

describe('buildPlan', () => {
  const base = { facts: busy, now: NOW, lastRunAt: {}, granted: new Set<never>(), recentlyRejected: new Set<never>() }

  it('proposes every warranted condition type, with a reason for each, and never a schedule type', () => {
    const plan = buildPlan(base)
    expect(plan.actions.map((a) => a.kind)).toEqual(['requeue_failed', 'redraft_rejected', 'enrich_ownerrez'])
    expect(plan.reasons).toHaveLength(3)
    expect(plan.reasons[0]).toBe('Retry failed tasks: 3 tasks failed in the last 7 days.')
    expect(plan.actions.map((a) => a.kind)).not.toContain('run_funnel_report')
  })

  it('proposes nothing when nothing is warranted', () => {
    expect(buildPlan({ ...base, facts: quiet })).toEqual({ actions: [], reasons: [] })
  })

  it('leaves out a type a person already handed over: it runs on its own', () => {
    const plan = buildPlan({ ...base, granted: new Set(['requeue_failed'] as const) })
    expect(plan.actions.map((a) => a.kind)).toEqual(['redraft_rejected', 'enrich_ownerrez'])
  })

  it('leaves out a type a person said no to this week', () => {
    const plan = buildPlan({ ...base, recentlyRejected: new Set(['enrich_ownerrez'] as const) })
    expect(plan.actions.map((a) => a.kind)).toEqual(['requeue_failed', 'redraft_rejected'])
  })

  it('respects the minimum gap using the last run or approval from any path', () => {
    const plan = buildPlan({ ...base, lastRunAt: { requeue_failed: '2026-11-24T06:00:00Z' } })
    expect(plan.actions.map((a) => a.kind)).toEqual(['redraft_rejected', 'enrich_ownerrez'])
  })

  it('is capped, so a plan is something to read in one sitting', () => {
    expect(MAX_PLAN_ACTIONS).toBeGreaterThanOrEqual(3)
    expect(buildPlan(base).actions.length).toBeLessThanOrEqual(MAX_PLAN_ACTIONS)
  })
})

describe('recentlyRejectedKinds', () => {
  const rec = (status: string, kinds: string[], decidedAt: string | null, source: InstructionRecord['source'] = 'manager'): InstructionRecord =>
    ({ source, status, kinds, decidedAt })

  it('collects the types rejected inside the cooldown, from a plan or a reply', () => {
    const out = recentlyRejectedKinds([
      rec('rejected', ['requeue_failed'], '2026-11-22T10:00:00Z'),
      rec('rejected', ['enrich_ownerrez'], '2026-11-23T10:00:00Z', 'human'),
    ], NOW)
    expect([...out].sort()).toEqual(['enrich_ownerrez', 'requeue_failed'])
  })

  it('forgets a rejection once the cooldown has passed', () => {
    const old = new Date(NOW.getTime() - (PLAN_REJECTION_COOLDOWN_DAYS + 1) * 86_400_000).toISOString()
    expect(recentlyRejectedKinds([rec('rejected', ['requeue_failed'], old)], NOW).size).toBe(0)
  })

  it('ignores approvals, undecided rows and the manager\'s own standing runs', () => {
    expect(recentlyRejectedKinds([
      rec('applied', ['requeue_failed'], '2026-11-23T10:00:00Z'),
      rec('rejected', ['requeue_failed'], null),
      rec('rejected', ['requeue_failed'], '2026-11-23T10:00:00Z', 'standing'),
    ], NOW).size).toBe(0)
  })
})
