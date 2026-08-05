import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

// `after()` defers work past the response, so the assertions have to wait for
// it explicitly — invoking it without awaiting made every Slack assertion run
// before the webhook call had happened. Promises are collected here and
// drained by flushAfter(). NextRequest/NextResponse come from the real module.
const deferred = vi.hoisted(() => [] as Promise<unknown>[])
vi.mock('next/server', async () => {
  const actual = await vi.importActual<typeof import('next/server')>('next/server')
  return { ...actual, after: (fn: () => unknown) => { deferred.push(Promise.resolve(fn())) } }
})

async function flushAfter() {
  await Promise.all(deferred.splice(0))
}
vi.mock('@/lib/crew-auth', () => ({ requireCrewMember: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/inngest/helpers', () => ({ getPmMembers: vi.fn() }))
vi.mock('@/lib/security/url-guard', () => ({ safeFetch: vi.fn(async () => new Response('ok')) }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { POST } from '@/app/api/crew/messages/route'
import { requireCrewMember } from '@/lib/crew-auth'
import { createServiceClient } from '@/lib/supabase/server'
import { getPmMembers } from '@/lib/inngest/helpers'
import { safeFetch } from '@/lib/security/url-guard'

const ORG = 'org_1'
const CREW = { id: 'crew_1', org_id: ORG }

type Resp = { data?: unknown; error?: unknown }

function makeClient(byTable: Record<string, Resp> = {}) {
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'eq']) chain[m] = vi.fn(() => chain)
    const result = byTable[table] ?? { data: null, error: null }
    chain.maybeSingle = vi.fn(async () => result)
    chain.single      = vi.fn(async () => result)
    chain.then        = (r: (v: unknown) => unknown) => Promise.resolve(result).then(r)
    return chain
  })
  return { from }
}

function post(body: unknown) {
  return new NextRequest('http://localhost/api/crew/messages', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

const validBody = { messageId: 'msg_1', content: 'Sink is leaking in unit 4' }

// The crew→PM Slack notification lived in sendMessageToPM, the Server Action
// this route replaced. Moving messaging to the Dexie outbox dropped it: the
// action was the only caller of postToSlack, which was the only reader of
// organizations.slack_webhook_url. Settings kept showing — and saving — a
// "Slack Webhook URL" field that did nothing, and no test covered this route
// at all, which is why nobody noticed.
describe('POST /api/crew/messages — Slack notification', () => {
  beforeEach(() => {
    deferred.length = 0
    vi.clearAllMocks()
    vi.mocked(requireCrewMember).mockResolvedValue({
      ok: true, crew: CREW, user: { id: 'user_1' }, supabase: makeClient(),
    } as never)
    vi.mocked(getPmMembers).mockResolvedValue([{ userId: 'pm_1', email: 'pm@example.com' }] as never)
  })

  it('posts to the org webhook when one is configured', async () => {
    vi.mocked(createServiceClient).mockReturnValue(makeClient({
      organizations: { data: { slack_webhook_url: 'https://hooks.slack.com/services/T/B/X' } },
      crew_members:  { data: { name: 'Jamie Crew' } },
    }) as never)

    const res = await POST(post(validBody))
    await flushAfter()

    expect(res.status).toBe(200)
    expect(safeFetch).toHaveBeenCalledTimes(1)
    const [url, init] = vi.mocked(safeFetch).mock.calls[0]!
    expect(url).toBe('https://hooks.slack.com/services/T/B/X')
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({
      text: expect.stringContaining('Jamie Crew'),
    })
  })

  // slack_webhook_url is TENANT-SUPPLIED — a PM types it into Settings. A raw
  // fetch would be an SSRF primitive aimed at whatever they enter (link-local
  // metadata, an internal host, a plaintext downgrade via redirect). The
  // original implementation used a bare fetch; safeFetch validates every hop.
  it('goes through safeFetch, never a bare fetch', async () => {
    const bareFetch = vi.spyOn(globalThis, 'fetch')
    vi.mocked(createServiceClient).mockReturnValue(makeClient({
      organizations: { data: { slack_webhook_url: 'https://hooks.slack.com/services/T/B/X' } },
      crew_members:  { data: { name: 'Jamie Crew' } },
    }) as never)

    await POST(post(validBody))
    await flushAfter()

    expect(safeFetch).toHaveBeenCalled()
    expect(bareFetch).not.toHaveBeenCalled()
    bareFetch.mockRestore()
  })

  it('sends nothing when the org has no webhook configured', async () => {
    vi.mocked(createServiceClient).mockReturnValue(makeClient({
      organizations: { data: { slack_webhook_url: null } },
      crew_members:  { data: { name: 'Jamie Crew' } },
    }) as never)

    const res = await POST(post(validBody))
    await flushAfter()

    expect(res.status).toBe(200)
    expect(safeFetch).not.toHaveBeenCalled()
  })

  // The message is already committed by this point. A misconfigured or hostile
  // webhook must not fail a crew member's send — the outbox would retry it and
  // the message would land twice.
  it('still returns success when the webhook call throws', async () => {
    vi.mocked(createServiceClient).mockReturnValue(makeClient({
      organizations: { data: { slack_webhook_url: 'https://hooks.slack.com/services/T/B/X' } },
      crew_members:  { data: { name: 'Jamie Crew' } },
    }) as never)
    vi.mocked(safeFetch).mockRejectedValueOnce(new Error('blocked: link-local address'))

    const res = await POST(post(validBody))
    await flushAfter()

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ success: true })
  })

  it('falls back to a generic name when the crew row has none', async () => {
    vi.mocked(createServiceClient).mockReturnValue(makeClient({
      organizations: { data: { slack_webhook_url: 'https://hooks.slack.com/services/T/B/X' } },
      crew_members:  { data: null },
    }) as never)

    await POST(post(validBody))
    await flushAfter()

    const [, init] = vi.mocked(safeFetch).mock.calls[0]!
    expect(JSON.parse(String((init as RequestInit).body)).text).toContain('A crew member')
  })
})
