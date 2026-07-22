import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))

import { logMessageCommunication } from '@/lib/inngest/functions/log-message-comm'
import { createServiceClient } from '@/lib/supabase/server'
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
    chain.select = (...a: unknown[]) => record('select', a)
    chain.eq     = (...a: unknown[]) => record('eq', a)
    chain.insert = (...a: unknown[]) => record('insert', a)

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

const BASE_EVENT = {
  data: {
    message_id:    'msg_1',
    org_id:        'org_1',
    sender_id:     'user_pm',
    recipient_id:  'user_crew',
    is_crew_to_pm: false,
  },
}

describe('logMessageCommunication', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('logs a PM → crew message to the comms log', async () => {
    const supabase = makeSupabase({
      messages: [{ data: { content: 'Please arrive by 10am', created_at: '2026-07-22T14:00:00Z', work_order_id: null }, error: null }],
      crew_members: [{ data: { id: 'crew_1' }, error: null }],
      communication_logs: [{ error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const logger = makeLogger()

    const result = await invokeHandler(logMessageCommunication, { event: BASE_EVENT, step: runAllStep(), logger })

    expect(result).toEqual({ message_id: 'msg_1', crew_member_id: 'crew_1' })

    const insertCall = supabase.calls.find((c) => c.table === 'communication_logs' && c.method === 'insert')
    expect(insertCall?.args[0]).toMatchObject({
      org_id:          'org_1',
      recipient_type:  'crew',
      crew_member_id:  'crew_1',
      channel:         'note',
      subject:         'PM → Crew message',
      body:            'Please arrive by 10am',
      dedup_key:       'message:msg_1',
      logged_by_user_id: 'user_pm',
    })
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('created'))
  })

  it('resolves the crew member from sender_id when the message is crew → pm', async () => {
    const supabase = makeSupabase({
      messages:     [{ data: { content: 'On my way', created_at: '2026-07-22T14:00:00Z', work_order_id: 'wo_1' }, error: null }],
      crew_members: [{ data: { id: 'crew_9' }, error: null }],
      communication_logs: [{ error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const event = { data: { ...BASE_EVENT.data, is_crew_to_pm: true, sender_id: 'user_crew_9', recipient_id: 'user_pm' } }
    await invokeHandler(logMessageCommunication, { event, step: runAllStep(), logger: makeLogger() })

    const crewLookup = supabase.calls.find((c) => c.table === 'crew_members' && c.method === 'eq')
    expect(crewLookup).toBeDefined()
    const insertCall = supabase.calls.find((c) => c.table === 'communication_logs' && c.method === 'insert')
    expect(insertCall?.args[0]).toMatchObject({ subject: 'Crew → PM message', crew_member_id: 'crew_9' })
  })

  it('is a no-op when the message no longer exists', async () => {
    const supabase = makeSupabase({
      messages: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(logMessageCommunication, { event: BASE_EVENT, step: runAllStep(), logger: makeLogger() })

    expect(result).toEqual({ skipped: 'message_not_found' })
    expect(supabase.calls.some((c) => c.table === 'crew_members')).toBe(false)
  })

  it('is a no-op when the counterpart user is not a crew member', async () => {
    const supabase = makeSupabase({
      messages:     [{ data: { content: 'hi', created_at: '2026-07-22T14:00:00Z', work_order_id: null }, error: null }],
      crew_members: [{ data: null, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(logMessageCommunication, { event: BASE_EVENT, step: runAllStep(), logger: makeLogger() })

    expect(result).toEqual({ skipped: 'crew_member_not_found' })
    expect(supabase.calls.some((c) => c.table === 'communication_logs')).toBe(false)
  })

  it('idempotency: a duplicate insert (23505 from the dedup_key unique index) is treated as already-logged, not an error', async () => {
    const supabase = makeSupabase({
      messages:     [{ data: { content: 'Please arrive by 10am', created_at: '2026-07-22T14:00:00Z', work_order_id: null }, error: null }],
      crew_members: [{ data: { id: 'crew_1' }, error: null }],
      communication_logs: [{ error: { code: '23505', message: 'duplicate key value violates unique constraint' } }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    const logger = makeLogger()

    const result = await invokeHandler(logMessageCommunication, { event: BASE_EVENT, step: runAllStep(), logger })

    expect(result).toEqual({ message_id: 'msg_1', crew_member_id: 'crew_1' })
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('already_logged'))
  })

  it('rethrows a non-duplicate-key insert error', async () => {
    const supabase = makeSupabase({
      messages:     [{ data: { content: 'Please arrive by 10am', created_at: '2026-07-22T14:00:00Z', work_order_id: null }, error: null }],
      crew_members: [{ data: { id: 'crew_1' }, error: null }],
      communication_logs: [{ error: { code: '500', message: 'internal error' } }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(logMessageCommunication, { event: BASE_EVENT, step: runAllStep(), logger: makeLogger() })
    ).rejects.toMatchObject({ code: '500' })
  })
})
