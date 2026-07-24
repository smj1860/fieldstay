import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { vendorComplianceExpiryCheck } from '@/lib/inngest/functions/cron/vendor-compliance-expiry-check'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock — see checklist-broadcast.test.ts for the
// reference pattern. This function only queries `vendor_compliance_documents`
// once per run (the update is a separate per-document call to the same
// table), so order still matters across the outer select and each per-doc
// update.
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
    chain.gte    = (...a: unknown[]) => record('gte', a)
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
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()), sendEvent: vi.fn() }
}

describe('vendorComplianceExpiryCheck', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-22T00:00:00.000Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('marks a newly-entering document warned, audit-logs it, and emits one expiry-warning event', async () => {
    const supabase = makeSupabase({
      vendor_compliance_documents: [
        {
          data: [
            {
              id: 'doc_1', org_id: 'org_1', vendor_id: 'v1', document_type: 'coi',
              expiry_date: '2026-08-01', vendors: { name: 'Acme Plumbing' },
            },
          ],
          error: null,
        },
        { data: { id: 'doc_1' }, error: null }, // update succeeds — this run flips the gate
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(vendorComplianceExpiryCheck, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ checked: 1 })

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId:      'org_1',
        action:     'vendor.compliance.expiry_warned',
        targetId:   'doc_1',
        metadata:   expect.objectContaining({
          vendor_id:     'v1',
          document_type: 'coi',
          expiry_date:   '2026-08-01',
          days_until:    10, // 2026-07-22T00:00Z -> 2026-08-01T00:00Z
        }),
      }),
    )

    expect(step.sendEvent).toHaveBeenCalledWith(
      'emit-expiry-warning-doc_1',
      {
        name: 'vendor-compliance/expiry-warning',
        data: expect.objectContaining({
          document_id: 'doc_1',
          vendor_id:   'v1',
          org_id:      'org_1',
          vendor_name: 'Acme Plumbing',
          days_until:  10,
        }),
      },
    )

    const updateCall = supabase.calls.find(
      (c) => c.table === 'vendor_compliance_documents' && c.method === 'update',
    )
    expect(updateCall?.args[0]).toMatchObject({ first_warned_at: expect.any(String) })
  })

  it('is a no-op when no document is entering the expiring-soon window', async () => {
    const supabase = makeSupabase({
      vendor_compliance_documents: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(vendorComplianceExpiryCheck, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(result).toEqual({ checked: 0 })
    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('idempotency: does not re-warn or re-emit a document another concurrent run already flagged', async () => {
    const supabase = makeSupabase({
      vendor_compliance_documents: [
        {
          data: [
            {
              id: 'doc_2', org_id: 'org_1', vendor_id: 'v2', document_type: 'bonding',
              expiry_date: '2026-08-05', vendors: { name: 'Bond Co' },
            },
          ],
          error: null,
        },
        // Another run already flipped first_warned_at — the `.is('first_warned_at', null)`
        // precondition no longer matches, so maybeSingle() returns null data.
        { data: null, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()
    const result = await invokeHandler(vendorComplianceExpiryCheck, {
      event:  {},
      step,
      logger: { info: vi.fn(), error: vi.fn() },
    })

    // Still "checked" — the found-but-already-warned document counts toward
    // the query result, it just isn't (re-)emitted or (re-)logged.
    expect(result).toEqual({ checked: 1 })
    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('queries the exact 30-day expiring-soon window from today', async () => {
    const supabase = makeSupabase({
      vendor_compliance_documents: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(vendorComplianceExpiryCheck, {
      event:  {},
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    const gte = supabase.calls.find((c) => c.method === 'gte' && c.args[0] === 'expiry_date')
    const lte = supabase.calls.find((c) => c.method === 'lte' && c.args[0] === 'expiry_date')
    expect(gte?.args[1]).toBe('2026-07-22')
    expect(lte?.args[1]).toBe('2026-08-21') // today + 30 days
  })
})
