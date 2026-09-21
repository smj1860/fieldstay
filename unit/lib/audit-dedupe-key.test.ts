import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSupabaseDouble } from '@/unit/stubs/supabase-query-double'

vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))

import { reportError } from '@/lib/observability/report-error'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent, logAuditEvents } from '@/lib/audit'

// ============================================================================
// audit_events.dedupe_key replaces a pre-write "does this already exist" SELECT
// with a real DB-level uniqueness guarantee, so the insert itself is the dedup
// check. A 23505 (unique-violation) firing because dedupeKey collided with an
// already-recorded event must be treated as "already recorded", not reported
// to Sentry as a write failure — otherwise every ordinary dedup hit pages as
// an error.
// ============================================================================

const UNIQUE_VIOLATION = { message: 'duplicate key value violates unique constraint', code: '23505' }

beforeEach(() => vi.clearAllMocks())

describe('logAuditEvent / logAuditEvents — dedupe_key', () => {
  it('writes dedupe_key on the insert payload when provided', async () => {
    const double = createSupabaseDouble({ audit_events: { data: null, error: null } })
    vi.mocked(createServiceClient).mockReturnValue(double as never)

    await logAuditEvent({
      action:    'thumbtack.request_flow.completed',
      orgId:     'org_1',
      dedupeKey: 'thumbtack:req_1',
    })

    expect(double.insertSpy).toHaveBeenCalledWith(
      'audit_events',
      expect.arrayContaining([expect.objectContaining({ dedupe_key: 'thumbtack:req_1' })]),
    )
  })

  it('writes a null dedupe_key when none is given, unaffected by the new column', async () => {
    const double = createSupabaseDouble({ audit_events: { data: null, error: null } })
    vi.mocked(createServiceClient).mockReturnValue(double as never)

    await logAuditEvent({ action: 'property.created', orgId: 'org_1' })

    expect(double.insertSpy).toHaveBeenCalledWith(
      'audit_events',
      expect.arrayContaining([expect.objectContaining({ dedupe_key: null })]),
    )
  })

  it('swallows a 23505 unique-violation silently when the entry carried a dedupeKey — already recorded, not an error', async () => {
    const double = createSupabaseDouble({ audit_events: { data: null, error: UNIQUE_VIOLATION } })
    vi.mocked(createServiceClient).mockReturnValue(double as never)

    await expect(logAuditEvent({
      action:    'thumbtack.request_flow.completed',
      orgId:     'org_1',
      dedupeKey: 'thumbtack:req_1',
    })).resolves.toBeUndefined()

    expect(reportError).not.toHaveBeenCalled()
  })

  it('still reports a 23505 when no entry in the batch carried a dedupeKey — an unrelated collision is a real failure', async () => {
    const double = createSupabaseDouble({ audit_events: { data: null, error: UNIQUE_VIOLATION } })
    vi.mocked(createServiceClient).mockReturnValue(double as never)

    await logAuditEvents([{ action: 'property.created', orgId: 'org_1' }])

    expect(reportError).toHaveBeenCalled()
  })

  it('still reports a genuine non-23505 write failure even with a dedupeKey set', async () => {
    const double = createSupabaseDouble({
      audit_events: { data: null, error: { message: 'connection reset', code: '08006' } },
    })
    vi.mocked(createServiceClient).mockReturnValue(double as never)

    await logAuditEvent({
      action:    'thumbtack.request_flow.completed',
      orgId:     'org_1',
      dedupeKey: 'thumbtack:req_1',
    })

    expect(reportError).toHaveBeenCalled()
  })
})
