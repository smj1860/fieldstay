import 'server-only'

import { headers } from 'next/headers'
import { inviteAcceptRatelimit, checkLimit } from '@/lib/rate-limit'
import { extractClientIp } from '@/lib/integrations/webhook-verification'

/**
 * Per-IP throttle for the invite-token VIEW pages.
 *
 * `/accept-invite/[token]` and `/crew-invite/[token]` are the two
 * BYPASS_ROUTES entries that skip TOKEN_ROUTES entirely, so
 * rateLimiterForPathname() gives them nothing and they have to limit inline.
 * That was done — but only in the POST Server Actions. The GET pages ran an
 * unthrottled `org_invites` / `crew_members` lookup on every render, so a
 * token-guessing bot never needed to reach the rate-limited POST at all: the
 * page itself answers "is this token real?" at unbounded QPS.
 *
 * Both columns are indexed, so this is not a full-scan risk. It is an
 * unbounded query path per guessed token, which is the thing the sibling
 * limiter on the action already exists to stop.
 *
 * ── Why a SEPARATE key namespace from the action ──
 *
 * `invite-view:` rather than the action's `accept-invite:`. Sharing one budget
 * would let ordinary page loads — a real invitee refreshing, an email client
 * prefetching the link — burn the allowance the ACCEPT needs, so the genuine
 * user gets throttled out of finishing the thing they were invited to do. The
 * two surfaces have different traffic shapes and want different budgets.
 *
 * ── Fail policy ──
 *
 * 'allow', matching every other abuse limiter here (and the action's own).
 * A Redis outage must not make invite links stop working; the limiter is
 * anti-enumeration, not an authorization gate. checkLimit() also
 * short-circuits when Upstash is unconfigured, so CI and local dev pay
 * nothing.
 */
export async function inviteViewThrottled(site: string): Promise<boolean> {
  const ip = extractClientIp(
    new Request('https://fieldstay.local', { headers: await headers() })
  ) ?? 'unknown'

  const decision = await checkLimit(inviteAcceptRatelimit, `invite-view:${ip}`, {
    onError: 'allow',
    site,
  })

  return !decision.allowed
}
