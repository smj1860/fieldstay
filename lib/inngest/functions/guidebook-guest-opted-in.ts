import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { sendSMS, buildDoorCodeSMS } from '@/lib/sms/telnyx'

export const guidebookGuestOptedIn = inngest.createFunction(
  { id: 'guidebook-guest-opted-in', name: 'Guidebook: Guest Opted In to SMS' },
  { event: 'guidebook/guest.opted.in' },
  async ({ event, step }) => {
    const { optinId, bookingId, propertyId, phoneE164 } = event.data
    const supabase = createServiceClient()

    // Fetch property and booking token in parallel
    const [property, booking] = await Promise.all([
      step.run('fetch-property', async () => {
        const { data, error } = await supabase
          .from('properties')
          .select('id, name, door_code')
          .eq('id', propertyId)
          .single()
        if (error) throw new Error(`Failed to fetch property: ${error.message}`)
        return data
      }),
      step.run('fetch-booking-token', async () => {
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
      if (!property.door_code) return

      // De-dup: only send if not already delivered
      const { data: optin } = await supabase
        .from('guidebook_guest_sms_optins')
        .select('door_code_sent_at')
        .eq('id', optinId)
        .single()

      if (optin?.door_code_sent_at) return

      const appUrl    = process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'
      const portalUrl = `${appUrl}/g/b/${booking.guidebook_token}`

      const result = await sendSMS(
        phoneE164,
        buildDoorCodeSMS(property.name, property.door_code, portalUrl)
      )

      if (result.sent) {
        await supabase
          .from('guidebook_guest_sms_optins')
          .update({
            door_code_sent_at: new Date().toISOString(),
            updated_at:        new Date().toISOString(),
          })
          .eq('id', optinId)
      }
    })

    return { optinId, sentDoorCode: Boolean(property.door_code) }
  }
)
