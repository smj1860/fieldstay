import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))

import { POST } from '@/app/api/milestones/review-clicked/route'
import { requireOrgMember } from '@/lib/auth'

const ORG_ID  = 'org_1'
const USER_ID = 'user_1'

function makeSupabase() {
  const calls: { method: string; args: unknown[] }[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chain: any = {}
  const record = (method: string, args: unknown[]) => {
    calls.push({ method, args })
    return chain
  }
  chain.update = (...a: unknown[]) => record('update', a)
  chain.eq     = (...a: unknown[]) => record('eq', a)
  chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve({ error: null }).then(resolve)

  const from = vi.fn(() => chain)
  return { from, calls }
}

function mockAuthed(supabase: ReturnType<typeof makeSupabase>) {
  vi.mocked(requireOrgMember).mockResolvedValue({
    user:       { id: USER_ID } as never,
    supabase:   supabase as never,
    membership: { org_id: ORG_ID } as never,
  })
}

function postRequest(body: unknown) {
  return new NextRequest('http://localhost/api/milestones/review-clicked', {
    method:  'POST',
    headers: { 'content-type': 'application/json' },
    body:    JSON.stringify(body),
  })
}

describe('POST /api/milestones/review-clicked', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rejects a body missing milestone without calling requireOrgMember', async () => {
    const res = await POST(postRequest({}))

    expect(res.status).toBe(400)
    expect(requireOrgMember).not.toHaveBeenCalled()
  })

  it('rejects an unparseable body without calling requireOrgMember', async () => {
    const req = new NextRequest('http://localhost/api/milestones/review-clicked', {
      method:  'POST',
      headers: { 'content-type': 'application/json' },
      body:    'not-json',
    })
    const res = await POST(req)

    expect(res.status).toBe(400)
    expect(requireOrgMember).not.toHaveBeenCalled()
  })

  it('propagates the auth failure (e.g. redirect-to-login) instead of swallowing it', async () => {
    vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

    await expect(POST(postRequest({ milestone: 'first_wo_completed' }))).rejects.toThrow('REDIRECT:/login')
  })

  it('marks review_clicked and dismissed, scoped to the caller org_id, on the happy path', async () => {
    const supabase = makeSupabase()
    mockAuthed(supabase)

    const res = await POST(postRequest({ milestone: 'first_wo_completed' }))

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ success: true })
    expect(supabase.from).toHaveBeenCalledWith('org_milestones')
    expect(supabase.calls[0]).toEqual({
      method: 'update',
      args:   [{ review_clicked: true, dismissed: true }],
    })
    expect(supabase.calls[1]).toEqual({ method: 'eq', args: ['org_id', ORG_ID] })
    expect(supabase.calls[2]).toEqual({ method: 'eq', args: ['milestone', 'first_wo_completed'] })
  })

  it('IDOR: ignores a client-supplied org_id and scopes the update to the session org_id only', async () => {
    const supabase = makeSupabase()
    mockAuthed(supabase)

    const res = await POST(
      postRequest({ milestone: 'first_wo_completed', org_id: 'attacker_org' }),
    )

    expect(res.status).toBe(200)
    const orgEqCalls = supabase.calls.filter((c) => c.method === 'eq' && c.args[0] === 'org_id')
    expect(orgEqCalls).toEqual([{ method: 'eq', args: ['org_id', ORG_ID] }])
    expect(orgEqCalls.some((c) => c.args[1] === 'attacker_org')).toBe(false)
  })
})
