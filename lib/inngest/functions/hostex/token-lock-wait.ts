// lib/inngest/functions/hostex/token-lock-wait.ts
// ============================================================================
// Waits for a concurrent Hostex token refresh to finish via TOP-LEVEL
// step.sleep, before any step in this run spends a Hostex token.
//
// ── The defect this closes ──────────────────────────────────────────────────
//
// getValidHostexToken()'s non-lock-holder path used to spin in a real
// polling `for` loop (~160 iterations x 250ms, each a live Supabase query)
// INSIDE the step.run() callback that called it — see
// lib/integrations/providers/hostex-token.ts's refreshHostexTokenLocked.
// That held a full serverless execution slot open for up to ~40s doing
// nothing but waiting, for every Hostex sync that happened to run while
// another one was mid-refresh for the same connection — which gets more
// likely, not less, as connection count and sync frequency grow.
//
// getToken() closures are called from deep inside step.run bodies across
// every Hostex Inngest function (reservation-sync.ts, reviews-sync.ts,
// staff-sync.ts — see their own comments on why the token is a GETTER
// resolved per-step rather than a value hoisted once), so the busy-wait
// itself cannot simply be replaced with step.sleep in place: step tooling
// nested inside a step.run is exactly what
// unit/guardrails/inngest-nested-steps.test.ts exists to catch, and this
// file therefore lives under lib/inngest/ rather than
// lib/integrations/providers/ — the second clause of that guardrail bans
// step tooling in ANY shared lib/ module outside this tree, precisely so a
// helper like this one cannot hide it somewhere a reviewer of the Inngest
// function won't look.
//
// ── The fix ──────────────────────────────────────────────────────────────
//
// Call this ONCE, at the TOP LEVEL of a Hostex Inngest function (before any
// step.run that will eventually call getToken()/getValidHostexToken()). It
// checks — via a real step.run boundary — whether a refresh for this user is
// currently locked, and if so `step.sleep`s BETWEEN checks rather than
// blocking a live invocation. step.sleep suspends the function; Inngest
// resumes it later without holding compute the whole time.
//
// This does not eliminate refreshHostexTokenLocked's own in-step fallback
// wait — a fresh race can still open between this check and the later
// step.run that actually spends the token — but it is what handles the
// COMMON, LONG case (another run genuinely mid-refresh), which is why that
// fallback's own ceiling was shrunk once this existed. See that file's
// REFRESH_LOCK_MAX_WAITS comment.
// ============================================================================

import type { GetStepTools } from 'inngest'
import { inngest } from '@/lib/inngest/client'
import { isRefreshLockHeld } from '@/lib/integrations/refresh-lock'

type SyncStep = GetStepTools<typeof inngest>

/** 8 x 5s = 40s — matches the previous busy-wait's ceiling, in far fewer steps. */
const WAIT_ITERATIONS    = 8
const WAIT_SECONDS       = 5

/**
 * Suspends (via step.sleep) while another run holds the Hostex refresh lock
 * for `userId`. Returns as soon as the lock is free, or once the wait budget
 * is exhausted — the caller's own getToken()/getValidHostexToken() calls are
 * always safe to proceed after either outcome, since refreshHostexTokenLocked
 * still holds its own short fallback wait for the residual race.
 */
export async function waitForHostexTokenRefresh(step: SyncStep, userId: string): Promise<void> {
  for (let i = 0; i < WAIT_ITERATIONS; i++) {
    const locked = await step.run(`check-hostex-refresh-lock-${i}`, () => isRefreshLockHeld('hostex', userId))
    if (!locked) return
    await step.sleep(`wait-hostex-refresh-lock-${i}`, `${WAIT_SECONDS}s`)
  }
}
