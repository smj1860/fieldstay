'use server'
import crypto                  from 'crypto'
import { requireOrgMember }    from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent }       from '@/lib/audit'

/**
 * Anonymize a guest's PII across all bookings in this org.
 * Matches by email — finds all bookings where guest_email = the provided address.
 * Replaces name with '[Deleted]' and sets email to NULL.
 * The booking record itself is retained for financial/P&L integrity.
 */
export async function anonymizeGuestData(
  guestEmail: string,
): Promise<{ success: boolean; bookingsAnonymized: number; error?: string }> {
  try {
    const { user, membership } = await requireOrgMember()

    if (!guestEmail || !guestEmail.includes('@')) {
      return { success: false, bookingsAnonymized: 0, error: 'Invalid email address' }
    }

    const supabase = createServiceClient()
    const normalizedEmail = guestEmail.toLowerCase().trim()

    const { data: affected, error: fetchErr } = await supabase
      .from('bookings')
      .select('id')
      .eq('org_id', membership.org_id)
      .eq('guest_email', normalizedEmail)

    if (fetchErr) {
      return { success: false, bookingsAnonymized: 0, error: fetchErr.message }
    }

    if (!affected?.length) {
      return { success: true, bookingsAnonymized: 0 }
    }

    const ids = (affected as Array<{ id: string }>).map((b) => b.id)

    const { error: updateErr } = await supabase
      .from('bookings')
      .update({
        guest_name:  '[Deleted]',
        guest_email: null,
      })
      .in('id', ids)
      .eq('org_id', membership.org_id)

    if (updateErr) {
      return { success: false, bookingsAnonymized: 0, error: updateErr.message }
    }

    await logAuditEvent({
      actorId:    user.id,
      orgId:      membership.org_id,
      action:     'gdpr.data_erasure.completed',
      targetType: 'guest',
      metadata:   {
        // SHA-256: irreversible, suitable for audit trail without exposing PII
        email_hash:          crypto
          .createHash('sha256')
          .update(normalizedEmail)
          .digest('hex'),
        bookings_anonymized: ids.length,
        request_type:        'erasure_article_17',
      },
    })

    return { success: true, bookingsAnonymized: ids.length }
  } catch (err) {
    console.error('[anonymizeGuestData]', err)
    return { success: false, bookingsAnonymized: 0, error: 'Operation failed. Please try again.' }
  }
}
