// lib/observability/sentry-filters.ts
//
// Predicates for Sentry's beforeSend (instrumentation.ts). A LEAF module with
// no imports, so it can be unit-tested without pulling in @sentry/nextjs or
// running instrumentation.ts's module-level init.
//
// Everything here DISCARDS an event, so each predicate has to earn it. The bar
// is not "this is noisy" — it is "this event cannot represent a real failure",
// and each one below says why in its own comment.

/**
 * Next.js signals redirect() and notFound() by THROWING a control-flow error
 * that the framework catches upstream. Server Actions here wrap their bodies
 * in try/catch (see the reportError convention), so an ordinary
 * requireOrgMember() redirect to /login or /onboarding lands in the catch and
 * would be reported as an application error. Those are not failures — left
 * unfiltered they would be the single largest source of noise in this
 * project's Sentry, and alert fatigue makes every other signal worthless.
 */
export function isNextControlFlow(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const digest = (err as { digest?: unknown }).digest
  return typeof digest === 'string' &&
    (digest.startsWith('NEXT_REDIRECT') || digest === 'NEXT_NOT_FOUND')
}

/**
 * A POST to a page route carrying no valid Server Action id.
 *
 * In the App Router ANY POST to a page route is treated as a Server Action
 * invocation, so a bot posting to `/` produces this with no forged header and
 * no interaction on our side. On 2026-09-11 that was seven POSTs to the
 * marketing homepage in six seconds, from one source, each with its own trace.
 *
 * DROPPED BECAUSE THE PAGE HAS NO ACTION TO INVOKE — not merely because it is
 * frequent. There is no `<form>`, no `useActionState` and no `'use server'`
 * anywhere in the render tree of `/` (app/page.tsx → HomepageContent, the FAQ,
 * pricing and RepuGuard components, plus the root layout), and none in its
 * history, so no real submission can arrive there and none can be lost by
 * filtering. What reached the server was rejected by Next before any of our
 * code ran — the lookup failed and the request was refused. Reporting a
 * defence that worked, unhandled, at error level is how a scanner gets to page
 * the founder at 7pm.
 *
 * SCOPED, deliberately: this exact message and nothing else. The moment a page
 * in this app does expose a Server Action, a genuine deploy-skew failure on it
 * is a real user losing a real submission — and the honest signal for that is
 * a drop in successful submissions, not this error, which cannot tell a
 * stranded user from a scanner. Revisit when the first Server Action form
 * ships on a public page.
 */
export function isServerActionProbe(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const message = (err as { message?: unknown }).message
  return typeof message === 'string' && message.startsWith('Failed to find Server Action')
}

/** Whether Sentry should drop this event entirely. */
export function shouldDropSentryEvent(err: unknown): boolean {
  return isNextControlFlow(err) || isServerActionProbe(err)
}
