import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * CAN-SPAM opt-out coverage.
 *
 * The defect this encodes: `profiles.email_unsubscribed_at` existed and was
 * READ by onboarding-drip to suppress emails 2 and 3, but a grep of the entire
 * repo found NOTHING that ever WROTE it — no route, no server action, no
 * webhook — and no email template carried an unsubscribe link. The suppression
 * check was unreachable dead code, and every commercial send went out with no
 * opt-out mechanism of any kind.
 *
 * The failure mode is that it looks handled. Reading a suppression flag reads
 * as compliance at a glance; only tracing who writes it reveals that nobody
 * does. So these assert the full loop is connected end to end, not that a
 * particular string appears somewhere.
 */

const ROOT = join(__dirname, '..', '..')
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8')

/**
 * Every file that sends COMMERCIAL email, and the audience variable each send
 * must be gated on. Transactional senders (work orders, invites, owner portal,
 * password resets) are deliberately absent — they are CAN-SPAM exempt, and
 * suppressing them would withhold mail an operator needs to do their job.
 */
const COMMERCIAL_SENDERS = [
  'lib/inngest/functions/onboarding-drip.tsx',
  'lib/inngest/functions/email-trial-lifecycle.tsx',
]

describe('commercial email — CAN-SPAM opt-out', () => {
  it('the opt-out flag is actually WRITTEN somewhere, not just read', () => {
    // The original bug in one assertion. If this fails, the unsubscribe route
    // was deleted or refactored away and every suppression check downstream
    // silently became dead code again.
    const writer = read('app/unsubscribe/[token]/actions.ts')
    expect(writer).toContain('email_unsubscribed_at')
    expect(writer).toMatch(/\.update\(/)
  })

  it('the opt-out route is reachable without a session and is rate limited', () => {
    const proxy = read('proxy.ts')
    // Unauthenticated by legal requirement — an opt-out must not require login.
    expect(proxy).toContain("'/unsubscribe/'")
    expect(proxy).toContain("'/api/email/unsubscribe'")
    // ...but still throttled: the token is the only credential on the route.
    expect(proxy).toContain('unsubscribeRatelimit')
  })

  it('one-click POST exists and GET does not unsubscribe', () => {
    const route = read('app/api/email/unsubscribe/route.ts')
    expect(route).toMatch(/export async function POST/)
    // A GET handler here would let link-preview and security scanners opt
    // people out who never clicked anything.
    expect(route).not.toMatch(/export async function GET/)
  })

  it('every commercial sender gates on resolveEmailAudience', () => {
    for (const file of COMMERCIAL_SENDERS) {
      const src = read(file)
      expect(src, `${file} must resolve opt-out state`).toContain('resolveEmailAudience')
      expect(src, `${file} must act on suppression`).toContain('suppressed')
    }
  })

  it('every commercial sender attaches RFC 8058 List-Unsubscribe headers', () => {
    for (const file of COMMERCIAL_SENDERS) {
      const src = read(file)
      // The helper builds both List-Unsubscribe and List-Unsubscribe-Post;
      // the sender's job is to pass them to Resend.
      expect(src, `${file} must pass .headers to resend.emails.send`)
        .toMatch(/headers:\s*\w+\.headers/)
    }
  })

  /**
   * FAIL-CLOSED IS ASSERTED BY CALLING THE FUNCTION, not by grepping for it.
   *
   * This used to read the source and check for `/suppressed:\s*true/` plus the
   * literal phrase `FAILS CLOSED`. On 2026-08-25 that was canaried by flipping
   * the helper's own `suppressedResult` to `{ suppressed: false }` — a real
   * fail-OPEN regression on a consent control — and all nine tests in this file
   * stayed green. The phrase lives in the JSDoc, and the regex matched a
   * different, unrelated occurrence further down the file.
   *
   * That is precisely what this file's own header warns against: "these assert
   * the full loop is connected end to end, not that a particular string appears
   * somewhere." Every branch below is a way the read can fail to produce a
   * sendable audience, and every one of them must suppress.
   */
  describe('the audience helper fails CLOSED', () => {
    const stub = (result: { data?: unknown; error?: { message: string } | null }) => ({
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({
              data:  result.data ?? null,
              error: result.error ?? null,
            }),
          }),
        }),
      }),
    })

    const audience = async (result: Parameters<typeof stub>[0]) => {
      const { resolveEmailAudience } = await import('@/lib/email/unsubscribe')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return resolveEmailAudience(stub(result) as any, 'user-1')
    }

    it('suppresses when the profile read ERRORS', async () => {
      // The asymmetry: an unsent marketing email is a delay, an unsuppressed
      // one is mail to someone who asked us to stop. A consent control that
      // evaporates during an outage is the defect.
      expect((await audience({ error: { message: 'connection reset' } })).suppressed).toBe(true)
    })

    it('suppresses when the profile row is MISSING', async () => {
      expect((await audience({ data: null })).suppressed).toBe(true)
    })

    it('suppresses a user who has opted out', async () => {
      expect((await audience({
        data: { email_unsubscribed_at: '2026-08-01T00:00:00Z', unsubscribe_token: 'tok' },
      })).suppressed).toBe(true)
    })

    it('suppresses when there is no unsubscribe token to link to', async () => {
      // A row predating the backfill. The message cannot carry a working
      // opt-out, so it must not be sent rather than sent without one.
      expect((await audience({
        data: { email_unsubscribed_at: null, unsubscribe_token: '' },
      })).suppressed).toBe(true)
    })

    it('permits a subscribed user with a token — the check is not simply always-true', async () => {
      // Without this the four assertions above would all pass against a helper
      // hardcoded to suppress, which would be a different bug wearing the same
      // green tick.
      const ok = await audience({
        data: { email_unsubscribed_at: null, unsubscribe_token: 'tok-123' },
      })
      expect(ok.suppressed).toBe(false)
      expect(ok.unsubscribeUrl).toContain('tok-123')
      expect(Object.keys(ok.headers).length).toBeGreaterThan(0)
    })
  })

  it('the shared email layout can render an unsubscribe link and postal address', () => {
    const layout = read('emails/components/email-layout.tsx')
    expect(layout).toContain('unsubscribeUrl')
    expect(layout).toContain('postalAddress')
  })

  it('the postal-address env var stays declared in lib/env.ts', () => {
    // env-schema-coverage enforces declared-vs-read in both directions, but
    // this pins the specific var so a "cleanup" that drops it as unused also
    // has to confront that it is a CAN-SPAM requirement.
    expect(read('lib/env.ts')).toContain('COMPANY_POSTAL_ADDRESS')
  })

  it('the unsubscribe surface files all exist', () => {
    for (const f of [
      'app/unsubscribe/[token]/page.tsx',
      'app/unsubscribe/[token]/actions.ts',
      'app/api/email/unsubscribe/route.ts',
      'lib/email/unsubscribe.ts',
    ]) {
      expect(existsSync(join(ROOT, f)), `${f} is missing`).toBe(true)
    }
  })
})
