'use server'

import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent }       from '@/lib/audit'
import { redirect }            from 'next/navigation'
import { z }                   from 'zod'

const ActivateSchema = z.object({
  token:    z.string().uuid(),
  crewId:   z.string().uuid(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(72),
  confirm:  z.string(),
}).refine((d) => d.password === d.confirm, {
  message: 'Passwords do not match',
  path:    ['confirm'],
})

export async function activateCrewAccount(formData: FormData): Promise<{ error?: string }> {
  const raw = {
    token:    formData.get('token'),
    crewId:   formData.get('crewId'),
    password: formData.get('password'),
    confirm:  formData.get('confirm'),
  }

  const parsed = ActivateSchema.safeParse(raw)
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  }

  const { token, crewId, password } = parsed.data
  const supabase = createServiceClient()

  const { data: crew } = await supabase
    .from('crew_members')
    .select('id, name, email, org_id, user_id, invite_accepted_at, invite_token, invite_sent_at')
    .eq('id', crewId)
    .eq('invite_token', token)
    .single()

  if (!crew)                              return { error: 'Invalid invite link' }
  if (!crew.email)                        return { error: 'No email address on record' }
  if (crew.user_id || crew.invite_accepted_at) return { error: 'This invite has already been used' }

  if (crew.invite_sent_at) {
    const expired = new Date(crew.invite_sent_at).getTime() + 7 * 86_400_000 < Date.now()
    if (expired) return { error: 'This invite link has expired. Ask your manager to send a new one.' }
  }

  const { data: authData, error: createError } = await supabase.auth.admin.createUser({
    email:         crew.email,
    password,
    email_confirm: true,
    user_metadata: { full_name: crew.name, role: 'crew' },
  })

  if (createError) {
    if (createError.message.includes('already registered')) {
      return { error: 'An account with this email already exists. Try logging in instead.' }
    }
    return { error: createError.message }
  }

  if (!authData.user) return { error: 'Account creation failed — please try again' }

  const { error: linkError } = await supabase
    .from('crew_members')
    .update({
      user_id:            authData.user.id,
      invite_accepted_at: new Date().toISOString(),
    })
    .eq('id', crewId)
    .eq('invite_token', token)
    .is('user_id', null)
    .is('invite_accepted_at', null)

  if (linkError) {
    await supabase.auth.admin.deleteUser(authData.user.id)
    return { error: 'Failed to activate account. Please try again.' }
  }

  await logAuditEvent({
    orgId:      crew.org_id,
    actorId:    authData.user.id,
    action:     'crew.account.activated',
    targetType: 'crew_member',
    targetId:   crewId,
    metadata:   { email: crew.email },
  })

  redirect('/crew/install')
}
