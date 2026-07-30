'use server'

import { createServiceClient } from '@/lib/supabase/server'
import { createClient }        from '@/lib/supabase/server'
import { logAuditEvent }       from '@/lib/audit'
import { redirect }            from 'next/navigation'
import { headers }             from 'next/headers'
import { z }                   from 'zod'
import { inviteAcceptRatelimit } from '@/lib/rate-limit'

import { reportError } from '@/lib/observability/report-error'
const ActivateSchema = z.object({
  token:    z.string().uuid('Invite link is invalid or expired'),
  crewId:   z.string().uuid(),
  // Only present when the crew member has no email on file yet — the form
  // only renders this field in that case. Validated as a proper email
  // format here; whether it's actually required is decided below once we
  // know whether crew.email already covers it.
  email:    z.string().email('Enter a valid email address').optional().or(z.literal('')),
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
    email:    formData.get('email') ?? undefined,
    password: formData.get('password'),
    confirm:  formData.get('confirm'),
  }

  const parsed = ActivateSchema.safeParse(raw)
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Invalid input' }
  }

  // Real account creation (supabase.auth.admin.createUser below) from a
  // public route gated only by a UUID token — rate limit by IP. Fails open
  // on a Redis outage; a degraded limiter must never block a legitimate
  // crew member finishing setup.
  try {
    const hdrs = await headers()
    const ip   = hdrs.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
    const { success } = await inviteAcceptRatelimit.limit(`crew-invite:${ip}`)
    if (!success) {
      return { error: 'Too many attempts. Please try again in a few minutes.' }
    }
  } catch (rlErr) {
    console.error('[activateCrewAccount] rate limit check failed', rlErr)
    reportError(rlErr, { site: 'serverAction.crew-invite.activateCrewAccount' })
  }

  const { token, crewId, password } = parsed.data
  const submittedEmail = parsed.data.email || null
  const supabase = createServiceClient({ publicSurface: 'crew-invite--token--actions' })

  const { data: crew, error: crewError } = await supabase
    .from('crew_members')
    .select('id, name, email, org_id, user_id, invite_accepted_at, invite_token, invite_sent_at, created_at')
    .eq('id', crewId)
    .eq('invite_token', token)
    .single()

  if (crewError) {
    console.error('[activateCrewAccount] crew lookup error', {
      code:    crewError.code,
      message: crewError.message,
    })
    return { error: 'Invalid invite link' }
  }
  if (!crew)                                   return { error: 'Invalid invite link' }
  if (crew.user_id || crew.invite_accepted_at) return { error: 'This invite has already been used' }

  // We already have an email on file for most crew, but plenty were invited
  // by SMS with no email on record at all — that doesn't mean they don't
  // have one, just that we never captured it. The form collects it here
  // instead of blocking activation entirely.
  const activationEmail = crew.email ?? submittedEmail
  if (!activationEmail) return { error: 'Enter an email address to finish setting up your account' }

  // Fail CLOSED on expiry. This check used to be nested inside
  // `if (crew.invite_sent_at)`, so a crew row with a NULL invite_sent_at had a
  // permanently-valid activation token that mints a real auth account — and
  // ~40% of live crew_members rows have that column NULL (invited by SMS, or
  // created before the column existed).
  //
  // The fallback is created_at, NOT a hard reject: rejecting outright would be
  // the same class of mistake as filtering crew on invite_accepted_at, which
  // has silently locked out real crew three times (see lib/crew-auth.ts). Note
  // this branch is only reachable for genuinely PENDING invites — rows with a
  // user_id or invite_accepted_at already returned "already used" above — so
  // no activated crew member can be affected by it either way.
  const inviteIssuedAt = crew.invite_sent_at ?? crew.created_at
  if (!inviteIssuedAt) {
    return { error: 'This invite link has expired. Ask your manager to send a new one.' }
  }
  const expired = new Date(inviteIssuedAt).getTime() + 7 * 86_400_000 < Date.now()
  if (expired) return { error: 'This invite link has expired. Ask your manager to send a new one.' }

  const { data: authData, error: createError } = await supabase.auth.admin.createUser({
    email:         activationEmail,
    password,
    email_confirm: true,
    user_metadata: { full_name: crew.name, role: 'crew' },
  })

  if (createError) {
    if (createError.message.includes('already registered')) {
      return { error: 'An account with this email already exists. Try logging in instead.' }
    }
    console.error('[activateCrewAccount]', createError)
    return { error: 'Account creation failed — please try again' }
  }

  if (!authData.user) return { error: 'Account creation failed — please try again' }

  const { error: linkError } = await supabase
    .from('crew_members')
    .update({
      user_id:            authData.user.id,
      invite_accepted_at: new Date().toISOString(),
      // Backfill the email the crew member just entered so future invites/
      // resends and the crew list itself have it on file going forward.
      ...(crew.email ? {} : { email: activationEmail }),
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
    metadata:   { email: activationEmail },
  })

  // Sign in the newly created user so the crew layout's auth check passes
  const authClient = await createClient()
  const { error: signInError } = await authClient.auth.signInWithPassword({
    email:    activationEmail,
    password,
  })

  if (signInError) {
    // Account is created — send to login so they can sign in manually
    redirect('/crew/login')
  }

  redirect('/crew/install')
  return { error: undefined }
}
