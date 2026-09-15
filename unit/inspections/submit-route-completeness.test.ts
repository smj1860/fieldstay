import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// The 'incomplete' RPC result (20260915150000, submit_inspection's SQL-level
// completeness backstop) used to have nowhere to land: before this fix,
// !result?.ok always fell into the 404 "That inspection no longer exists"
// branch, whatever the actual reason was. This route's job is to surface the
// backstop distinctly — a 422, terminal for the outbox (the SyncService
// dead-letters any 4xx), with a message the PM can act on, rather than
// telling them the inspection vanished.
// ============================================================================

const rpcMock = vi.fn()
const sendMock = vi.fn()
const auditMock = vi.fn()

vi.mock('@/lib/auth', () => ({
  requireOrgRole: vi.fn(async () => ({
    supabase:   { rpc: rpcMock },
    membership: { org_id: 'org_1' },
    user:       { id: 'user_1' },
  })),
}))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: (...a: unknown[]) => sendMock(...a) } }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: (...a: unknown[]) => auditMock(...a) }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { POST } from '@/app/api/inspections/[id]/submit/route'

const params = Promise.resolve({ id: 'insp_1' })

function req(body: unknown) {
  return new Request('https://app.fieldstay.app/api/inspections/insp_1/submit', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  }) as never
}

const VALID_BODY = {
  inspectorName: 'Jamie',
  items: [{
    form_item_id: 'f1', prompt_snapshot: 'Smoke detectors present', result: 'pass',
    actions: [], needs_cleaning: false, note: null, photo_path: null,
    photo_unavailable_reason: null, na_reason: null, value_number: null,
    value_text: null, value_date: null, asset_id: null, repeat_index: null,
    answered_at: null, repeat_answer: null, repeat_of_work_order_id: null,
  }],
}

beforeEach(() => vi.clearAllMocks())

describe('inspections submit route — completeness backstop result', () => {
  it('rejects with 422 and a distinct message when the RPC reports incomplete', async () => {
    rpcMock.mockResolvedValue({ data: { ok: false, reason: 'incomplete', missing_count: 12 }, error: null })

    const res = await POST(req(VALID_BODY), { params })

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/missing required answers/i)
    // Never claims the inspection is gone — that would send whoever reads it
    // looking in the wrong place entirely.
    expect(body.error).not.toMatch(/no longer exists/i)

    // No side effects for a rejected completion.
    expect(sendMock).not.toHaveBeenCalled()
    expect(auditMock).not.toHaveBeenCalled()
  })

  it('still reports 404 "no longer exists" for a genuinely missing inspection', async () => {
    rpcMock.mockResolvedValue({ data: { ok: false, reason: 'not_found' }, error: null })

    const res = await POST(req(VALID_BODY), { params })

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toMatch(/no longer exists/i)
  })

  it('still succeeds and fires the completion event on a genuine ok:true', async () => {
    rpcMock.mockResolvedValue({ data: { ok: true, items: 3 }, error: null })

    const res = await POST(req(VALID_BODY), { params })

    expect(res.status).toBe(200)
    expect(sendMock).toHaveBeenCalledTimes(1)
    expect(auditMock).toHaveBeenCalledTimes(1)
    // A genuine completion has nothing to compare a queued draft against.
    const body = await res.json()
    expect(body.recordedInspectorName).toBeUndefined()
  })

  it('surfaces what was actually recorded on a replay, so a mismatched local draft can be flagged', async () => {
    // The outbox drain can't otherwise distinguish "the server already has
    // my exact payload" from "the server has some earlier queued attempt
    // with different data" — an ack lost in flight, or a drain crash
    // between the server call succeeding and the local mutation row being
    // deleted, would otherwise read already_completed:true as unconditional
    // success with no way to detect the local draft has since diverged.
    rpcMock.mockResolvedValue({
      data: { ok: true, already_completed: true, inspector_name: 'Original Inspector' },
      error: null,
    })

    const res = await POST(req({ ...VALID_BODY, inspectorName: 'Edited Later' }), { params })

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.alreadyCompleted).toBe(true)
    expect(body.recordedInspectorName).toBe('Original Inspector')
    // A replay must not re-fire the completion event or re-audit.
    expect(sendMock).not.toHaveBeenCalled()
    expect(auditMock).not.toHaveBeenCalled()
  })
})

describe('inspections submit route — structural vs. transient RPC errors', () => {
  // form_item_id/asset_id are only type-checked by submit-payload.ts, never
  // verified to still exist. A queued offline draft (held in IndexedDB,
  // possibly across a release) can reference a form item retired by a seed
  // re-run, or an asset deleted between draft time and submit time — the
  // RPC's INSERT then raises a plain FK/cardinality violation for the WHOLE
  // batch. Before this fix every such error fell through to the generic 500
  // branch, which the outbox reads as transient and retries the identical,
  // permanently-failing payload forever — a completed walk, whose answers
  // exist nowhere else, that could never actually be submitted.
  it('dead-letters a foreign-key violation (23503) with 422, not a retryable 500', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: '23503', message: 'FK violation' } })

    const res = await POST(req(VALID_BODY), { params })

    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.ok).toBe(false)
    expect(body.error).toMatch(/references an item that no longer exists/i)
  })

  it('dead-letters a cardinality violation (21000 — duplicate item in one batch) with 422', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { code: '21000', message: 'ON CONFLICT DO UPDATE command cannot affect row a second time' } })

    const res = await POST(req(VALID_BODY), { params })

    expect(res.status).toBe(422)
  })

  it('still returns a retryable 500 for a genuinely transient error', async () => {
    // A connection blip has no stable Postgres error code matching the
    // structural set — it must still be retried, not dead-lettered.
    rpcMock.mockResolvedValue({ data: null, error: { code: '08006', message: 'connection failure' } })

    const res = await POST(req(VALID_BODY), { params })

    expect(res.status).toBe(500)
  })

  it('still returns a retryable 500 when the error carries no code at all', async () => {
    rpcMock.mockResolvedValue({ data: null, error: { message: 'unknown' } })

    const res = await POST(req(VALID_BODY), { params })

    expect(res.status).toBe(500)
  })
})
