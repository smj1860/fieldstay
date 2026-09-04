import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/rate-limit', async () => {
  const { checkLimitStub, retryAfterSecondsStub } = await import('@/unit/stubs/rate-limit')
  return {
    thumbtackSearchRatelimit: { limit: vi.fn(async () => ({ success: true })) },
    checkLimit:               checkLimitStub(),
    retryAfterSeconds:        retryAfterSecondsStub,
  }
})

vi.mock('@/lib/auth', () => ({ requireOrgMember: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/integrations/thumbtack', async () => {
  const actual = await vi.importActual<typeof import('@/lib/integrations/thumbtack')>('@/lib/integrations/thumbtack')
  return { ...actual, searchThumbtackPros: vi.fn() }
})

import { requireOrgMember } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { thumbtackSearchRatelimit } from '@/lib/rate-limit'
import { searchThumbtackPros } from '@/lib/integrations/thumbtack'
import { searchThumbtackProsAction, recordThumbtackRequestCreatedAction } from '@/lib/integrations/thumbtack-actions'

const membership = { org_id: 'org_1', role: 'admin' as const }
const user = { id: 'user_1' }

const REQUEST_CREATED_EVENT = {
  businesses_contacted: [{ business_pk: 'b_1', business_name: 'Acme Plumbing' }],
  category_pk: 'cat_1', zip_code: '90210', user_pk: 'tt_user_1',
  created_at: 1_700_000_000, is_existing_user: false,
  search_id: 'search_1', request_pk: 'req_1',
}

describe('searchThumbtackProsAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireOrgMember).mockResolvedValue({ user, membership } as never)
  })

  it('returns a rate-limit error without calling searchThumbtackPros when the limiter denies', async () => {
    vi.mocked(thumbtackSearchRatelimit.limit).mockResolvedValueOnce({
      success: false, limit: 10, remaining: 0, reset: Date.now() + 5000, pending: Promise.resolve(),
    })

    const result = await searchThumbtackProsAction('plumbing', '90210')

    expect(result.success).toBe(false)
    expect(searchThumbtackPros).not.toHaveBeenCalled()
  })

  it('returns an error for a category with no configured category_pk, without calling searchThumbtackPros', async () => {
    const result = await searchThumbtackProsAction('other', '90210')

    expect(result).toEqual({ success: false, error: expect.stringContaining('other') })
    expect(searchThumbtackPros).not.toHaveBeenCalled()
  })

  it('returns the pros on success', async () => {
    const pros = [{ businessName: 'Acme Plumbing', servicePk: 's_1', requestFlowUrl: 'https://thumbtack.com/embed/request-flow' }]
    vi.mocked(searchThumbtackPros).mockResolvedValueOnce(pros)

    const result = await searchThumbtackProsAction('plumbing', '90210')

    expect(result).toEqual({ success: true, pros })
  })

  it('degrades to a generic error when searchThumbtackPros throws (e.g. the not-yet-implemented stub)', async () => {
    vi.mocked(searchThumbtackPros).mockRejectedValueOnce(new Error('not yet implemented'))

    const result = await searchThumbtackProsAction('plumbing', '90210')

    expect(result.success).toBe(false)
    if (!result.success) expect(result.error).not.toMatch(/not yet implemented/)
  })
})

describe('recordThumbtackRequestCreatedAction', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(requireOrgMember).mockResolvedValue({ user, membership } as never)
  })

  it('logs an audit event scoped to the work order when one is given', async () => {
    await recordThumbtackRequestCreatedAction('wo_1', REQUEST_CREATED_EVENT)

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      orgId:      'org_1',
      actorId:    'user_1',
      action:     'thumbtack.request_flow.completed',
      targetType: 'work_order',
      targetId:   'wo_1',
    }))
  })

  it('omits targetType/targetId when no work order is in scope (Crew and Maintenance list searches)', async () => {
    await recordThumbtackRequestCreatedAction(null, REQUEST_CREATED_EVENT)

    expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
      targetType: undefined,
      targetId:   undefined,
    }))
  })

  it('never throws — a logging failure must not surface to the caller as a UI error', async () => {
    vi.mocked(logAuditEvent).mockRejectedValueOnce(new Error('db down'))
    await expect(recordThumbtackRequestCreatedAction('wo_1', REQUEST_CREATED_EVENT)).resolves.toBeUndefined()
  })
})
