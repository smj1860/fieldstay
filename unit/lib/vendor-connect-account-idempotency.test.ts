import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/stripe/client', () => ({
  stripe: { accounts: { create: vi.fn(), list: vi.fn() } },
}))
vi.mock('@/lib/resend/client', () => ({ resend: { emails: { send: vi.fn() } }, FROM: 'test@fieldstay.app' }))
vi.mock('@/lib/resend/emails/vendor-connect-invite', () => ({
  renderVendorConnectInviteEmail: vi.fn(async () => '<p>invite</p>'),
}))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { createServiceClient } from '@/lib/supabase/server'
import { stripe } from '@/lib/stripe/client'
import { resend } from '@/lib/resend/client'
import { ensureVendorConnectInvited } from '@/lib/stripe/vendor-connect-invite'

// ============================================================================
// GitHub #573 — Express account creation must not duplicate across a failed
// persistence.
//
// The flow was: stripe.accounts.create() → write the id to
// vendors.stripe_connect_account_id. If that write failed, the account existed
// in Stripe and nothing in our database knew about it — and the retry, reading
// a null account id, created a SECOND Express account for the same vendor.
//
// #574's fix (a preceding change) made a zero-row persist fail LOUDLY. Loudly
// is not idempotently: the account was still orphaned, and the next attempt
// still duplicated it. That distinction is what this file exists to hold.
//
// Two mechanisms, deliberately complementary, and both asserted here:
//
//   - a vendor-stable Stripe idempotency key. Stripe retains keys for 24
//     HOURS, so a retry inside that window replays the original account.
//   - stripe_connect_account_pending_at, written BEFORE the Stripe call and
//     cleared with the id. It is the durable record that an attempt reached
//     Stripe, and it is what makes a retry DAYS later — outside the key's
//     window — reconcile instead of duplicate.
//
// The second exists precisely because the first expires. A test suite that
// only checked the key would pass while the slow-retry case stayed broken.
// ============================================================================

type VendorRow = {
  stripe_connect_account_id:         string | null
  stripe_connect_account_pending_at: string | null
  stripe_connect_invite_sent_at:     string | null
  stripe_connect_invite_delivery_ref: string | null
}

/**
 * A vendors table plus an ORDERED log of everything that touched the outside
 * world, so "the marker was written before Stripe was called" is assertable
 * rather than assumed.
 */
