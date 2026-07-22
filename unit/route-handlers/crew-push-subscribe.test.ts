import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

vi.mock('@/lib/crew-auth', () => ({
  requireCrewMember: vi.fn(),
}))

import { POST } from '@/app/api/crew/push-subscribe/route'
import { requireCrewMember } from '@/lib/crew-auth'

const CREW_ID = 'crew_1'
const ORG_ID  = 'org_1'
const USER_ID = 'user_1'

function makeSupabase() {
  const upsertMock = vi.fn(() => Promise.resolve({ data: null, error: null }))
  const from = vi.fn(() => ({ upsert: upsertMock }))
  return { from, upsertMock }
}

function mockAuthed(supabase: ReturnType<typeof makeSupabase>) {
  vi.mocked(requireCrewMember).mockResolvedValue({
    ok:       true,
    user:     { id: USER_ID },
    supabase: supabase as never,
    crew:     { id: CREW_ID, org_id: ORG_ID },
  })
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/crew/push-subscribe', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

describe('POST /api/crew/push-subscribe', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns the auth helper response verbatim for an unauthenticated caller', async () => {
    vi.mocked(requireCrewMember).mockResolvedValue({
      ok:       false,
      response: NextResponse.json({ error: 'Not authenticated' }, { status: 401 }),
    })

    const res = await POST(postRequest({ endpoint: 'https://push.example/e1', p256dh: 'k', auth: 'a' }))

    expect(res.status).toBe(401)
  })

  it('returns the auth helper response verbatim for a caller with no crew_members row', async () => {
    vi.mocked(requireCrewMember).mockResolvedValue({
      ok:       false,
      response: NextResponse.json({ error: 'Crew member not found' }, { status: 403 }),
    })

    const res = await POST(postRequest({ endpoint: 'https://push.example/e1', p256dh: 'k', auth: 'a' }))

    expect(res.status).toBe(403)
  })

  it('rejects a body missing endpoint/p256dh/auth without touching the DB', async () => {
    const supabase = makeSupabase()
    mockAuthed(supabase)

    const res = await POST(postRequest({ endpoint: 'https://push.example/e1' }))

    expect(res.status).toBe(400)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('rejects an unparseable body without touching the DB', async () => {
    const supabase = makeSupabase()
    mockAuthed(supabase)

    const req = new NextRequest('http://localhost/api/crew/push-subscribe', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    'not-json',
    })
    const res = await POST(req)

    expect(res.status).toBe(400)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('upserts the subscription scoped to the authenticated crew member — crew_member_id/org_id are server-derived, not client-supplied', async () => {
    const supabase = makeSupabase()
    mockAuthed(supabase)

    const res = await POST(
      postRequest({
        endpoint: 'https://push.example/e1',
        p256dh:   'key-p256dh',
        auth:     'key-auth',
        // Attempted override — must be ignored, the route builds the upsert
        // object explicitly from the authenticated crew context.
        crew_member_id: 'attacker_crew',
        org_id:         'attacker_org',
      }),
    )

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ success: true })
    expect(supabase.from).toHaveBeenCalledWith('push_subscriptions')
    expect(supabase.upsertMock).toHaveBeenCalledWith(
      {
        crew_member_id: CREW_ID,
        org_id:         ORG_ID,
        endpoint:       'https://push.example/e1',
        p256dh:         'key-p256dh',
        auth:           'key-auth',
      },
      { onConflict: 'crew_member_id,endpoint' },
    )
  })
})
