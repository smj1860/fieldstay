/**
 * When a crew activation invite stops working — the single source of truth.
 *
 * This lives here because it had TWO implementations that disagreed, and the
 * disagreement was the exact hole one of them was written to close.
 *
 * app/crew-invite/[token]/actions.ts hardened its copy to fall back to
 * created_at when invite_sent_at is NULL, because a NULL there meant a
 * PERMANENTLY valid activation token that mints a real auth account, and a
 * large share of live crew_members rows carry that NULL (invited by SMS, or
 * created before the column existed).
 *
 * app/crew-invite/[token]/page.tsx kept the original shape — it only ran an
 * expiry check `if (crew.invite_sent_at)` at all, so a NULL row of any age
 * still rendered a working activation form. Not exploitable, because the
 * Server Action is the real gate and refuses it — but the crew member filled
 * in a password form before being told the link was dead, and the page was a
 * live second copy of a rule that had already been a security bug once. On
 * 2026-08-06 that hit 5 of the 8 crew invites pending in production.
 *
 * The fallback is created_at, NOT a hard reject on a missing timestamp.
 * Rejecting outright is the same class of mistake as filtering crew on
 * invite_accepted_at, which has silently locked real crew out three times
 * (see lib/crew-auth.ts). Both call sites only reach this for a genuinely
 * PENDING invite — a row with a user_id or an invite_accepted_at is handled
 * before the expiry question is asked — so no activated crew member can be
 * affected either way.
 */

export const CREW_INVITE_TTL_MS = 7 * 86_400_000

export function crewInviteIsExpired(
  sentAt:    string | null,
  createdAt: string | null,
): boolean {
  const issuedAt = sentAt ?? createdAt
  if (!issuedAt) return true

  const issuedMs = new Date(issuedAt).getTime()
  // An unparseable timestamp yields NaN, and every comparison against NaN is
  // false — so the naive `issuedMs + TTL < Date.now()` would read a corrupt
  // date as "not expired", i.e. fail OPEN on the one input we understand
  // least. Number.isFinite is the only guard that catches it.
  if (!Number.isFinite(issuedMs)) return true

  return issuedMs + CREW_INVITE_TTL_MS < Date.now()
}
