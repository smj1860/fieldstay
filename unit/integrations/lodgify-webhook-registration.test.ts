import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// ensureLodgifyWebhookRegistration() — the kill switch and the token claim.
//
// TWO things are pinned here, and the second is the one that has already cost
// this codebase a bug one provider over (see
// unit/integrations/hostex-webhook-registration.test.ts):
//
//   1. THE FLAG GATES CREATION, NOT CLEANUP. LODGIFY_WEBHOOKS_ENABLED exists
//      because registration is the one call that WRITES to a prospect's own
//      Lodgify account, and its request shape is documented rather than
//      verified. Removal must run regardless — refusing to clean up because
//      the flag was turned off after registrations were created would strand
//      exactly the ones someone turned it off to stop.
//
//   2. THE TOKEN MINT IS AN ATOMIC CLAIM. Initial sync's register-webhook step
//      and the daily reconcile's ensure-webhook step can run concurrently for
//      the same connection (a manual resync during the reconcile's window).
//      Without `.is('webhook_token', null)` both mint a DIFFERENT token, both
//      UPDATE unconditionally, and each registers ITS OWN with Lodgify — so
//      Lodgify pushes to two URLs while the DB remembers one, and everything
//      landing on the orphan is rejected and lost.
// ============================================================================

const APP_URL = 'https://app.fieldstay.app'

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/integrations/providers/lodgify-api', () => ({
  lodgifyEnsureWebhook:  vi.fn(async () => ({ created: true })),
  lodgifyDeleteWebhooks: vi.fn(async () => ({ deleted: 3 })),
}))

import {
  ensureLodgifyWebhookRegistration,
  lodgifyWebhooksEnabled,
  removeLodgifyWebhookRegistration,
} from '@/lib/integrations/providers/lodgify-webhook'
import { createServiceClient } from '@/lib/supabase/server'
import { lodgifyEnsureWebhook, lodgifyDeleteWebhooks } from '@/lib/integrations/providers/lodgify-api'

/** Minimal PostgREST double — `claimResult` null models a lost race. */
function stubSupabase(opts: {
  existingToken: string | null
  claimResult?: { webhook_token: string } | null
  recheck?:     { webhook_token: string } | null
}) {
  const updates: Array<Record<string, unknown>> = []
  const guards:  string[] = []
  let selectCount = 0

  const chain: Record<string, unknown> = {}
  const self = () => chain

  Object.assign(chain, {
    select: () => { selectCount++; return chain },
    update: (p: Record<string, unknown>) => { updates.push(p); chain.__isUpdate = true; return chain },
    eq:     self,
    is:     (col: string) => { guards.push(col); return chain },
    maybeSingle: async () => {
      if (chain.__isUpdate) return { data: opts.claimResult ?? null, error: null }
      if (selectCount > 1)  return { data: opts.recheck ?? null, error: null }
      return { data: { webhook_token: opts.existingToken }, error: null }
    },
  })

  vi.mocked(createServiceClient).mockReturnValue({
    from: () => { chain.__isUpdate = false; return chain },
  } as never)

  return { updates, guards }
}

/** The target_url lodgifyEnsureWebhook was actually called with. */
function registeredUrl(): string {
  return vi.mocked(lodgifyEnsureWebhook).mock.calls.at(-1)![3] as string
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXT_PUBLIC_APP_URL', APP_URL)
  vi.stubEnv('LODGIFY_WEBHOOKS_ENABLED', 'true')
})

describe('the LODGIFY_WEBHOOKS_ENABLED gate', () => {
  it('registers nothing when the flag is unset', async () => {
    vi.stubEnv('LODGIFY_WEBHOOKS_ENABLED', '')
    const result = await ensureLodgifyWebhookRegistration('u1', 'key')

    expect(result).toEqual({ attempted: false, created: 0, reason: 'disabled' })
    expect(lodgifyEnsureWebhook).not.toHaveBeenCalled()
  })

  it("treats anything that is not exactly 'true' as off", async () => {
    // SMS_ENABLED's convention: a typo'd 'TRUE' must leave the feature OFF
    // rather than silently enabling a write to someone else's account.
    for (const value of ['TRUE', 'True', '1', 'yes']) {
      vi.stubEnv('LODGIFY_WEBHOOKS_ENABLED', value)
      expect(lodgifyWebhooksEnabled()).toBe(false)
    }
    vi.stubEnv('LODGIFY_WEBHOOKS_ENABLED', 'true')
    expect(lodgifyWebhooksEnabled()).toBe(true)
  })

  it('skips when no app URL is configured — there is no URL to register', async () => {
    vi.stubEnv('NEXT_PUBLIC_APP_URL', '')
    const result = await ensureLodgifyWebhookRegistration('u1', 'key')

    expect(result).toEqual({ attempted: false, created: 0, reason: 'no_app_url' })
    expect(lodgifyEnsureWebhook).not.toHaveBeenCalled()
  })

  it('subscribes every booking event when enabled', async () => {
    stubSupabase({ existingToken: 'tok-existing' })
    const result = await ensureLodgifyWebhookRegistration('u1', 'key')

    expect(result.attempted).toBe(true)
    // Three booking events; rate_change and guest messaging are deliberately
    // not subscribed — a delivery with no consumer is cost without benefit.
    expect(lodgifyEnsureWebhook).toHaveBeenCalledTimes(3)
    expect(result.created).toBe(3)
  })
})

