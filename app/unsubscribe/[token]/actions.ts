'use server'

import { z }                    from 'zod'
import { createServiceClient }  from '@/lib/supabase/server'
import { reportError }          from '@/lib/observability/report-error'

// Same shape the migration generates: encode(gen_random_bytes(32), 'hex').
// Pinned as a regex so a malformed token is rejected before it ever reaches a
// query — and so this can never drift into `.uuid()`, which is what silently
// broke the org-invite flow for every real token.
const TokenSchema = z.string().regex(/^[0-9a-f]{64}$/)

export type UnsubscribeResult = { ok: true } | { ok: false; error: string }

/**
 * Record a CAN-SPAM opt-out. Unauthenticated by necessity: the law requires
 * the opt-out mechanism to work without the recipient logging in or supplying
 * anything beyond their address, so the token IS the credential and this uses
 * the service client with an in-file validation, the same publicSurface shape
 * the owner portal uses.
 *
 * Idempotent: unsubscribing twice is a no-op success, because a mail client
 * doing an RFC 8058 one-click POST may well retry.
 */
export async function recordUnsubscribe(rawToken: string): Promise<UnsubscribeResult> {
  const parsed = TokenSchema.safeParse(rawToken)
  if (!parsed.success) return { ok: false, error: 'This unsubscribe link is not valid.' }

  try {
    const supabase = createServiceClient({ publicSurface: 'email-unsubscribe' })

    // Scoped by the token itself, and the row is read back so a write that
    // matched nothing cannot report success — a 0-row UPDATE returns no error.
    const { data, error } = await supabase
      .from('profiles')
      .update({ email_unsubscribed_at: new Date().toISOString() })
      .eq('unsubscribe_token', parsed.data)
      .is('email_unsubscribed_at', null)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[recordUnsubscribe] update failed', error)
      reportError(error, { site: 'serverAction.unsubscribe.recordUnsubscribe' })
      return { ok: false, error: 'Something went wrong. Please try again.' }
    }

    // No row updated means either an unknown token or — far more likely — one
    // already unsubscribed, which the `.is(null)` filter excludes. Distinguish
    // the two so an unknown token isn't reported as a successful opt-out.
    if (!data) {
      const { data: existing, error: probeError } = await supabase
        .from('profiles')
        .select('id')
        .eq('unsubscribe_token', parsed.data)
        .maybeSingle()

      // Distinguish "no such token" from "the probe itself failed" — collapsing
      // them would report a broken database as an invalid link, and send the
      // recipient away believing their opt-out was rejected on the merits.
      if (probeError) {
        console.error('[recordUnsubscribe] existence probe failed', probeError)
        reportError(probeError, { site: 'serverAction.unsubscribe.recordUnsubscribe.probe' })
        return { ok: false, error: 'Something went wrong. Please try again.' }
      }

      if (!existing) return { ok: false, error: 'This unsubscribe link is not valid.' }
      return { ok: true }   // already unsubscribed — idempotent success
    }

    return { ok: true }
  } catch (err) {
    console.error('[recordUnsubscribe]', err)
    reportError(err, { site: 'serverAction.unsubscribe.recordUnsubscribe' })
    return { ok: false, error: 'Something went wrong. Please try again.' }
  }
}