function makeSupabase(row: Partial<VendorRow>, opts: { failAccountPersist?: boolean } = {}) {
  const state: VendorRow = {
    stripe_connect_account_id:          null,
    stripe_connect_account_pending_at:  null,
    stripe_connect_invite_sent_at:      null,
    stripe_connect_invite_delivery_ref: null,
    ...row,
  }
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
      events.push(`db:${Object.keys(payload).sort().join('+')}`)
      if (opts.failAccountPersist && 'stripe_connect_account_id' in payload) {
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

/** Ordered log of DB writes and Stripe calls, shared across a single test. */
let events: string[] = []

const params = {
  vendorId: 'v1', orgId: 'o1',
  vendorEmail: 'vendor@example.com', vendorName: 'Vendor',
  vendorConnectToken: 'tok', orgName: 'Org',
}

const acct = (id: string, vendorId = 'v1') => ({ id, metadata: { vendor_id: vendorId } })

// Stripe's SDK declares accounts.create/list with overloads whose 1-arg form
// wins inference, so vi.mocked() types `mock.calls[0]` as a 1-tuple and rejects
// a plain async stub for the ApiListPromise return. These aliases narrow to the
// mock surface the assertions actually use, once and with a reason, rather than
// scattering casts through every test.
type MockFn = ReturnType<typeof vi.fn>
const createMock = stripe.accounts.create as unknown as MockFn
const listMock   = stripe.accounts.list   as unknown as MockFn

beforeEach(() => {
  vi.clearAllMocks()
  events = []
  vi.mocked(resend.emails.send).mockResolvedValue({ data: { id: 'e1' }, error: null } as never)
  createMock.mockImplementation(async () => {
    events.push('stripe:create')
    return acct('acct_new')
  })
  listMock.mockImplementation(async () => {
    events.push('stripe:list')
    return { data: [], has_more: false }
  })
})

describe('vendor Connect account creation — idempotency (#573)', () => {
  it('keys account creation to the VENDOR, so two attempts collide', async () => {
    const { client } = makeSupabase({})
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    await ensureVendorConnectInvited(params)

    const [, opts] = createMock.mock.calls[0]!
    expect((opts as { idempotencyKey?: string }).idempotencyKey).toBe('fs-vendor-acct-v1')
  })

  it('records the intent BEFORE calling Stripe', async () => {
    // The ordering IS the mechanism. Marking after the call would leave the
    // same unrecorded-account gap the marker exists to close, just narrower.
    const { client } = makeSupabase({})
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    await ensureVendorConnectInvited(params)

    const markIdx   = events.indexOf('db:stripe_connect_account_pending_at')
    const createIdx = events.indexOf('stripe:create')
    expect(markIdx).toBeGreaterThanOrEqual(0)
    expect(markIdx).toBeLessThan(createIdx)
  })

  it('clears the marker in the SAME write that stores the account id', async () => {
    const { client, writes } = makeSupabase({})
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    await ensureVendorConnectInvited(params)

    const persist = writes.find((w) => 'stripe_connect_account_id' in w)!
    expect(persist).toMatchObject({
      stripe_connect_account_id:         'acct_new',
      stripe_connect_account_pending_at: null,
    })
  })

  it('does not scan Stripe on an ordinary first invite', async () => {
    // Reconciliation is a full account listing. Putting it on the hot path
    // would make every new vendor pay for a failure mode that has not
    // happened.
    const { client } = makeSupabase({})
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    await ensureVendorConnectInvited(params)

    expect(listMock).not.toHaveBeenCalled()
  })

  it('THE ISSUE: a retry after a failed persist reuses the orphan, it does not create a second account', async () => {
    // Attempt 1 — Stripe creates acct_orphan, the persist fails, the invite
    // throws. The account now exists in Stripe with nothing pointing at it.
    const first = makeSupabase({}, { failAccountPersist: true })
    vi.mocked(createServiceClient).mockReturnValue(first.client as never)
    createMock.mockImplementation(async () => {
      events.push('stripe:create')
      return acct('acct_orphan')
    })

    await expect(ensureVendorConnectInvited(params)).rejects.toThrow()

    // The marker survived, because it was written before the call and the
    // failed write is the one that would have cleared it.
    expect(first.state.stripe_connect_account_pending_at).not.toBeNull()
    expect(first.state.stripe_connect_account_id).toBeNull()

    // Attempt 2 — days later, outside Stripe's 24h key window, so the key
    // cannot save us. The marker is what does.
    //
    // The create mock is cleared, not just re-stubbed: the assertion below is
    // "attempt 2 created nothing", and attempt 1's legitimate call would
    // otherwise satisfy it on its own and hide a real duplicate.
    events = []
    createMock.mockClear()
    const second = makeSupabase({ stripe_connect_account_pending_at: '2026-08-20T00:00:00Z' })
    vi.mocked(createServiceClient).mockReturnValue(second.client as never)
    listMock.mockImplementation(async () => {
      events.push('stripe:list')
      return { data: [acct('acct_orphan')], has_more: false } as never
    })

    await ensureVendorConnectInvited(params)

    expect(createMock, 'a second Express account is the entire defect').not.toHaveBeenCalled()
    expect(second.state.stripe_connect_account_id).toBe('acct_orphan')
    expect(second.state.stripe_connect_account_pending_at).toBeNull()
  })

  it('persists the reconciled account id BEFORE the invite email goes out', async () => {
    const { client } = makeSupabase({ stripe_connect_account_pending_at: '2026-08-20T00:00:00Z' })
    vi.mocked(createServiceClient).mockReturnValue(client as never)
    listMock.mockResolvedValue(
      { data: [acct('acct_orphan')], has_more: false },
    )
    vi.mocked(resend.emails.send).mockImplementation(async () => {
      events.push('resend:send')
      return { data: { id: 'e1' }, error: null } as never
    })

    await ensureVendorConnectInvited(params)

    const persistIdx = events.indexOf('db:stripe_connect_account_id+stripe_connect_account_pending_at')
    const sendIdx    = events.indexOf('resend:send')
    expect(persistIdx).toBeGreaterThanOrEqual(0)
    expect(persistIdx).toBeLessThan(sendIdx)
  })

  it('reconciles when Stripe rejects the key as reused with different parameters', async () => {
    // Happens when the PM edits the vendor's email between attempts. The
    // account that already exists is the one we want, whatever address it was
    // opened with — creating another would be the duplicate again.
    const { client, state } = makeSupabase({})
    vi.mocked(createServiceClient).mockReturnValue(client as never)
    createMock.mockRejectedValue(
      Object.assign(new Error('Keys for idempotent requests can only be used with the same parameters'), {
        type: 'idempotency_error',
      }),
    )
    listMock.mockResolvedValue(
      { data: [acct('acct_orphan')], has_more: false },
    )

    await ensureVendorConnectInvited(params)

    expect(state.stripe_connect_account_id).toBe('acct_orphan')
  })

  it('throws rather than creating a duplicate when the orphan scan runs out of pages', async () => {
    // Returning null here would read as "no orphan exists" and create a second
    // account — reintroducing the exact defect, in the one situation where an
    // orphan is most likely.
    const { client } = makeSupabase({ stripe_connect_account_pending_at: '2026-08-20T00:00:00Z' })
    vi.mocked(createServiceClient).mockReturnValue(client as never)
    listMock.mockResolvedValue(
      { data: [acct('acct_other', 'someone_else')], has_more: true },
    )

    await expect(ensureVendorConnectInvited(params)).rejects.toThrow(/Refusing to create a new Express account/)
    expect(createMock).not.toHaveBeenCalled()
  })

  it('creates once when the marker is set but no orphan actually exists', async () => {
    // The interrupted attempt failed BEFORE Stripe, not after. Reconciliation
    // finds nothing, and creating is then correct — the marker means "maybe",
    // not "definitely".
    const { client, state } = makeSupabase({ stripe_connect_account_pending_at: '2026-08-20T00:00:00Z' })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    await ensureVendorConnectInvited(params)

    expect(listMock).toHaveBeenCalledTimes(1)
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(state.stripe_connect_account_id).toBe('acct_new')
  })

  it('never touches Stripe when the vendor already has an account', async () => {
    const { client } = makeSupabase({ stripe_connect_account_id: 'acct_existing' })
    vi.mocked(createServiceClient).mockReturnValue(client as never)

    await ensureVendorConnectInvited(params)

    expect(createMock).not.toHaveBeenCalled()
    expect(listMock).not.toHaveBeenCalled()
  })
})