describe('the webhook token', () => {
  it('reuses an existing token rather than minting a second one', async () => {
    // Rotating would orphan the URL already registered with Lodgify and
    // silently end delivery — a failure that looks like "the provider stopped
    // sending", which is close to unfalsifiable from our side.
    const { updates } = stubSupabase({ existingToken: 'tok-existing' })

    await ensureLodgifyWebhookRegistration('u1', 'key')

    expect(updates).toHaveLength(0)
    expect(registeredUrl()).toBe(`${APP_URL}/api/webhooks/lodgify/tok-existing`)
  })

  it('mints a token through an ATOMIC claim when none exists', async () => {
    const { updates, guards } = stubSupabase({
      existingToken: null,
      claimResult:   { webhook_token: 'tok-mine' },
    })

    await ensureLodgifyWebhookRegistration('u1', 'key')

    // The guard is what makes two concurrent mints settle instead of racing.
    expect(guards).toContain('webhook_token')
    // 32 bytes of crypto randomness as hex — this token is the ONLY credential
    // on an unauthenticated inbound path, so its entropy is the whole
    // authentication story.
    expect(updates[0]!.webhook_token).toMatch(/^[0-9a-f]{64}$/)
    // Registered with what the CLAIM returned, which is what the database
    // actually holds.
    expect(registeredUrl()).toBe(`${APP_URL}/api/webhooks/lodgify/tok-mine`)
  })

  it("registers the WINNER's token after losing the claim race", async () => {
    // THE bug this guard exists for: registering our own locally-minted token
    // after losing the write would leave Lodgify pushing to a URL the database
    // does not know, and every delivery there is rejected and gone.
    stubSupabase({
      existingToken: null,
      claimResult:   null,                             // lost the race
      recheck:       { webhook_token: 'tok-winner' },  // what actually landed
    })

    await ensureLodgifyWebhookRegistration('u1', 'key')

    expect(registeredUrl()).toBe(`${APP_URL}/api/webhooks/lodgify/tok-winner`)
  })

  it('REFUSES to register when the claim is lost AND the recheck finds nothing, rather than falling back to its own unpersisted token', async () => {
    // The atomic claim only fails to update when webhook_token was ALREADY
    // non-null — so some other value must be committed. If the recheck can't
    // find it either, that invariant broke somewhere, and silently falling
    // back to the token THIS call generated (which was never written to the
    // database) would register a Lodgify subscription pointed at a URL no
    // connection row can ever match: every delivery to it gets a clean 401
    // forever, with nothing anywhere connecting the silence back to this path.
    stubSupabase({
      existingToken: null,
      claimResult:   null, // lost the race
      recheck:       null, // AND the recheck found nothing — should never happen
    })

    await expect(ensureLodgifyWebhookRegistration('u1', 'key')).rejects.toThrow(/Lost the webhook-token claim race/)
    expect(lodgifyEnsureWebhook).not.toHaveBeenCalled()
  })
})

describe('removal', () => {
  it('runs even when the flag is OFF', async () => {
    // The flag governs creation. Refusing to clean up because it was turned
    // off would strand the registrations someone turned it off to stop.
    vi.stubEnv('LODGIFY_WEBHOOKS_ENABLED', '')
    stubSupabase({ existingToken: 'tok-existing' })

    const result = await removeLodgifyWebhookRegistration('u1', 'key')

    expect(lodgifyDeleteWebhooks).toHaveBeenCalledWith('key', 'u1', `${APP_URL}/api/webhooks/lodgify/tok-existing`)
    expect(result.deleted).toBe(3)
  })

  it('does nothing when no token was ever minted', async () => {
    stubSupabase({ existingToken: null })

    await expect(removeLodgifyWebhookRegistration('u1', 'key')).resolves.toEqual({ deleted: 0 })
    expect(lodgifyDeleteWebhooks).not.toHaveBeenCalled()
  })
})
