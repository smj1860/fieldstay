import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { sendSMS, buildDoorCodeSMS } from '@/lib/sms/telnyx'

export const guidebookGuestOptedIn = inngest.createFunction(
  { id: 'guidebook-guest-opted-in', name: 'Guidebook: Guest Opted In to SMS' },
  { event: 'guidebook/guest.opted.in' },
  async ({ event, step }) => {
    const { optinId, propertyId, phoneE164 } = event.data
    const supabase = createServiceClient()

    const property = await step.run('fetch-property', async () => {
      const { data, error } = await supabase
        .from('properties')
        .select('id, name, door_code')
        .eq('id', propertyId)
        .single()

      if (error) throw new Error(`Failed to fetch property: ${error.message}`)
      return data
    })

    await step.run('send-door-code-sms', async () => {
      if (!property.door_code) return

      const result = await sendSMS(phoneE164, buildDoorCodeSMS(property.name, property.door_code))

      if (result.sent) {
        await supabase
          .from('guidebook_guest_sms_optins')
          .update({ door_code_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() })
          .eq('id', optinId)
      }
    })

    return { optinId, sentDoorCode: Boolean(property.door_code) }
  }
)
