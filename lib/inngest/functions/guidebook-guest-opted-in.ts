import { unwrap } from '@/lib/supabase/unwrap'
import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { sendSMS } from '@/lib/sms/telnyx'
import { renderSmsBody } from '@/lib/sms/templates'
import { reportError } from '@/lib/observability/report-error'

export const guidebookGuestOptedIn = inngest.createFunction(
  { id: 'guidebook-guest-opted-in', name: 'Guidebook: Guest Opted In to SMS' },
  { event: 'guidebook/guest.opted.in' },
  async ({ event, step }) => {
    const { optinId, bookingId, propertyId, phoneE164 } = event.data

    // Fetch property and booking token in parallel
    const [property, booking] = await Promise.all([
      step.run('fetch-property', async () => {
        const supabase = createServiceClient({ system: 'inngest:guidebook-guest-opted-in' })
        const { data, error } = await supabase
          .from('properties')
          .select('id, name, door_code_secret_id, org_id')
          .eq('id', propertyId)
          .single()
        if (error) throw new Error(`Failed to fetch property: ${error.message}`)
        return data
      }),
      step.run('fetch-booking-token', async () => {
        const supabase = createServiceClient({ system: 'inngest:guidebook-guest-opted-in' })
        const { data, error } = await supabase
          .from('bookings')
          .select('guidebook_token')
          .eq('id', bookingId)
          .single()
        if (error) throw new Error(`Failed to fetch booking: ${error.message}`)
        return data
      }),
    ])

    await step.run('send-door-code-sms', async () => {
      const supabase = createServiceClient({ system: 'inngest:guidebook-guest-opted-in' })

      if (!property.door_code_secret_id) return { skipped: 'no_door_code' }

      // Decrypted just-in-time, inside this step, and never returned from
      // it — step return values are persisted as Inngest execution history,
      // so the plaintext code must not end up in that record (same reasoning
      // as not returning the guest's phone number from this step).
      const { data: doorCode, error: decryptError } = await supabase.rpc('read_property_door_code', {
        p_property_id: property.id,
        p_org_id:      property.org_id,
      })
      if (decryptError) throw new Error(`Failed to decrypt door code: ${decryptError.message}`)
      if (!doorCode) return { skipped: 'no_door_code' }

      // ── Atomic claim — wins the race, prevents double-send on retry ───────────
      // UPDATE only succeeds if door_code_sent_at IS NULL.
      // If this step is retried after a successful SMS send, the timestamp is
      // already set, the UPDATE affects 0 rows, and we skip the send.
      // A failed claim returned null, which this step reads as "already sent"
      // and skips — so the guest silently never received their door code.
      // Throwing lets Inngest retry the claim instead.
      const claimRes = await supabase
        .from('guidebook_guest_sms_optins')
        .update({
          door_code_sent_at: new Date().toISOString(),
          updated_at:        new Date().toISOString(),
        })
        .eq('id', optinId)
        .is('door_code_sent_at', null)    // ← atomic guard: only claim once
        .select('id')
        .maybeSingle()

      const claimed = unwrap(claimRes, {
        site:  'inngest.guidebook-guest-opted-in.door-code-claim',
        orgId: property.org_id,
      })

      // No row returned = already claimed by a prior (successful) invocation
      if (!claimed) return { skipped: 'already_sent' }

      // ── Send SMS — only reached if we won the atomic claim ───────────────────
      const appUrl    = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'
      const portalUrl = `${appUrl}/g/b/${booking.guidebook_token}`

      const body = await renderSmsBody(property.org_id, 'door_code', {
        property_name: property.name,
        door_code:     doorCode,
        portal_url:    portalUrl,
      })
      // Releases the one-shot claim so a later run can send. Both exits below
      // need it, for opposite reasons.
      const releaseClaim = async (): Promise<void> => {
        const { error: rollbackError } = await supabase
          .from('guidebook_guest_sms_optins')
          .update({ door_code_sent_at: null })
          .eq('id', optinId)

        if (rollbackError) {
          console.error('[guidebook-guest-opted-in] claim rollback failed', rollbackError.message)
          reportError(rollbackError, {
            site:  'inngest.guidebook-guest-opted-in.claim-rollback',
            orgId: property.org_id,
          })
        }
      }

      // sendSMS THROWS on a real send failure — dispatchToTelnyx throws on a
      // timeout or any non-2xx. That throw used to escape this step with the
      // claim still held, so the Inngest retry hit
      // `.is('door_code_sent_at', null)`, matched zero rows, and returned
      // `already_sent` — reporting success for a door code the guest never
      // received, and never trying again. That is the exact failure the
      // comment above the claim describes for a different case; this was the
      // same shape one layer down, still open.
      let result
      try {
        result = await sendSMS(phoneE164, body, { orgId: property.org_id })
      } catch (err) {
        await releaseClaim()
        throw err
      }

      if (!result.sent) {
        // NOT a failure. sendSMS only returns sent:false for a DELIBERATE
        // skip — SMS_ENABLED off, the daily nudge budget, demo-org
        // suppression — because every real failure throws (above). Throwing
        // here turned a config state into a retried failure: with
        // SMS_ENABLED=false, every guest opt-in produced a failing run
        // reading "SMS send failed", which is both untrue and noise that
        // would mask the real failures once SMS is switched on.
        //
        // Release the claim so the send can happen once the skip no longer
        // applies, and end cleanly — a retry cannot change an env var.
        await releaseClaim()
        return { skipped: result.reason ?? 'not_sent' }
      }

      return { sent: true }
    })

    return { optinId, sentDoorCode: Boolean(property.door_code_secret_id) }
  }
)
