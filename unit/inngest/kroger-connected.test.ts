import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/kroger/client', () => ({
  getClientToken:        vi.fn(),
  findNearestKrogerStore: vi.fn(),
}))
vi.mock('@/lib/audit', () => ({
  logAuditEvent: vi.fn(),
}))

import { setupKrogerOnConnect } from '@/lib/inngest/functions/kroger-connected'
import { createServiceClient } from '@/lib/supabase/server'
import { getClientToken, findNearestKrogerStore } from '@/lib/kroger/client'
import { logAuditEvent } from '@/lib/audit'
import { invokeHandler } from './test-helpers'

// Queue-based `.from(table)` mock — see checklist-broadcast.test.ts for the
// reference pattern.
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
    chain.select   = (...a: unknown[]) => record('select', a)
    chain.eq       = (...a: unknown[]) => record('eq', a)
    chain.not      = (...a: unknown[]) => record('not', a)
    chain.order    = (...a: unknown[]) => record('order', a)
    chain.limit    = (...a: unknown[]) => record('limit', a)
    chain.update   = (...a: unknown[]) => record('update', a)
    chain.delete   = (...a: unknown[]) => record('delete', a)
    chain.upsert   = (...a: unknown[]) => record('upsert', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single      = () => resolveNext()
    chain.maybeSingle = () => resolveNext()
    chain.then        = (resolve: (v: unknown) => unknown) => resolveNext().then(resolve)
    return chain
  })

  return { from, calls }
}

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function makeLogger() {
  return { info: vi.fn(), error: vi.fn() }
}

const BASE_EVENT = { data: { org_id: 'org_1', user_id: 'user_1' } }

describe('setupKrogerOnConnect', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('finds the nearest Kroger store from the org\'s oldest active property and configures the connection', async () => {
    const supabase = makeSupabase({
      properties: [{ data: { zip: '35007' }, error: null }],
      integration_connections: [
        { data: { metadata: { foo: 'bar' } }, error: null }, // select before update
        { error: null }, // update
      ],
      organizations: [{ error: null }], // update preferred_retailer
      org_milestones: [{ error: null }], // delete stale flag
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getClientToken as ReturnType<typeof vi.fn>).mockResolvedValue('client_token_abc')
    ;(findNearestKrogerStore as ReturnType<typeof vi.fn>).mockResolvedValue({
      locationId: '01400943', name: 'Kroger - Main St',
    })
    const logger = makeLogger()

    const result = await invokeHandler(setupKrogerOnConnect, { event: BASE_EVENT, step: runAllStep(), logger })

    expect(result).toEqual({ found: true, locationName: 'Kroger - Main St' })
    expect(findNearestKrogerStore).toHaveBeenCalledWith('35007', 'client_token_abc')

    const connUpdate = supabase.calls.find((c) => c.table === 'integration_connections' && c.method === 'update')
    expect(connUpdate?.args[0]).toMatchObject({
      metadata: { foo: 'bar', location_id: '01400943', location_name: 'Kroger - Main St' },
    })

    const orgUpdate = supabase.calls.find((c) => c.table === 'organizations' && c.method === 'update')
    expect(orgUpdate?.args[0]).toEqual({ preferred_retailer: 'kroger' })

    expect(supabase.calls.some((c) => c.table === 'org_milestones' && c.method === 'delete')).toBe(true)

    expect(logAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId:  'org_1',
        action: 'kroger.auto_configured',
        metadata: { locationName: 'Kroger - Main St' },
      }),
    )
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('connected to Kroger - Main St'))
  })

  it('flags kroger_store_needed and skips the lookup when no active property has a zip', async () => {
    const supabase = makeSupabase({
      properties: [{ data: null, error: null }],
      org_milestones: [{ error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(setupKrogerOnConnect, { event: BASE_EVENT, step: runAllStep(), logger: makeLogger() })

    expect(result).toEqual({ found: false, reason: 'no_property_zip' })
    expect(getClientToken).not.toHaveBeenCalled()
    const upsertCall = supabase.calls.find((c) => c.table === 'org_milestones' && c.method === 'upsert')
    expect(upsertCall?.args[0]).toEqual({ org_id: 'org_1', milestone: 'kroger_store_needed' })
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('flags kroger_store_needed when no Kroger store is found in range of the zip', async () => {
    const supabase = makeSupabase({
      properties: [{ data: { zip: '99999' }, error: null }],
      org_milestones: [{ error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getClientToken as ReturnType<typeof vi.fn>).mockResolvedValue('client_token_abc')
    ;(findNearestKrogerStore as ReturnType<typeof vi.fn>).mockResolvedValue(null)

    const result = await invokeHandler(setupKrogerOnConnect, { event: BASE_EVENT, step: runAllStep(), logger: makeLogger() })

    expect(result).toEqual({ found: false, reason: 'no_store_in_range' })
    const connUpdate = supabase.calls.find((c) => c.table === 'integration_connections' && c.method === 'update')
    expect(connUpdate).toBeUndefined()
    expect(logAuditEvent).not.toHaveBeenCalled()
  })

  it('merges into existing connection metadata rather than clobbering it', async () => {
    const supabase = makeSupabase({
      properties: [{ data: { zip: '35007' }, error: null }],
      integration_connections: [
        { data: { metadata: null }, error: null },
        { error: null },
      ],
      organizations: [{ error: null }],
      org_milestones: [{ error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getClientToken as ReturnType<typeof vi.fn>).mockResolvedValue('client_token_abc')
    ;(findNearestKrogerStore as ReturnType<typeof vi.fn>).mockResolvedValue({
      locationId: '01400943', name: 'Kroger - Main St',
    })

    await invokeHandler(setupKrogerOnConnect, { event: BASE_EVENT, step: runAllStep(), logger: makeLogger() })

    const connUpdate = supabase.calls.find((c) => c.table === 'integration_connections' && c.method === 'update')
    expect(connUpdate?.args[0]).toMatchObject({
      metadata: { location_id: '01400943', location_name: 'Kroger - Main St' },
    })
  })
})
