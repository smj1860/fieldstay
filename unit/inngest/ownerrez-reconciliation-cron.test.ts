import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { ownerRezReconciliationCron } from '@/lib/inngest/functions/ownerrez/reconciliation-cron'
import { createServiceClient } from '@/lib/supabase/server'
import { invokeHandler } from './test-helpers'
import { createSupabaseDouble, type TableSpec } from '../stubs/supabase-query-double'

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}

function makeStep() {
  return {
    run:       vi.fn((_name: string, cb: () => unknown) => cb()),
    sendEvent: vi.fn(async () => undefined),
  }
}


// Queue-based .from(table) mock — see ownerrez-incremental-sync.test.ts for
// the canonical explanation. eqSpy/notSpy record every filter used so the
// scoping assertions below can prove exactly which connections this cron
// dispatches to, without depending on internal query-builder call order.
// The ONE shared query-builder double, not a local hand-roll — its eqSpy /
// notSpy carry the same (table, ...args) convention the scoping assertions
// below already used. The local version modelled only .select/.eq/.not, so it
// broke the moment this cron's connection read was paginated onto
// .order().range(); that divergence is what the shared stub exists to end. It
// also paginates for real, so a >1000-connection fixture is genuinely walked.
const makeSupabase = (tables: Record<string, TableSpec>) => createSupabaseDouble(tables)

describe('ownerRezReconciliationCron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('dispatches one integration/ownerrez.reconcile.requested event per active connection', async () => {
    const supabase = makeSupabase({
      integration_connections: [
        {
          data: [
            { user_id: 'user_1', org_id: 'org_1' },
            { user_id: 'user_2', org_id: 'org_2' },
          ],
          error: null,
        },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()

    const result = await invokeHandler(ownerRezReconciliationCron, {
      event:  {},
      step,
      logger: makeLogger(),
    })

    expect(step.sendEvent).toHaveBeenCalledWith('dispatch-reconciliation-events', [
      { name: 'integration/ownerrez.reconcile.requested', data: { user_id: 'user_1', org_id: 'org_1' } },
      { name: 'integration/ownerrez.reconcile.requested', data: { user_id: 'user_2', org_id: 'org_2' } },
    ])
    expect(result).toEqual({ dispatched: 2 })
  })

  it('is a no-op when there are no active OwnerRez connections — no event dispatched', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: [], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const step = makeStep()

    const result = await invokeHandler(ownerRezReconciliationCron, {
      event:  {},
      step,
      logger: makeLogger(),
    })

    expect(step.sendEvent).not.toHaveBeenCalled()
    expect(result).toEqual({ dispatched: 0 })
  })

  it('scopes the connection query to active OwnerRez connections with a non-null org_id — excludes revoked connections and connections never assigned an org', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: [{ user_id: 'user_1', org_id: 'org_1' }], error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(ownerRezReconciliationCron, {
      event:  {},
      step:   makeStep(),
      logger: makeLogger(),
    })

    expect(supabase.eqSpy).toHaveBeenCalledWith('integration_connections', 'provider_id', 'ownerrez')
    expect(supabase.eqSpy).toHaveBeenCalledWith('integration_connections', 'status', 'active')
    expect(supabase.notSpy).toHaveBeenCalledWith('integration_connections', 'org_id', 'is', null)
  })
})
