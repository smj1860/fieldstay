'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { requireOrgMember } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { markStepComplete } from '@/app/(dashboard)/properties/actions'

export type CrewState = { error?: string; success?: boolean }

export async function addCrewMember(
  _prev: CrewState | null,
  formData: FormData
): Promise<CrewState> {
  const { user, supabase, membership } = await requireOrgMember()

  const name              = (formData.get('name') as string)?.trim()
  const email             = (formData.get('email') as string)?.trim() || null
  const phone             = (formData.get('phone') as string)?.trim() || null
  const preferred_contact = formData.get('preferred_contact') as 'email' | 'sms' | 'both' || 'email'

  if (!name) return { error: 'Name is required' }
  if (!email && !phone) return { error: 'Email or phone is required' }

  const { data: newCrew, error } = await supabase.from('crew_members').insert({
    org_id: membership.org_id, name, email, phone, preferred_contact,
  }).select('id').single()

  if (error) {
    console.error('[addCrewMember]', error)
    return { error: 'Operation failed. Please try again.' }
  }

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'crew.member.created',
    targetType: 'crew_member',
    targetId:   newCrew?.id,
    metadata:   { name },
  })

  revalidatePath('/properties')
  return { success: true }
}

export async function completeCrewStep(propertyId: string): Promise<void> {
  await markStepComplete(propertyId, 'crew')
  redirect(`/properties/${propertyId}`)
}
