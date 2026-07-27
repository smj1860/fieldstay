import * as Sentry from '@sentry/nextjs'

/**
 * Attaches the current actor and tenant to the active Sentry scope, so every
 * error and trace captured for the rest of this request carries them.
 *
 * Why this exists: before it, every issue in Sentry showed "Users: 0". Sentry
 * derives impact ("N users affected") from the user attached to the scope, and
 * nothing was attaching one — so the single most useful triage question, is
 * this one customer or all of them, was unanswerable no matter how many events
 * an issue had.
 *
 * ⚠️  IDs ONLY — never email, name, phone, or IP.
 *
 * Sentry's user object accepts email/username/ip_address, and every one of
 * them is banned here: CLAUDE.md's sensitive-data rules treat guest and PM
 * contact details as never-loggable, and Sentry.init sets sendDefaultPii:false
 * specifically so the SDK does not infer an IP from the request. Passing an
 * email here would quietly undo that. A UUID is enough to answer "how many
 * distinct users" and to correlate with a support ticket; the address itself
 * can be looked up in Supabase by anyone who legitimately needs it.
 *
 * Scope is per-request. The Next.js SDK isolates it via AsyncLocalStorage, so
 * calling this in a Server Component or Server Action tags that request only
 * and cannot leak one tenant's identifiers onto another's events.
 */
export function setActorContext(userId: string): void {
  Sentry.setUser({ id: userId })
}

/**
 * Tags the request with its tenant. `org_id` is the highest-value filter
 * dimension in this product — "is this breaking one org or everyone" is the
 * first question for nearly every incident — and reportError() already accepts
 * an orgId for the same reason. This sets it once per request so events that
 * never go through reportError (unhandled throws, RSC render failures caught
 * by onRequestError, performance traces) carry it too.
 *
 * Role and plan are low-cardinality enums, safe as tags, and let you tell
 * "only owners hit this" or "only starter-plan orgs hit this" without opening
 * an event.
 */
export function setTenantContext(ctx: {
  orgId: string
  role?: string
  plan?: string
}): void {
  Sentry.setTag('org_id', ctx.orgId)
  if (ctx.role) Sentry.setTag('member_role', ctx.role)
  if (ctx.plan) Sentry.setTag('org_plan', ctx.plan)
}
