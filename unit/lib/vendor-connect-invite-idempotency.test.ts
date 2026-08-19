import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/stripe/client', () => ({ stripe: { accounts: { create: vi.fn() } } }))
vi.mock('@/lib/resend/client', () => ({ resend: { emails: { send: vi.fn() } }, FROM: 'test@fieldstay.app' }))
vi.mock('@/lib/resend/emails/vendor-connect-invite', () => ({
  renderVendorConnectInviteEmail: vi.fn(async () => '<p>invite</p>'),
}))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { createServiceClient } from '@/lib/supabase/server'
import { resend } from '@/lib/resend/client'
import { ensureVendorConnectInvited, resendVendorConnectInvite } from '@/lib/stripe/vendor-connect-invite'

// ============================================================================
// GitHub #574 — invite delivery must be idempotent across a failed sent-status
// write.
//
// markVendorConnectInviteSent() is non-fatal by design: the email has already
// gone out when it runs, so throwing would not un-send it. But when that write
// failed, the only durable record of delivery was lost, and the next cron tick
// / work-order dispatch / PM resend saw an unsent invite and emailed the vendor
// AGAIN. The claim could not help — it is released in a `finally` and goes
// stale after two minutes by design.
//
// The fix stores a delivery reference before sending and presents it as
// Resend's Idempotency-Key. The automatic senders REUSE it (so the retry
// deduplicates); the PM resend ROTATES it (so a deliberate resend is not
// deduplicated away).
// ============================================================================

/**
 * A vendors table that behaves like the real one for this flow: the claim
 * UPDATE returns the row, subsequent writes mutate it, and `failWrites`
 * simulates the transient persistence failure the issue is about.
 */
function makeSupabase(row: {
  stripe_connect_account_id: string | null
  stripe_connect_invite_sent_at: string | null
  stripe_connect_invite_delivery_ref: string | null
}, opts: { failSentWrite?: boolean } = {}) {
  const state = { ...row }
  const writes: Record<string, unknown>[] = []

  const from = vi.fn(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    let payload: Record<string, unknown> = {}

    chain.update = (p: Record<string, unknown>) => { payload = p; return chain }
    chain.select = () => chain
    for (const m of ['eq', 'or', 'not', 'order', 'limit']) chain[m] = () => chain

    const apply = () => {
      writes.push(payload)
      // The sent-status write is the one the issue says fails transiently.
      if (opts.failSentWrite && 'stripe_connect_invite_sent_at' in payload) {
        return { data: null, error: { message: 'transient write failure' } }
      }
      Object.assign(state, payload)
      return { data: { ...state, id: 'v1' }, error: null }
    }

    chain.maybeSingle = () => Promise.resolve(apply())
    chain.then = (res: (v: unknown) => unknown) => Promise.resolve(apply()).then(res)
    return chain
  })

  return { client: { from }, state, writes }
}

const params = {
  vendorId: 'v1', orgId: 'o1',
  vendorEmail: 'vendor@example.com', vendorName: 'Vendor',
  vendorConnectToken: 'tok', orgName: 'Org',
}

const sentKeys = () =>
  vi.mocked(resend.emails.send).mock.calls.map((c) => (c[1] as { idempotencyKey?: string })?.idempotencyKey)

