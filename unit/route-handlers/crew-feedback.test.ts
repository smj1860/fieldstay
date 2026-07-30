import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/supabase/server', () => ({
  createClient:        vi.fn(),
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/inngest/client', () => ({
  inngest: { send: vi.fn() },
}))
vi.mock('@/lib/observability/report-error', () => ({
  reportError: vi.fn(),
}))

import { POST } from '@/app/api/crew/feedback/route'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'

const CREW_ID = 'crew_1'
const ORG_ID  = 'org_1'
const USER_ID = 'user_1'

// Minimal chainable auth-client mock: only crew_members is ever queried
// through this client, and always resolves via .single().
function makeAuthClient(
  user: { id: string } | null,
  crewResult: { data: unknown; error?: unknown } = { data: null, error: null },
) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  chain.select = vi.fn(() => chain)
  chain.eq     = vi.fn(() => chain)
  chain.not    = vi.fn(() => chain)
  chain.single = vi.fn(() => Promise.resolve(crewResult))

  return {
    auth: { getUser: vi.fn(async () => ({ data: { user } })) },
    from: vi.fn(() => chain),
  }
}

function makeServiceClient(opts: { insertResult?: { error: unknown } } = {}) {
  const insertMock = vi.fn(() => Promise.resolve(opts.insertResult ?? { error: null }))
  const from = vi.fn(() => ({ insert: insertMock }))
  return { from, insertMock }
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/crew/feedback', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

describe('POST /api/crew/feedback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects an empty feedbackText before touching auth or the DB', async () => {
    const res = await POST(postRequest({ feedbackText: '   ' }))

    expect(res.status).toBe(400)
    expect(createClient).not.toHaveBeenCalled()
  })

  it('rejects an unauthenticated request', async () => {
    vi.mocked(createClient).mockResolvedValue(makeAuthClient(null) as never)

    const res = await POST(postRequest({ feedbackText: 'The vacuum is broken' }))

    expect(res.status).toBe(401)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('rejects a session user with no matching active crew_members row', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeAuthClient({ id: USER_ID }, { data: null, error: null }) as never,
    )

    const res = await POST(postRequest({ feedbackText: 'The vacuum is broken' }))

    expect(res.status).toBe(403)
    expect(createServiceClient).not.toHaveBeenCalled()
  })

  it('inserts feedback scoped to the authenticated crew member — org_id/crew_member_id are server-derived, not client-supplied', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeAuthClient({ id: USER_ID }, { data: { id: CREW_ID, org_id: ORG_ID }, error: null }) as never,
    )
    const service = makeServiceClient()
    vi.mocked(createServiceClient).mockReturnValue(service as never)

    const res = await POST(
      postRequest({
        feedbackText: 'The vacuum is broken',
        propertyId:   'property_1',
        // Attempted override — must be ignored, since the route builds the
        // insert object explicitly rather than spreading the request body.
        org_id:         'attacker_org',
        crew_member_id: 'attacker_crew',
      }),
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ submitted: true })
    expect(service.insertMock).toHaveBeenCalledWith({
      org_id:         ORG_ID,
      crew_member_id: CREW_ID,
      property_id:    'property_1',
      feedback_text:  'The vacuum is broken',
    })
  })

  it('returns 500 when the insert fails, without throwing', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeAuthClient({ id: USER_ID }, { data: { id: CREW_ID, org_id: ORG_ID }, error: null }) as never,
    )
    const service = makeServiceClient({ insertResult: { error: { message: 'insert failed' } } })
    vi.mocked(createServiceClient).mockReturnValue(service as never)

    const res = await POST(postRequest({ feedbackText: 'Something broke' }))

    expect(res.status).toBe(500)
  })

  it('enqueues the staff notification via Inngest after a successful submit', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeAuthClient({ id: USER_ID }, { data: { id: CREW_ID, org_id: ORG_ID }, error: null }) as never,
    )
    const service = makeServiceClient()
    vi.mocked(createServiceClient).mockReturnValue(service as never)

    const res = await POST(postRequest({ feedbackText: 'Great shift today' }))
    expect(res.status).toBe(200)

    expect(inngest.send).toHaveBeenCalledWith({
      name: 'crew/feedback.submitted',
      data: { org_id: ORG_ID, crew_member_id: CREW_ID, feedback_text: 'Great shift today' },
    })
  })

  it('still returns success when the Inngest send fails — the feedback row is already durably written', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeAuthClient({ id: USER_ID }, { data: { id: CREW_ID, org_id: ORG_ID }, error: null }) as never,
    )
    const service = makeServiceClient()
    vi.mocked(createServiceClient).mockReturnValue(service as never)
    vi.mocked(inngest.send).mockRejectedValueOnce(new Error('event API unreachable'))

    const res = await POST(postRequest({ feedbackText: 'Great shift today' }))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ submitted: true })
  })

  it('accepts a null propertyId (feedback not tied to a specific property)', async () => {
    vi.mocked(createClient).mockResolvedValue(
      makeAuthClient({ id: USER_ID }, { data: { id: CREW_ID, org_id: ORG_ID }, error: null }) as never,
    )
    const service = makeServiceClient()
    vi.mocked(createServiceClient).mockReturnValue(service as never)

    const res = await POST(postRequest({ feedbackText: 'General note' }))

    expect(res.status).toBe(200)
    expect(service.insertMock).toHaveBeenCalledWith(
      expect.objectContaining({ property_id: null }),
    )
  })
})
