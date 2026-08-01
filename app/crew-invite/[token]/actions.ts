'use server'

import { createServiceClient } from '@/lib/supabase/server'
import { createClient }        from '@/lib/supabase/server'
import { logAuditEvent }       from '@/lib/audit'
import { redirect }            from 'next/navigation'
import { headers }             from 'next/headers'
import { z }                   from 'zod'
import { inviteAcceptRatelimit, checkLimit } from '@/lib/rate-limit'
import { extractClientIp }     from '@/lib/integrations/webhook-verification'

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

const INVITE_TTL_MS = 7 * 86_400_000

/**
 * Fails CLOSED. This check used to be nested inside `if (crew.invite_sent_at)`,
 * so a crew row with a NULL invite_sent_at had a PERMANENTLY valid activation
 * token that mints a real auth account — and ~40% of live crew_members rows
 * have that column NULL (11 of 28 on 2026-07-30: invited by SMS, or created
 * before the column existed).
 *
 * The fallback is created_at, NOT a hard reject. Rejecting outright would be
 * the same class of mistake as filtering crew on invite_accepted_at, which has
 * silently locked out real crew three times (see lib/crew-auth.ts). This is
 * only reached for genuinely PENDING invites anyway — a row with a user_id or
 * an invite_accepted_at already returned "already used" before this point — so
 * no activated crew member can be affected either way.
 */
function inviteIsExpired(sentAt: string | null, createdAt: string | null): boolean {
  const issuedAt = sentAt ?? createdAt
  if (!issuedAt) return true
  return new Date(issuedAt).getTime() + INVITE_TTL_MS < Date.now()
}

type ActivationSupabase = ReturnType<typeof createServiceClient>

/**
 * Mints the auth account for a crew activation.
 *
 * Extracted so activateCrewAccount stays under the cognitive-complexity
 * threshold; the caller is responsible for deleting the returned user if the
 * subsequent claim on the crew_members row does not land.
 */
async function createActivationUser(
  supabase: ActivationSupabase,
  { email, password, name }: { email: string; password: string; name: string | null },
): Promise<{ userId: string } | { error: string }> {
  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: name, role: 'crew' },
  })

  if (error) {
    if (error.message.includes('already registered')) {
      return { error: 'An account with this email already exists. Try logging in instead.' }
    }
    console.error('[activateCrewAccount]', error)
    return { error: 'Account creation failed — please try again' }
  }

  if (!data.user) return { error: 'Account creation failed — please try again' }

  return { userId: data.user.id }
}

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
  // public route gated only by a UUID token — rate limit by IP.
  // onError: 'allow' — fails open on a Redis outage; a degraded limiter must
  // never block a legitimate crew member finishing setup.
  //
  // A Server Action has no Request object, so the incoming headers are
  // wrapped in one rather than re-implementing the x-forwarded-for parse
  // inline — extractClientIp() is the single place that encodes "Vercel
  // prepends the trusted client IP as the first entry".
  const ip = extractClientIp(
    new Request('https://fieldstay.local', { headers: await headers() })
  ) ?? 'unknown'

  const rateLimit = await checkLimit(inviteAcceptRatelimit, `crew-invite:${ip}`, {
    onError: 'allow',
    site:    'action.crew-invite',
  })
  if (!rateLimit.allowed) {
    return { error: 'Too many attempts. Please try again in a few minutes.' }
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

  if (inviteIsExpired(crew.invite_sent_at, crew.created_at)) {
    return { error: 'This invite link has expired. Ask your manager to send a new one.' }
  }

  const created = await createActivationUser(supabase, {
    email: activationEmail,
    password,
    name:  crew.name,
  })
  if ('error' in created) return { error: created.error }
  const authData = { user: { id: created.userId } }

  // The .is() predicates are the atomic claim: exactly one concurrent
  // activation can match a still-unclaimed row.
  //
  // `.select()` is what makes the claim mean anything. Without it only
  // `linkError` was checked — and a claim that matched ZERO rows is not an
  // error in PostgREST, it is a successful UPDATE of nothing. So the loser of
  // the race (or anyone hitting a row claimed between the read above and this
  // write) fell straight through: it logged an activation audit event, signed
  // the user in, and left the auth.users row it had just created ORPHANED,
  // with no crew_members row pointing at it. That account can log in and then
  // fails every requireCrewMember() check with nothing explaining why, and
  // nothing on the PM side shows the crew member as un-activated.
  const { data: linked, error: linkError } = await supabase
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
    .select('id')

  if (linkError) {
    await supabase.auth.admin.deleteUser(authData.user.id)
    console.error('[activateCrewAccount] link failed', { code: linkError.code, message: linkError.message })
    return { error: 'Failed to activate account. Please try again.' }
  }

  if (!linked?.length) {
    // Claimed by someone else while this request was creating the auth user.
    // The account just minted belongs to nothing, so it is removed rather
    // than left behind as a login that can never reach the crew app.
    await supabase.auth.admin.deleteUser(authData.user.id)
    return { error: 'This invite has already been used' }
  }

  await logAuditEvent({
    orgId:      crew.org_id,
    actorId:    authData.user.id,
    action:     'crew.account.activated',
    targetType: 'crew_member',
    targetId:   crewId,
    // Intentionally omit the address itself — no PII in audit metadata.
    // What matters for an investigation is whether the crew member supplied
    // an email during activation or we already had one on file.
    metadata:   { email_source: crew.email ? 'on_file' : 'entered_at_activation' },
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