describe('vendor Connect invite — delivery idempotency (#574)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(resend.emails.send).mockResolvedValue({ data: { id: 'e1' }, error: null } as never)
  })

  it('sends with a stored idempotency key rather than none at all', async () => {
    const { client, state } = makeSupabase({
      stripe_connect_account_id: 'acct_1', stripe_connect_invite_sent_at: null,
      stripe_connect_invite_delivery_ref: null,
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    await ensureVendorConnectInvited(params)

    const [key] = sentKeys()
    expect(key).toBeDefined()
    // The key must be the reference that was PERSISTED, or a retry has nothing
    // to present and deduplicates against nothing.
    expect(key).toBe(`vendor-connect-invite-${state.stripe_connect_invite_delivery_ref}`)
  })

  it('THE BUG: a retry after a failed sent-status write reuses the SAME key', async () => {
    // Attempt 1: email sends, the sent-status write fails, delivery reference
    // survives on the row.
    const first = makeSupabase({
      stripe_connect_account_id: 'acct_1', stripe_connect_invite_sent_at: null,
      stripe_connect_invite_delivery_ref: null,
    }, { failSentWrite: true })
    vi.mocked(createServiceClient).mockReturnValue(first.client as never)
    await ensureVendorConnectInvited(params)

    const ref = first.state.stripe_connect_invite_delivery_ref
    expect(ref, 'the reference must outlive the failed sent-status write').not.toBeNull()

    // Attempt 2: the next cron tick sees an unsent invite and runs again.
    vi.clearAllMocks()
    vi.mocked(resend.emails.send).mockResolvedValue({ data: { id: 'e2' }, error: null } as never)
    const second = makeSupabase({
      stripe_connect_account_id: 'acct_1', stripe_connect_invite_sent_at: null,
      stripe_connect_invite_delivery_ref: ref,
    })
    vi.mocked(createServiceClient).mockReturnValue(second.client as never)
    await ensureVendorConnectInvited(params)

    // Same key => Resend rejects it as a duplicate rather than delivering a
    // second invite. Without the stored reference this attempt would have
    // generated a fresh key and the vendor would get two emails.
    expect(sentKeys()[0]).toBe(`vendor-connect-invite-${ref}`)
  })

  it('does not re-send at all once the sent status DID persist', async () => {
    const { client } = makeSupabase({
      stripe_connect_account_id: 'acct_1',
      stripe_connect_invite_sent_at: '2026-08-19T00:00:00Z',
      stripe_connect_invite_delivery_ref: 'ref-1',
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    const result = await ensureVendorConnectInvited(params)

    expect(result).toEqual({ invited: false })
    expect(resend.emails.send).not.toHaveBeenCalled()
  })

  it('clears the reference when the send THROWS, so a retry is a real send', async () => {
    // A failed send must not leave a key behind: the retry would present a key
    // Resend may already have seen, and the re-send of a FAILED delivery would
    // be deduplicated into never being sent — a transient error turned into a
    // permanently missing invite.
    const { client, state } = makeSupabase({
      stripe_connect_account_id: 'acct_1', stripe_connect_invite_sent_at: null,
      stripe_connect_invite_delivery_ref: null,
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)
    vi.mocked(resend.emails.send).mockRejectedValue(new Error('resend 500'))

    await expect(ensureVendorConnectInvited(params)).rejects.toThrow('resend 500')
    expect(state.stripe_connect_invite_delivery_ref).toBeNull()
  })

  it('PM resend ROTATES the key, so a deliberate resend is not deduplicated', async () => {
    // The opposite requirement to the automatic path. Reusing the stored key
    // here would have Resend swallow the email and the button would silently
    // do nothing.
    const { client } = makeSupabase({
      stripe_connect_account_id: 'acct_1',
      stripe_connect_invite_sent_at: '2026-08-19T00:00:00Z',
      stripe_connect_invite_delivery_ref: 'ref-old',
    })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    await resendVendorConnectInvite(params)

    expect(resend.emails.send).toHaveBeenCalledTimes(1)
    expect(sentKeys()[0]).not.toBe('vendor-connect-invite-ref-old')
  })

  it('every send in both paths carries a key — none may go out unprotected', async () => {
    for (const run of [
      () => ensureVendorConnectInvited(params),
      () => resendVendorConnectInvite(params),
    ]) {
      vi.clearAllMocks()
      vi.mocked(resend.emails.send).mockResolvedValue({ data: { id: 'e' }, error: null } as never)
      const { client } = makeSupabase({
        stripe_connect_account_id: 'acct_1', stripe_connect_invite_sent_at: null,
        stripe_connect_invite_delivery_ref: null,
      })
      vi.mocked(createServiceClient).mockReturnValue(client as never)

      await run()
      for (const key of sentKeys()) expect(key).toMatch(/^vendor-connect-invite-.+/)
    }
  })
})
