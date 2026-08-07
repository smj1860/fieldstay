import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import { hospPropertyMerge } from '@/lib/inngest/functions/hospitable/property-merge'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { invokeHandler } from './test-helpers'

// The whole function is a single step.run('remap-or-flag', ...) — running it
// for real (rather than an allowlist stub) exercises the actual
// select/select/update control flow, with only Supabase and the audit
// logger mocked at the module boundary.
function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function makeLogger() {
  return { info: vi.fn(), error: vi.fn() }
}

interface QueuedByTable { [table: string]: { data?: unknown; error?: unknown }[] }

// Queue-based Supabase mock (see checklist-broadcast.test.ts for the
// canonical explanation): each `.from(table)` call consumes the next queued
// response for that table, in call order.
function makeSupabase(queued: QueuedByTable) {
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
    chain.update = (...a: unknown[]) => record('update', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.limit  = (...a: unknown[]) => record('limit', a)

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

// external_user_id is now REQUIRED for any property write to happen at all —
// it is the only thing that attributes the webhook to a tenant. Every fixture
// below therefore queues an integration_connections row too.
const EVENT_DATA = {
  provider_id:          'hospitable',
  previous_external_id: 'hosp_old',
  new_external_id:      'hosp_new',
  external_user_id:     'hosp_user_1',
  triggered_at:          '2026-07-22T10:00:00.000Z',
}

/** One connection row, as resolveOwningOrg's list read returns it. */
const CONNECTED = { data: [{ org_id: 'org_1' }], error: null }

describe('hospPropertyMerge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renames the surviving external_id in place when no property already exists under new_external_id', async () => {
    const supabase = makeSupabase({
      integration_connections: [CONNECTED],
      properties: [
        { data: { id: 'prop_1', org_id: 'org_1', name: 'Lakehouse' }, error: null }, // previousProperty lookup
        { data: null, error: null },                                                  // existingNewProperty lookup — none
        { error: null },                                                              // update external_id
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(hospPropertyMerge, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ action: 'remapped', propertyId: 'prop_1' })

    const update = supabase.calls.find((c) => c.table === 'properties' && c.method === 'update')
    expect(update?.args[0]).toMatchObject({ external_id: 'hosp_new' })
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('is a no-op (skipped) when no FieldStay property exists for previous_external_id — safe to re-run after the rename already applied', async () => {
    const supabase = makeSupabase({
      integration_connections: [CONNECTED],
      properties: [
        { data: null, error: null }, // previousProperty lookup — already renamed by an earlier run, or never existed
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(hospPropertyMerge, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ action: 'skipped', reason: 'no_previous_property' })
    // The connection lookup plus the one property lookup — no second property
    // lookup, no update, no audit log.
    expect(supabase.from).toHaveBeenCalledTimes(2)
    expect(supabase.calls.some((c) => c.method === 'update')).toBe(false)
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('flags for manual review and deactivates the old row instead of silently merging two already-distinct properties', async () => {
    const supabase = makeSupabase({
      integration_connections: [CONNECTED],
      properties: [
        { data: { id: 'prop_old', org_id: 'org_1', name: 'Lakehouse' }, error: null }, // previousProperty
        { data: { id: 'prop_new' }, error: null },                                      // existingNewProperty — collision
        { error: null },                                                                // deactivate update
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(hospPropertyMerge, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({
      action:              'flagged_for_manual_review',
      previousPropertyId:  'prop_old',
      survivingPropertyId: 'prop_new',
    })

    const deactivate = supabase.calls.find((c) => c.table === 'properties' && c.method === 'update')
    expect(deactivate?.args[0]).toMatchObject({ is_active: false })

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId:      'org_1',
        action:     'property.merge_conflict',
        targetType: 'property',
        targetId:   'prop_old',
        metadata: expect.objectContaining({
          provider:              'hospitable',
          previous_external_id: 'hosp_old',
          new_external_id:      'hosp_new',
          surviving_property_id: 'prop_new',
        }),
      }),
    )
  })

  it('resolves the org from external_user_id and scopes both property lookups to it', async () => {
    const supabase = makeSupabase({
      integration_connections: [CONNECTED],
      properties: [
        { data: { id: 'prop_1', org_id: 'org_1', name: 'Lakehouse' }, error: null },
        { data: null, error: null },
        { error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(hospPropertyMerge, {
      event: { data: { ...EVENT_DATA, external_user_id: 'hosp_user_1' } },
      step:  runAllStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ action: 'remapped', propertyId: 'prop_1' })

    const propertyCalls = supabase.calls.filter((c) => c.table === 'properties' && c.method === 'eq')
    expect(propertyCalls.some((c) => c.args[0] === 'org_id' && c.args[1] === 'org_1')).toBe(true)
  })

  // ── Tenant attribution is mandatory, not best-effort ────────────────────
  //
  // This block replaces a test that asserted the OPPOSITE: it fed a webhook
  // whose external_user_id matched no active connection and asserted the
  // function fell through to an UNSCOPED property lookup, renaming whatever it
  // found. That was the documented behaviour ("no worse than before"), and it
  // was a cross-tenant write.
  //
  // properties is UNIQUE (org_id, external_id, external_source) — PER ORG — so
  // two tenants co-hosting one listing legitimately hold the same Hospitable
  // external_id. Unscoped, the lookup either matched two rows (maybeSingle
  // errors, the error was discarded, the run reported a clean `skipped`) or
  // matched ONE row belonging to a different org and renamed that tenant's
  // property off this tenant's webhook.

  it('skips without touching any property when the webhook cannot be attributed to an org', async () => {
    const supabase = makeSupabase({
      integration_connections: [{ data: [], error: null }], // no connection for this account
      properties: [
        { data: { id: 'prop_1', org_id: 'org_other', name: 'Another tenant house' }, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(hospPropertyMerge, {
      event: { data: { ...EVENT_DATA, external_user_id: 'hosp_user_disconnected' } },
      step:  runAllStep(),
      logger: makeLogger(),
    })

    expect(result).toEqual({ action: 'skipped', reason: 'unattributable' })
    // The queued property row is deliberately ANOTHER org's: if the scope ever
    // becomes optional again, that row is what gets renamed.
    expect(supabase.calls.some((c) => c.table === 'properties')).toBe(false)
    expect(reportError).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ site: 'inngest.hospitable-property-merge.unattributable' }),
    )
  })

  it('skips when the payload carries no external_user_id at all', async () => {
    const supabase = makeSupabase({
      properties: [{ data: { id: 'prop_1', org_id: 'org_other', name: 'Another tenant house' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const withoutAccount = { ...EVENT_DATA, external_user_id: undefined }
    const result = await invokeHandler(hospPropertyMerge, {
      event: { data: withoutAccount },
      step:  runAllStep(),
      logger: makeLogger(),
    })

    // The field is optional on the event type, for older payload shapes. That
    // is a reason to skip, not a reason to write unscoped.
    expect(result).toEqual({ action: 'skipped', reason: 'unattributable' })
    expect(supabase.calls.some((c) => c.table === 'properties')).toBe(false)
  })

  it('skips when one Hospitable account maps to more than one org, rather than picking one', async () => {
    const supabase = makeSupabase({
      // integration_connections is UNIQUE (user_id, provider_id), so nothing
      // stops two users in two different orgs connecting the same account.
      integration_connections: [{ data: [{ org_id: 'org_1' }, { org_id: 'org_2' }], error: null }],
      properties: [{ data: { id: 'prop_1', org_id: 'org_1', name: 'Lakehouse' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(hospPropertyMerge, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })

    // Ambiguous attribution and no attribution get the same answer.
    expect(result).toEqual({ action: 'skipped', reason: 'unattributable' })
    expect(supabase.calls.some((c) => c.table === 'properties')).toBe(false)
  })

  it('resolves the owning org WITHOUT filtering on connection status', async () => {
    const supabase = makeSupabase({
      integration_connections: [CONNECTED],
      properties: [
        { data: { id: 'prop_1', org_id: 'org_1', name: 'Lakehouse' }, error: null },
        { data: null, error: null },
        { error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(hospPropertyMerge, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })

    // Structural, because the double does not model filters — a fixture-based
    // test would pass whether the filter is there or not.
    //
    // The lookup previously carried .eq('status', 'active'), and that single
    // filter is what made the whole function unsafe in practice: a connection
    // in 'error' (a token refresh that failed), 'revoked' or 'disconnected'
    // resolved to NO org, which fell through to an unscoped cross-tenant
    // write. In production all five connections are non-active right now, so
    // that was not an edge case — it was every webhook.
    //
    // Requiring an active connection is correct where credentials are USED
    // (lib/integrations/vault.ts, providers/ownerrez.ts). Here the connection
    // is only a tenant scope key, and a revoked customer still owns their rows.
    const connectionEqs = supabase.calls.filter(
      (c) => c.table === 'integration_connections' && c.method === 'eq',
    )
    expect(connectionEqs.some((c) => c.args[0] === 'status')).toBe(false)
    expect(connectionEqs.some((c) => c.args[0] === 'external_user_id')).toBe(true)
  })

  it('scopes the deactivation write to the resolved org, not just the property id', async () => {
    const supabase = makeSupabase({
      integration_connections: [CONNECTED],
      properties: [
        { data: { id: 'prop_old', org_id: 'org_1', name: 'Lakehouse' }, error: null },
        { data: { id: 'prop_new' }, error: null },
        { error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(hospPropertyMerge, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })

    const eqArgs = supabase.calls
      .filter((c) => c.table === 'properties' && c.method === 'eq')
      .map((c) => JSON.stringify(c.args))
    expect(eqArgs).toContain(JSON.stringify(['org_id', 'org_1']))
  })

  it('throws when the external_id update itself fails, instead of returning a false "remapped" result', async () => {
    const supabase = makeSupabase({
      integration_connections: [CONNECTED],
      properties: [
        { data: { id: 'prop_1', org_id: 'org_1', name: 'Lakehouse' }, error: null },
        { data: null, error: null },
        { error: { message: 'constraint violation' } },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(invokeHandler(hospPropertyMerge, {
      event: { data: EVENT_DATA },
      step:  runAllStep(),
      logger: makeLogger(),
    })).rejects.toThrow('Property external_id remap failed: constraint violation')
  })
})
