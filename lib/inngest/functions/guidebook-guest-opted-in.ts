import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { sendSMS } from '@/lib/sms/telnyx'
import { renderSmsBody } from '@/lib/sms/templates'

export const guidebookGuestOptedIn = inngest.createFunction(
  { id: 'guidebook-guest-opted-in', name: 'Guidebook: Guest Opted In to SMS' },
  { event: 'guidebook/guest.opted.in' },
  async ({ event, step }) => {
    const { optinId, bookingId, propertyId, phoneE164 } = event.data

    // Fetch property and booking token in parallel
    const [property, booking] = await Promise.all([
      step.run('fetch-property', async () => {
        const supabase = createServiceClient()
        const { data, error } = await supabase
          .from('properties')
          .select('id, name, door_code_secret_id, org_id')
          .eq('id', propertyId)
          .single()
        if (error) throw new Error(`Failed to fetch property: ${error.message}`)
        return data
      }),
      step.run('fetch-booking-token', async () => {
        const supabase = createServiceClient()
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
      const supabase = createServiceClient()

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
      const { data: claimed } = await supabase
        .from('guidebook_guest_sms_optins')
        .update({
          door_code_sent_at: new Date().toISOString(),
          updated_at:        new Date().toISOString(),
        })
        .eq('id', optinId)
        .is('door_code_sent_at', null)    // ← atomic guard: only claim once
        .select('id')
        .maybeSingle()

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
      const result = await sendSMS(phoneE164, body)

      if (!result.sent) {
        // SMS failed — roll back the claim so a retry can attempt again
        await supabase
          .from('guidebook_guest_sms_optins')
          .update({ door_code_sent_at: null })
          .eq('id', optinId)

        throw new Error(`SMS send failed: ${result.reason ?? 'unknown'}`)
      }

      return { sent: true }
    })

    return { optinId, sentDoorCode: Boolean(property.door_code_secret_id) }
  }
)
