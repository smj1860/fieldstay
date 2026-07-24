import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn().mockResolvedValue({ data: { id: 'email_1' }, error: null }) } },
  FROM:   'FieldStay <notify@fieldstay.app>',
}))

import { handleSupportEscalation } from '@/lib/inngest/functions/support-conversation-escalated'
import { createServiceClient } from '@/lib/supabase/server'
import { resend } from '@/lib/resend/client'
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
    chain.update = (...a: unknown[]) => record('update', a)

    const resolveNext = () => {
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return Promise.resolve(queued[table]?.[idx] ?? { data: null, error: null })
    }

    chain.single = () => resolveNext()
    chain.then   = (resolve: (v: unknown) => unknown) => resolveNext().then(resolve)
    return chain
  })

  return { from, calls }
}

function runAllStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

const BASE_EVENT = {
  data: {
    conversationId: 'conv_1',
    orgId:          'org_1',
    reason:         "Guest asked about a refund I can't help with",
  },
}

describe('handleSupportEscalation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.fieldstay.app'
  })

  it('emails stephen@fieldstay.app and marks the conversation as staff-notified', async () => {
    const supabase = makeSupabase({
      organizations:         [{ data: { name: 'Lake Martin Delivery' }, error: null }],
      support_conversations: [
        { data: { id: 'conv_1', staff_notified_at: null }, error: null }, // fetch-context
        { data: null, error: null }, // update in notify-stephen
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleSupportEscalation, { event: BASE_EVENT, step: runAllStep() })

    expect(result).toEqual({ notified: true, org: 'Lake Martin Delivery' })

    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to:      ['stephen@fieldstay.app'],
        subject: 'Support escalation — Lake Martin Delivery',
        html:    expect.stringContaining("Guest asked about a refund I can&#39;t help with"),
      }),
      { idempotencyKey: 'support-escalation-conv_1' },
    )

    const updateCall = supabase.calls.find((c) => c.table === 'support_conversations' && c.method === 'update')
    expect(updateCall?.args[0]).toMatchObject({ staff_notified_at: expect.any(String) })
  })

  it('escapes HTML-unsafe characters in org name and reason before interpolating into the raw email string', async () => {
    const supabase = makeSupabase({
      organizations:         [{ data: { name: '<script>Evil</script>' }, error: null }],
      support_conversations: [
        { data: { id: 'conv_1', staff_notified_at: null }, error: null },
        { data: null, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(handleSupportEscalation, { event: BASE_EVENT, step: runAllStep() })

    const call = (resend.emails.send as ReturnType<typeof vi.fn>).mock.calls[0]![0] as { html: string }
    expect(call.html).not.toContain('<script>Evil</script>')
    expect(call.html).toContain('&lt;script&gt;Evil&lt;/script&gt;')
  })

  it('skips sending when the conversation was already staff-notified', async () => {
    const supabase = makeSupabase({
      organizations:         [{ data: { name: 'Lake Martin Delivery' }, error: null }],
      support_conversations: [{ data: { id: 'conv_1', staff_notified_at: '2026-07-21T10:00:00Z' }, error: null }],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleSupportEscalation, { event: BASE_EVENT, step: runAllStep() })

    expect(result).toEqual({ skipped: 'already_notified' })
    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(supabase.calls.some((c) => c.table === 'support_conversations' && c.method === 'update')).toBe(false)
  })

  it('falls back to "Unknown Org" when the org lookup finds nothing', async () => {
    const supabase = makeSupabase({
      organizations:         [{ data: null, error: null }],
      support_conversations: [
        { data: { id: 'conv_1', staff_notified_at: null }, error: null },
        { data: null, error: null },
      ],
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleSupportEscalation, { event: BASE_EVENT, step: runAllStep() })

    expect(result).toEqual({ notified: true, org: 'Unknown Org' })
  })
})
