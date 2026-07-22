import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent:  vi.fn(),
  logAuditEvents: vi.fn(),
}))

import { vendorComplianceGraceCheck } from '@/lib/inngest/functions/cron/vendor-compliance-grace-check'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent, logAuditEvents } from '@/lib/audit'
import { invokeHandler } from './test-helpers'

// Cron function — the real event has no meaningful `data` the handler reads
// (it only queries by wall-clock date), so `event` is passed as `{}` below,
// mirroring how Inngest actually invokes a cron trigger.

// Queue-based `.from(table)` mock — same convention as checklist-broadcast
// and auto-assign-turnover: each `.from(table)` call consumes the next
// queued response for that table, in call order. This function calls
// `.from('vendor_compliance_documents')` three times per run with a
// hard-block candidate present (grace-docs select, hard-block-candidates
// select, then one update per candidate) so a fixed per-table response
// isn't enough — order matters.
function makeSupabase(queued: Record<string, { data?: unknown; error?: unknown }[]>) {
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
    chain.lte    = (...a: unknown[]) => record('lte', a)
    chain.update = (...a: unknown[]) => record('update', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.maybeSingle = () => resolveNext()
    chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      resolveNext().then(resolve, reject)
    return chain
  })

  return { from, calls }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

describe('vendorComplianceGraceCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('logs a grace-period-entered audit event and hard-blocks a newly-crossed document', async () => {
    const supabase = makeSupabase({
      vendor_compliance_documents: [
        {
          data: [
            { id: 'doc_grace', org_id: 'org_1', vendor_id: 'v1', document_type: 'coi', expiry_date: '2026-07-21' },
          ],
          error: null,
        },
        {
          data: [
            { id: 'doc_block', org_id: 'org_1', vendor_id: 'v2', document_type: 'workers_comp', expiry_date: '2026-06-01' },
          ],
          error: null,
        },
        { data: { id: 'doc_block' }, error: null }, // update succeeds — this run flips the gate
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(vendorComplianceGraceCheck, {
      event: {},
      step:  makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ grace_period_entries: 1, hard_block_candidates: 1 })

    expect(logAuditEvents).toHaveBeenCalledWith([
      expect.objectContaining({
        orgId:      'org_1',
        action:     'vendor.compliance.grace_period_entered',
        targetId:   'doc_grace',
        metadata:   expect.objectContaining({ vendor_id: 'v1', document_type: 'coi' }),
      }),
    ])

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId:      'org_1',
        action:     'vendor.compliance.hard_blocked',
        targetId:   'doc_block',
        metadata:   expect.objectContaining({ vendor_id: 'v2', document_type: 'workers_comp' }),
      }),
    )

    const updateCall = supabase.calls.find(
      (c) => c.table === 'vendor_compliance_documents' && c.method === 'update',
    )
    expect(updateCall?.args[0]).toMatchObject({ hard_blocked_at: expect.any(String) })
  })

  it('is a no-op when nothing enters the grace period and nothing crosses into hard-block', async () => {
    const supabase = makeSupabase({
      vendor_compliance_documents: [
        { data: [], error: null }, // grace docs
        { data: [], error: null }, // hard-block candidates
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(vendorComplianceGraceCheck, {
      event: {},
      step:  makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ grace_period_entries: 0, hard_block_candidates: 0 })
    expect(logAuditEvents).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
    // No per-document mark-hard-blocked step ran.
    expect(supabase.calls.some((c) => c.method === 'update')).toBe(false)
  })

  it('idempotency: does not re-log a document another concurrent run already hard-blocked', async () => {
    const supabase = makeSupabase({
      vendor_compliance_documents: [
        { data: [], error: null }, // grace docs empty
        {
          data: [
            { id: 'doc_race', org_id: 'org_1', vendor_id: 'v3', document_type: 'coi', expiry_date: '2026-05-01' },
          ],
          error: null,
        },
        // The gate was already flipped by another run — the `.is('hard_blocked_at', null)`
        // precondition in the WHERE clause no longer matches, so maybeSingle() finds
        // nothing to update and returns null data.
        { data: null, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(vendorComplianceGraceCheck, {
      event: {},
      step:  makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ grace_period_entries: 0, hard_block_candidates: 1 })
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  describe('45/46-day grace-to-hard-block boundary date math', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-07-22T12:00:00.000Z'))
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('queries expiry_date = yesterday for grace-period entry and expiry_date <= today-46 for hard-block', async () => {
      const supabase = makeSupabase({
        vendor_compliance_documents: [
          { data: [], error: null },
          { data: [], error: null },
        ],
      })
      ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

      await invokeHandler(vendorComplianceGraceCheck, {
        event: {},
        step:  makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      })

      // "Today" is 2026-07-22 — grace-period entry looks at exactly yesterday.
      const graceEq = supabase.calls.find(
        (c) => c.table === 'vendor_compliance_documents' && c.method === 'eq' && c.args[0] === 'expiry_date',
      )
      expect(graceEq?.args[1]).toBe('2026-07-21')

      // Hard-block cutoff is exactly 46 days back — a document expired only
      // 45 days ago must NOT be swept up by this query (it belongs to the
      // grace_period status, not hard_blocked, per the 45/46-day boundary
      // in vendor_compliance_status).
      const hardBlockLte = supabase.calls.find(
        (c) => c.table === 'vendor_compliance_documents' && c.method === 'lte' && c.args[0] === 'expiry_date',
      )
      expect(hardBlockLte?.args[1]).toBe('2026-06-06')

      const fortyFiveDaysAgo = '2026-06-07'
      expect(hardBlockLte?.args[1]).not.toBe(fortyFiveDaysAgo)
      expect(hardBlockLte?.args[1] as string < fortyFiveDaysAgo).toBe(true)
    })
  })
})
