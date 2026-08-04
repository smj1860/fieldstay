import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { tryUnwrap } from '@/lib/supabase/unwrap'

/**
 * CAN-SPAM opt-out plumbing, in one place.
 *
 * Before this module, `profiles.email_unsubscribed_at` was read by
 * onboarding-drip and written by nothing at all, and no template carried an
 * unsubscribe link — so every commercial send was non-compliant and the
 * suppression check was dead code. Everything that sends a COMMERCIAL email
 * must go through `resolveEmailAudience()` here; transactional mail (work
 * orders, invites, password resets, owner portal links) is exempt from the
 * opt-out requirement and deliberately does NOT use it, so that an operator
 * who opted out of marketing still receives the mail their job depends on.
 */

/** The postal address CAN-SPAM requires in commercial email. */
export function commercialPostalAddress(): string | null {
  return process.env.COMPANY_POSTAL_ADDRESS?.trim() || null
}

export function unsubscribeUrl(token: string): string {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'
  return `${appUrl}/unsubscribe/${token}`
}

/**
 * RFC 8058 one-click headers. Gmail/Yahoo bulk-sender rules expect BOTH: the
 * List-Unsubscribe URL and the List-Unsubscribe-Post marker that tells the
 * mail client it may POST directly instead of making the human click through.
 * Without the -Post header, providers fall back to showing their own
 * "report spam" affordance more aggressively.
 */
export function listUnsubscribeHeaders(token: string): Record<string, string> {
  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'
  return {
    'List-Unsubscribe':      `<${appUrl}/api/email/unsubscribe?token=${token}>`,
    'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
  }
}

export interface EmailAudience {
  /** True when this recipient has opted out — the caller MUST NOT send. */
  suppressed:      boolean
  unsubscribeUrl:  string | null
  headers:         Record<string, string>
}

/**
 * Decide whether a commercial email may go to this user, and return the
 * unsubscribe artifacts to attach if it may.
 *
 * FAILS CLOSED. If the profile row cannot be read (RLS regression, outage, a
 * deleted profile), this returns `suppressed: true` rather than sending. A
 * spend/consent control that evaporates during an outage is the same defect
 * the nudge-budget check in lib/sms/telnyx.ts is written to avoid — and here
 * the downside is asymmetric: a suppressed send is a delayed marketing email,
 * an unsuppressed one is mail to someone who asked us to stop, which is the
 * actual legal exposure.
 */
export async function resolveEmailAudience(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any>,
  userId:   string,
): Promise<EmailAudience> {
  const suppressedResult: EmailAudience = { suppressed: true, unsubscribeUrl: null, headers: {} }

  // FAILS CLOSED on a missing postal address, for the same reason as a missing
  // token below. CAN-SPAM requires a physical address in commercial email, and
  // emails/components/email-layout.tsx renders the opt-out block only when
  // BOTH the unsubscribe URL and the address are present — so with
  // COMPANY_POSTAL_ADDRESS unset the footer loses the address AND the
  // unsubscribe link, producing mail that is non-compliant on both counts
  // while every send still reports success.
  //
  // Suppressing instead means an unset env var delays marketing email rather
  // than shipping a violation. Set COMPANY_POSTAL_ADDRESS to turn commercial
  // sending on.
  if (!commercialPostalAddress()) {
    console.error(
      '[resolveEmailAudience] COMPANY_POSTAL_ADDRESS is unset — suppressing commercial email. ' +
      'CAN-SPAM requires a physical postal address; set it to enable these sends.'
    )
    return suppressedResult
  }

  const res = await supabase
    .from('profiles')
    .select('email_unsubscribed_at, unsubscribe_token')
    .eq('id', userId)
    .maybeSingle()

  const result = tryUnwrap(res, { site: 'email.resolveEmailAudience' })

  if (!result.ok) return suppressedResult

  const profile = result.data as { email_unsubscribed_at: string | null; unsubscribe_token: string } | null
  if (!profile) return suppressedResult
  if (profile.email_unsubscribed_at) return suppressedResult

  // A row that predates the backfill, or any other reason the token is
  // missing, means we cannot put a working opt-out link in the message — so
  // the message must not be sent, rather than sent without one.
  if (!profile.unsubscribe_token) return suppressedResult

  return {
    suppressed:     false,
    unsubscribeUrl: unsubscribeUrl(profile.unsubscribe_token),
    headers:        listUnsubscribeHeaders(profile.unsubscribe_token),
  }
}
