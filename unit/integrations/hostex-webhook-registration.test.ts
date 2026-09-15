import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// ensureHostexWebhookRegistration()'s token mint used to have no atomic
// claim, unlike the inbound secret-hash TOFU claim in
// app/api/webhooks/hostex/[token]/route.ts. Initial-sync and the daily
// reconcile cron can both reach this function for the same user concurrently
// — a connection is dispatchable by the reconcile cron the instant OAuth
// completes, well before initial-sync's own register-webhook step runs.
//
// Without `.is('webhook_token', null)`, two concurrent callers would each
// mint a DIFFERENT random token, both UPDATE with no guard, and — the actual
// bug — each would still register ITS OWN locally-minted token with Hostex
// regardless of which DB write won. Hostex ends up pushing events to two
// URLs while the DB remembers only one; every delivery landing on the
// orphaned URL 401s and is gone for good, since Hostex never retries.
//
// The fix mirrors the route's claim: on a lost race, re-read and register
// the WINNER's token, never the caller's own.
// ============================================================================

const NEXT_PUBLIC_APP_URL = 'https://app.fieldstay.app'

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn() }))
vi.mock('@/lib/integrations/providers/hostex-api', () => ({
  hostexEnsureWebhook: vi.fn(async () => ({ created: true })),
  hostexDeleteWebhook: vi.fn(async () => ({ deleted: 0 })),
}))

import { ensureHostexWebhookRegistration } from '@/lib/integrations/providers/hostex-webhook'
import { createServiceClient } from '@/lib/supabase/server'
import { hostexEnsureWebhook } from '@/lib/integrations/providers/hostex-api'

/**
 * Minimal PostgREST double, same shape as the webhook route's own test:
 * `claimResult` is what the atomic UPDATE...WHERE webhook_token IS NULL
 * resolves to — null models "someone else claimed first".
 */
function stubSupabase(opts: {
  existingToken: string | null
  claimResult?: Record<string, unknown> | null
  recheck?: Record<string, unknown> | null
}) {
  const updates: Array<Record<string, unknown>> = []
  let selectCount = 0

  const chain: Record<string, unknown> = {}
  const self = () => chain

  Object.assign(chain, {
    select: () => { selectCount++; return chain },
    update: (p: Record<string, unknown>) => { updates.push(p); chain.__isUpdate = true; return chain },
    eq: self,
    is: self,
    maybeSingle: async () => {
      if (chain.__isUpdate) return { data: opts.claimResult ?? null, error: null }
      if (selectCount > 1) return { data: opts.recheck ?? null, error: null }
      return { data: { webhook_token: opts.existingToken }, error: null }
    },
  })

  vi.mocked(createServiceClient).mockReturnValue({
    from: () => { chain.__isUpdate = false; return chain },
  } as never)

  return { updates }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.NEXT_PUBLIC_APP_URL = NEXT_PUBLIC_APP_URL
})

describe('ensureHostexWebhookRegistration — token mint race', () => {
  it('claims the token atomically and registers its own token on an uncontested mint', async () => {
    const { updates } = stubSupabase({ existingToken: null, claimResult: { webhook_token: 'placeholder' } })

    await ensureHostexWebhookRegistration('user_1', 'access_token')

    expect(updates).toHaveLength(1)
    const registeredUrl = vi.mocked(hostexEnsureWebhook).mock.calls[0]![2]
    // The token registered with Hostex must be the exact one the atomic
    // UPDATE just wrote — not re-derived, not re-generated.
    const writtenToken = updates[0]!['webhook_token'] as string
    expect(registeredUrl).toBe(`${NEXT_PUBLIC_APP_URL}/api/webhooks/hostex/${writtenToken}`)
  })

  it('registers the WINNER token, not its own, when it loses the mint race', async () => {
    const winnerToken = 'winner-token-value'
    const { updates } = stubSupabase({
      existingToken: null,
      claimResult:   null, // this caller's UPDATE matched no row — someone else claimed first
      recheck:       { webhook_token: winnerToken },
    })

    await ensureHostexWebhookRegistration('user_1', 'access_token')

    // Only the loser's own (now-discarded) UPDATE attempt was issued.
    expect(updates).toHaveLength(1)

    const registeredUrl = vi.mocked(hostexEnsureWebhook).mock.calls[0]![2]
    expect(registeredUrl).toBe(`${NEXT_PUBLIC_APP_URL}/api/webhooks/hostex/${winnerToken}`)
    // Critically: NOT the token this call locally minted and tried to claim.
    expect(registeredUrl).not.toBe(`${NEXT_PUBLIC_APP_URL}/api/webhooks/hostex/${updates[0]!['webhook_token']}`)
  })

  it('reuses an already-stored token with no write at all', async () => {
    const { updates } = stubSupabase({ existingToken: 'already-there' })

    await ensureHostexWebhookRegistration('user_1', 'access_token')

    expect(updates).toHaveLength(0)
    const registeredUrl = vi.mocked(hostexEnsureWebhook).mock.calls[0]![2]
    expect(registeredUrl).toBe(`${NEXT_PUBLIC_APP_URL}/api/webhooks/hostex/already-there`)
  })
})
