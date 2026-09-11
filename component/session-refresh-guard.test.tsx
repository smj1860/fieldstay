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
// These tests cover that gap and the race that closing it introduces.
// ============================================================================

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }))

let session: unknown = { access_token: 'jwt' }
let refreshError: unknown = null
const getSession    = vi.fn(async () => ({ data: { session }, error: null }))
const refreshSession = vi.fn(async () => ({ data: { session }, error: refreshError }))

vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({ auth: { getSession, refreshSession } }),
}))

const { SessionRefreshGuard } = await import('@/components/session-refresh-guard')

function setPathname(pathname: string) {
  globalThis.history.replaceState({}, '', pathname)
}

beforeEach(() => {
  push.mockReset()
  getSession.mockClear()
  refreshSession.mockClear()
  session      = { access_token: 'jwt' }
  refreshError = null
  setPathname('/maintenance')
})

describe('SessionRefreshGuard — wake signals', () => {
  it('refreshes when the network comes back', async () => {
    // The signal the 2026-09-11 tab actually received, and the only one it
    // received. Without this listener the guard never ran again all day.
    render(<SessionRefreshGuard />)

    globalThis.dispatchEvent(new Event('online'))

    await waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1))
  })

  it('still refreshes when the tab is brought back to the foreground', async () => {
    render(<SessionRefreshGuard />)

    document.dispatchEvent(new Event('visibilitychange'))

    await waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1))
  })

  it('stops listening for online once unmounted', async () => {
    const { unmount } = render(<SessionRefreshGuard />)
    unmount()

    globalThis.dispatchEvent(new Event('online'))

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

    render(<SessionRefreshGuard />)

    globalThis.dispatchEvent(new Event('online'))
    document.dispatchEvent(new Event('visibilitychange'))

    release()
    await waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1))
    expect(refreshSession).toHaveBeenCalledTimes(1)
  })

  it('allows a later refresh once the in-flight one has settled', async () => {
    // The serialisation must be a gate, not a latch — a guard that only ever
    // refreshed once would be a slower version of the same bug.
    render(<SessionRefreshGuard />)

    globalThis.dispatchEvent(new Event('online'))
    await waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(1))

    globalThis.dispatchEvent(new Event('online'))
    await waitFor(() => expect(refreshSession).toHaveBeenCalledTimes(2))
  })
})

describe('SessionRefreshGuard — where a dead session sends you', () => {
  it('sends a PM back to the page they were on', async () => {
    session = null
    render(<SessionRefreshGuard />)
    globalThis.dispatchEvent(new Event('online'))

    await waitFor(() => expect(push).toHaveBeenCalledWith('/login?next=%2Fmaintenance'))
  })

  it('sends crew to the crew entry point, not the crew URL they were on', async () => {
    setPathname('/crew/assets/abc')
    session = null
    render(<SessionRefreshGuard />)
    globalThis.dispatchEvent(new Event('online'))

    await waitFor(() => expect(push).toHaveBeenCalledWith('/login?next=/crew'))
  })

  it('redirects when the session exists but can no longer be refreshed', async () => {
    // The 2026-09-11 shape: a token is present, the server will not renew it.
    // Reads then go out as `anon` and 42501 on every table.
    refreshError = { message: 'Invalid Refresh Token: Already Used' }
    render(<SessionRefreshGuard />)
    globalThis.dispatchEvent(new Event('online'))

    await waitFor(() => expect(push).toHaveBeenCalledWith('/login?next=%2Fmaintenance'))
  })

  it('treats the home page as public but a dashboard route as protected', async () => {
    // '/' lived in the prefix list and was matched with startsWith, so every
    // absolute path in the app counted as public and this component's entire
    // redirect half was dead code. The pair is the point: a check that only
    // proved '/' is public would have passed before the fix too.
    setPathname('/')
    session = null
    render(<SessionRefreshGuard />)
    globalThis.dispatchEvent(new Event('online'))
    await waitFor(() => expect(getSession).toHaveBeenCalled())
    expect(push).not.toHaveBeenCalled()
  })

  it('does not mistake /loginhelp for the /login page', async () => {
    // A bare startsWith has no segment boundary.
    setPathname('/loginhelp')
    session = null
    render(<SessionRefreshGuard />)
    globalThis.dispatchEvent(new Event('online'))

    await waitFor(() => expect(push).toHaveBeenCalledWith('/login?next=%2Floginhelp'))
  })

  it('still treats a token-bearing public child as public', async () => {
    setPathname('/work-orders/some-token')
    session = null
    render(<SessionRefreshGuard />)
    globalThis.dispatchEvent(new Event('online'))

    await waitFor(() => expect(getSession).toHaveBeenCalled())
    expect(push).not.toHaveBeenCalled()
  })

  it('leaves someone on a public page alone', async () => {
    setPathname('/login')
    session = null
    render(<SessionRefreshGuard />)
    globalThis.dispatchEvent(new Event('online'))

    await waitFor(() => expect(getSession).toHaveBeenCalled())
    expect(push).not.toHaveBeenCalled()
  })
})
