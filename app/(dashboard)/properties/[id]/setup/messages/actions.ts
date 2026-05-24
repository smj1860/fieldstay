'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { markStepComplete } from '@/app/(dashboard)/properties/actions'

export type MessagesState = { error?: string; success?: boolean }

export async function saveMessageTemplate(
  propertyId: string,
  templateId: string | null,
  trigger: 'booking_confirmed' | 'pre_checkout',
  _prev: MessagesState | null,
  formData: FormData
): Promise<MessagesState> {
  const { supabase, membership } = await requireOrgMember()

  const name        = (formData.get('name') as string)?.trim()
  const subject     = (formData.get('subject') as string)?.trim()
  const body        = (formData.get('body') as string)?.trim()
  const days_before = parseInt(formData.get('days_before') as string) || 1
  const is_active   = formData.get('is_active') === 'true'

  if (!subject) return { error: 'Subject is required' }
  if (!body)    return { error: 'Message body is required' }

  if (templateId) {
    const { error } = await supabase
      .from('guest_message_templates')
      .update({ name, subject, body, days_before, is_active })
      .eq('id', templateId)
      .eq('org_id', membership.org_id)
    if (error) return { error: error.message }
  } else {
    const { error } = await supabase
      .from('guest_message_templates')
      .insert({
        property_id: propertyId,
        org_id:      membership.org_id,
        trigger, name: name || (trigger === 'booking_confirmed' ? 'Booking Confirmation' : 'Pre-Checkout Reminder'),
        subject, body, days_before, is_active,
      })
    if (error) return { error: error.message }
  }

  revalidatePath(`/properties/${propertyId}/setup/messages`)
  return { success: true }
}

export async function completeMessagesStep(propertyId: string): Promise<void> {
  await markStepComplete(propertyId, 'messages')
  redirect(`/properties/${propertyId}/setup/checklist`)
}
