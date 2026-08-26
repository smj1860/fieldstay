import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { collectSourceFiles, rel, readCode } from './scan'

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

/**
 * ── Why the list above was not enough ────────────────────────────────────────
 *
 * COMMERCIAL_SENDERS is hand-maintained, and nothing made a NEW sender join it.
 * On 2026-08-26 `scripts/send-guidebook-launch-email.ts` was found doing exactly
 * what this file's header says had already been fixed: a mass send of the
 * Guidebook feature announcement to every org owner/admin with no
 * resolveEmailAudience() call, and no unsubscribeUrl/postalAddress passed to the
 * template — whose footer is guarded on both, so the mail carried no opt-out
 * link and no physical address at all. The SAME template sent from
 * onboarding-drip.tsx was fully compliant. One template, two callers, one of
 * them a violation, and every test here green, because the scan only ever
 * looked at two files under lib/inngest/.
 *
 * The script bypassed the gate by bypassing the shared client: its own
 * `new Resend(...)` and a `batch.send()`. So the three checks below are
 * discovery rather than registration — they find senders instead of trusting a
 * list to stay current.
 *
 * All three read through readCode(). Comment-blindness is not theoretical here:
 * lib/resend/client.ts's own JSDoc quotes "resend.emails.send(...)" and
 * lib/utils/html.ts uses it as a worked example, so a raw-source scan would
 * flag a module that sends nothing.
 */

/** Directories that can plausibly contain an email send. */
const SEND_SCAN_DIRS = ['lib', 'app', 'scripts', 'emails']

/** Script extensions too — a mailing script need not be TypeScript. */
const SCRIPT_EXTS = ['.ts', '.tsx', '.mjs', '.js']

const SENDS_EMAIL = /\b(?:emails|batch)\.send\s*\(/
const BULK_SEND   = /\bbatch\.send\s*\(/
const NEW_RESEND  = /\bnew\s+Resend\s*\(/

/**
 * Scripts permitted to send email without the commercial gate, each with a
 * reason. EMPTY BY DESIGN — the one member was deleted rather than excused,
 * because a runnable mass-mailer with no opt-out is not a thing to keep behind
 * an allowlist entry. Adding an entry here is a decision to be argued in a
 * review, which is the point.
 */
const TRANSACTIONAL_SCRIPTS = new Set<string>()

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

  it('the Resend client has exactly one owner', () => {
    // The shared client in lib/resend/client.ts is where FROM, the timeout
    // budget and the demo-org suppression live. A second `new Resend(...)`
    // is a private mail channel that inherits none of it — which is precisely
    // how the launch script came to have no timeout, no opt-out and no
    // idempotency key while looking like ordinary code.
    const owners = collectSourceFiles(SEND_SCAN_DIRS, SCRIPT_EXTS)
      .filter((f) => NEW_RESEND.test(readCode(f)))
      .map(rel)
      .sort()

    expect(owners).toEqual(['lib/resend/client.ts'])
  })

  it('a bulk send only happens where the audience is resolved', () => {
    // batch.send() is mass mail by definition. There is no per-recipient
    // transactional trigger behind it, so the opt-out state of every address
    // in the batch has to have been resolved before the batch was built.
    const offenders = collectSourceFiles(SEND_SCAN_DIRS, SCRIPT_EXTS)
      .filter((f) => BULK_SEND.test(readCode(f)))
      .filter((f) => !readCode(f).includes('resolveEmailAudience'))
      .map(rel)

    expect(offenders, 'bulk send without an opt-out gate').toEqual([])
  })

  it('every script that sends email gates on the commercial opt-out', () => {
    // scripts/ was invisible to this file until 2026-08-26. A script is the
    // easiest place for this defect to reappear: it runs by hand, off the
    // request path, reviewed once, and nothing downstream checks it.
    const offenders = collectSourceFiles(['scripts'], SCRIPT_EXTS)
      .filter((f) => SENDS_EMAIL.test(readCode(f)))
      .map((f) => ({ path: rel(f), code: readCode(f) }))
      .filter(({ path }) => !TRANSACTIONAL_SCRIPTS.has(path))
      .filter(({ code }) => !code.includes('resolveEmailAudience'))
      .map(({ path }) => path)

    expect(
      offenders,
      'a script sends email without resolveEmailAudience — gate it, or add it ' +
      'to TRANSACTIONAL_SCRIPTS with a reason it is CAN-SPAM exempt',
    ).toEqual([])
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
