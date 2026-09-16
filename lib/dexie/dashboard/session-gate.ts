'use client'

// lib/dexie/dashboard/session-gate.ts
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY A WARM PASS HAS TO ASK WHETHER IT IS STILL SIGNED IN
//
// On 2026-09-11 at 09:13:11 UTC a single tablet produced four Sentry issues in
// 1.1 seconds — `permission denied for table` (42501) on maintenance_schedules,
// inspection_forms, vendors and inspections — and they read as an RLS
// regression across four unrelated tables in one org. They were not.
//
// 42501 is a GRANT failure, evaluated BEFORE RLS. An RLS denial returns zero
// rows with a 200 and can never produce it. `authenticated` holds SELECT on all
// four tables and `anon` holds no table grants at all (revoked 2026-07-24), so
// there is exactly one way to get that error here: the request went out with no
// usable JWT and PostgREST evaluated it as `anon`.
//
// The warmers are what sent it. They mount in the dashboard layout and fire on
// mount and on 'online', independently of SessionRefreshGuard — which redirects
// to /login on a failed refresh, but only after its own async check resolves.
// A tab waking with a lapsed (or unrefreshable — a rotated refresh token
// consumed by a second tab does this) session therefore gets a window in which
// ~8 reads go out unauthenticated, all of them failing, all of them reported at
// `level: error`. A routine session expiry rendered as a four-table security
// incident, and cost a morning triage pass to rule out.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY getSession() IS THE RIGHT QUESTION AND A STORED-TOKEN PEEK IS NOT
//
// supabase-js's getSession() does not merely read storage: when the stored
// access token has expired it attempts the refresh and returns null if that
// refresh fails. So this gate performs exactly the check that matters — not
// "is there a token" but "can this client still authenticate" — and it performs
// it in the same client singleton the warm's own queries will use, so a refresh
// it triggers is the one those queries then benefit from.
//
// Fails CLOSED. Anything unexpected here means we cannot show that the client
// can authenticate, and the safe answer for a best-effort prefetch is to skip
// the pass: a warm that does not run costs a device nothing it had before,
// while a warm that runs unauthenticated costs a false security alert.

import { createClient } from '@/lib/supabase/client'
import { DASHBOARD_WARM_TIMEOUT_MS, withTimeout } from '@/lib/http/timeout'

/**
 * Whether the browser still holds a Supabase session it can authenticate with.
 *
 * Call this before any warm pass's first query. Never throws.
 *
 * RACED, not aborted: `auth.getSession()` takes no `AbortSignal` parameter,
 * so nothing here can make gotrue-js actually stop trying. What this closes
 * is the same failure every other warm-path call closes with a real
 * AbortSignal — a hung request that never settles, which meant this gate's
 * caller never got an answer either, and the whole warm pass (and the
 * module-level in-flight entry tracking it) was wedged for the tab's life.
 * Abandoning a `getSession()` call has no side effect to leave dangling, so
 * racing it is safe the same way it is for `sendWithTimeout()` in
 * lib/resend/client.ts.
 */
type SessionResponse = Awaited<ReturnType<ReturnType<typeof createClient>['auth']['getSession']>>

export async function hasUsableSession(): Promise<boolean> {
  try {
    const { data } = await withTimeout<SessionResponse>(
      () => createClient().auth.getSession(),
      DASHBOARD_WARM_TIMEOUT_MS,
      'hasUsableSession',
    )
    return Boolean(data.session)
  } catch {
    return false
  }
}
