'use server'

import { z }                   from 'zod'
import { createServiceClient, createClient, adminFetch } from '@/lib/supabase/server'
import { acceptOrgInvite }     from '@/lib/auth/invites'
import { redirect }            from 'next/navigation'
import { headers }             from 'next/headers'
import { inviteAcceptRatelimit } from '@/lib/rate-limit'

const AcceptSchema = z.object({
  token:    z.string().uuid('Invite link is invalid or expired'),
  fullName: z.string().min(1, 'Full name is required').max(200),
  password: z.string().min(8, 'Password must be at least 8 characters').max(72),
  confirm:  z.string(),
}).refine((d) => d.password === d.confirm, {
  message: 'Passwords do not match',
  path:    ['confirm'],
})

export async function acceptTeamInvite(formData: FormData): Promise<{ error?: string }> {
  const parsed = AcceptSchema.safeParse({
    token:    formData.get('token'),
    fullName: formData.get('fullName'),
    password: formData.get('password'),
    confirm:  formData.get('confirm'),
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  }

  // Real account creation (admin.auth.admin.createUser below) from a
  // public route gated only by a UUID token — rate limit by IP. Fails open
  // on a Redis outage; a degraded limiter must never block a legitimate
  // new team member finishing setup.
  try {
    const hdrs = await headers()
    const ip   = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
    const { success } = await inviteAcceptRatelimit.limit(`accept-invite:${ip}`)
    if (!success) {
      return { error: 'Too many attempts. Please try again in a few minutes.' }
    }
  } catch (rlErr) {
    console.error('[acceptTeamInvite] rate limit check failed', rlErr)
  }

  const { token, fullName, password } = parsed.data
  const admin = createServiceClient()

  const { data: invite, error: inviteError } = await admin
    .from('org_invites')
    .select('id, email, role, org_id, expires_at')
    .eq('token', token)
    .is('accepted_at', null)
    .gt('expires_at', new Date().toISOString())
    .single()

  if (inviteError || !invite) {
    return { error: 'This invitation is no longer valid.' }
  }

  // Reject if a user with this email already exists — they must use the
  // "Log in" path so we don't create a duplicate auth.users row.
  const lookupRes = await adminFetch(
    `/auth/v1/admin/users?email=${encodeURIComponent(invite.email)}&per_page=1`
  )
  if (lookupRes.ok) {
    const body = await lookupRes.json() as { users?: { id: string }[] }
    if (body.users?.[0]?.id) {
      return { error: 'An account with this email already exists. Please log in instead.' }
    }
  }

  const { data: authData, error: createError } = await admin.auth.admin.createUser({
    email:         invite.email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  })

  if (createError || !authData.user) {
    if (createError?.message.includes('already registered')) {
      return { error: 'An account with this email already exists. Please log in instead.' }
    }
    console.error('[acceptTeamInvite] createUser failed:', createError?.message)
    return { error: 'Failed to create account. Please try again.' }
  }

  const { accepted } = await acceptOrgInvite(authData.user.id, invite.email, token)
  if (!accepted) {
    await admin.auth.admin.deleteUser(authData.user.id)
    return { error: 'This invitation could not be accepted. Please request a new one.' }
  }

  const authClient = await createClient()
  const { error: signInError } = await authClient.auth.signInWithPassword({
    email: invite.email,
    password,
  })

  if (signInError) {
    redirect('/login')
  }

  redirect('/ops')
}
