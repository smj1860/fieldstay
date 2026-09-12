import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, waitFor } from '@testing-library/react'

// ============================================================================
// THE TAB THAT SAT SIGNED OUT FOR 10.5 HOURS.
//
// On 2026-09-11 one machine produced 12 Sentry issues — five tables' worth of
// 42501 `permission denied` across two bursts 10.5 hours apart, ALL CARRYING
// ONE TRACE ID. One trace is one pageload, so this was a single tab, never
// reloaded, whose session had lapsed and was never renewed.
//
// It was never renewed because this guard had no wake signal that fired. A
// sleeping laptop runs no timers, and waking it with the tab already frontmost
// fires 'online' WITHOUT firing 'visibilitychange' — the one event this guard
// listened for. The dashboard warmers did listen for 'online', which is why
// they re-ran on the dead session and produced the errors.
//
// These tests cover that gap, the race that closing it introduces, and the
// isPublicPath bug that made the redirect dead code in the first place.
// ============================================================================

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

let session: unknown = { access_token: 'jwt' }
let refreshError: unknown = null
const getSession     = vi.fn(async () => ({ data: { session }, error: null }))
const refreshSession = vi.fn(async () => ({ data: { session }, error: refreshError }))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession, refreshSession } }),
}))

const { SessionRefreshGuard } = await import('@/components/session-refresh-guard')

/** Mount the guard as if the browser were sitting on `pathname`. */
function mountOn(pathname: string) {
  globalThis.history.replaceState({}, '', pathname)
  return render(<SessionRefreshGuard />)
}

/**
 * The two wake signals, named. The component listens for both; a machine
 * coming back from sleep can deliver either, or both at once.
 */
const wake = {
  online:     () => globalThis.dispatchEvent(new Event('online')),
  foreground: () => document.dispatchEvent(new Event('visibilitychange')),
}

beforeEach(() => {
  push.mockReset()
  getSession.mockClear()
  refreshSession.mockClear()
  session      = { access_token: 'jwt' }
  refreshError = null
})

describe('SessionRefreshGuard — wake signals', () => {
  it('refreshes when the network comes back', async () => {
    // The signal the 2026-09-11 tab actually received, and the only one it
    // received. Without this listener the guard never ran again all day.
    mountOn('/maintenance')

    wake.online()

    await waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1))
  })

  it('still refreshes when the tab is brought back to the foreground', async () => {
    mountOn('/maintenance')

    wake.foreground()

    await waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1))
  })

  it('stops listening for online once unmounted', async () => {
    mountOn('/maintenance').unmount()

    wake.online()

    await Promise.resolve()
    expect(refreshSession).not.toHaveBeenCalled()
  })
})

describe('SessionRefreshGuard — one refresh at a time', () => {
  it('does not run two refreshes when a wake fires both signals at once', async () => {
    // Waking a machine can fire 'online' and 'visibilitychange' together. The
    // refresh token ROTATES, so two concurrent refreshes race and the loser
    // presents a token the server has already retired — manufacturing exactly
    // the dead session this component exists to prevent.
    let release: () => void = () => {}
    getSession.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return { data: { session }, error: null }
    })

    mountOn('/maintenance')

    wake.online()
    wake.foreground()

    release()
    await waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1))
    expect(refreshSession).toHaveBeenCalledTimes(1)
  })

  it('allows a later refresh once the in-flight one has settled', async () => {
    // The serialisation must be a gate, not a latch — a guard that only ever
    // refreshed once would be a slower version of the same bug.
    mountOn('/maintenance')

    wake.online()
    await waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1))

    wake.online()
    await waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(2))
  })
})

describe('SessionRefreshGuard — where a dead session sends you', () => {
  // ── One table, both answers ───────────────────────────────────────────────
  //
  // Protected and public routes are checked from a SINGLE list on purpose.
  // '/' used to live in the prefix list and was matched with startsWith, and
  // every absolute path begins with '/', so isPublicPath() returned true for
  // every route in the app and this component's entire redirect half was dead
  // code. A suite that only proved '/' is public would have passed against
  // that bug; it is the pairing that catches it, so the pairing is structural
  // here rather than a convention someone has to keep remembering.
  const ROUTES: { pathname: string; redirectsTo: string | null; why: string }[] = [
    { pathname: '/maintenance',            redirectsTo: '/login?next=%2Fmaintenance',
      why: 'a PM goes back to the page they were on' },
    { pathname: '/crew/assets/abc',        redirectsTo: '/login?next=/crew',
      why: 'crew go to the crew entry point, not the crew URL they were on' },
    { pathname: '/loginhelp',              redirectsTo: '/login?next=%2Floginhelp',
      why: 'a bare startsWith would mistake this for the /login page' },
    { pathname: '/',                       redirectsTo: null,
      why: 'the marketing home page is genuinely public' },
    { pathname: '/login',                  redirectsTo: null,
      why: 'already somewhere they can sign in' },
    { pathname: '/work-orders/some-token', redirectsTo: null,
      why: 'a token-bearing child of a public section is still public' },
  ]

  it.each(ROUTES)('$pathname — $why', async ({ pathname, redirectsTo }) => {
    session = null
    mountOn(pathname)

    wake.online()

    await waitFor(() => expect(getSession).toHaveBeenCalled())
    if (redirectsTo === null) {
      expect(push).not.toHaveBeenCalled()
    } else {
      await waitFor(() => expect(push).toHaveBeenCalledWith(redirectsTo))
    }
  })

  it('redirects when the session exists but can no longer be refreshed', async () => {
    // The 2026-09-11 shape, and the one the table above cannot express: a
    // token IS present, so the early "no session" branch does not fire — the
    // server simply will not renew it. Reads then go out as `anon` and 42501
    // on every table.
    refreshError = { message: 'Invalid Refresh Token: Already Used' }
    mountOn('/maintenance')

    wake.online()

    await waitFor(() => expect(push).toHaveBeenCalledWith('/login?next=%2Fmaintenance'))
  })
})
