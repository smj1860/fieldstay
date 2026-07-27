import { Resend } from 'resend'
import { renderTeamInviteEmail }   from '@/emails/team-invite'
import { renderOwnerPortalEmail } from '@/emails/owner-portal'
import { renderGuestPreArrivalEmail } from '@/emails/guest-pre-arrival'
import { renderGuidebookGracePeriodEmail } from '@/emails/guidebook-grace-period'
import { renderHospitablePriceLockEmail } from '@/emails/hospitable-price-lock'

/**
 * Resend client — single instance for all transactional email.
 * Only used server-side (Inngest functions, API routes).
 *
 * Constructed lazily via Proxy, not at module load — Resend's constructor
 * throws ("Missing API key") on an empty string, and this file is imported
 * widely enough that Next.js's build-time page-data-collection pass would
 * crash outright in any environment without RESEND_API_KEY set. The Proxy
 * keeps every existing `resend.emails.send(...)` call site unchanged.
 */
let realClient: Resend | null = null

function getClient(): Resend {
  if (!realClient) {
    realClient = new Resend(process.env.RESEND_API_KEY ?? '')
  }
  return realClient
}

export const resend = new Proxy({} as Resend, {
  get(_target, prop, receiver) {
    return Reflect.get(getClient(), prop, receiver)
  },
})

export const FROM = `${process.env.RESEND_FROM_NAME} <${process.env.RESEND_FROM_EMAIL}>`

export async function sendTeamInviteEmail({
  toEmail,
  inviterEmail,
  orgName,
  inviteToken,
}: {
  toEmail:      string
  inviterEmail: string
  orgName:      string
  inviteToken:  string
}) {
  const acceptUrl = `${process.env.NEXT_PUBLIC_APP_URL}/accept-invite/${inviteToken}`
  const html      = await renderTeamInviteEmail({ inviterEmail, orgName, acceptUrl })

  return resend.emails.send({
    from:     FROM,
    to:       toEmail,
    replyTo:  'stephen@fieldstay.app',
    subject:  `You've been invited to join ${orgName} on FieldStay`,
    html,
  })
}

export async function sendOwnerPortalEmail({
  toEmail,
  ownerName,
  orgName,
  propertyName,
  portalUrl,
}: {
  toEmail:      string
  ownerName:    string
  orgName:      string
  propertyName: string
  portalUrl:    string
}) {
  const html = await renderOwnerPortalEmail({ ownerName, orgName, propertyName, portalUrl })
  return resend.emails.send({
    from:    FROM,
    to:      toEmail,
    replyTo: 'help@fieldstay.app',
    subject: `Your owner portal for ${propertyName} is ready — FieldStay`,
    html,
  })
}

/**
 * Guest-facing pre-arrival email. `orgId` opts the send into demo-org
 * suppression — the roadshow seed data uses @example.com addresses, and a
 * live send to those would bounce and cost real domain reputation. Same
 * chokepoint reasoning as sendSMS's orgId option in lib/sms/telnyx.ts.
 *
 * This is deliberately applied ONLY to guest-facing mail. Internal PM mail
 * (team invites, digests, owner-portal links to the demo operator) stays real
 * even for the demo org — those are useful to actually receive.
 */
export async function sendGuestPreArrivalEmail({
  toEmail,
  guestName,
  propertyName,
  optInUrl,
  guidebookUrl,
  orgId,
}: {
  toEmail:      string
  guestName:    string
  propertyName: string
  optInUrl:     string
  guidebookUrl: string
  orgId?:       string
}) {
  const html = await renderGuestPreArrivalEmail({ guestName, propertyName, optInUrl, guidebookUrl })

  const dispatch = () => resend.emails.send({
    from:    FROM,
    to:      toEmail,
    replyTo: 'help@fieldstay.app',
    subject: `Get your door code by text — ${propertyName}`,
    html,
  })

  if (!orgId) return dispatch()

  // Lazy import for the same reason as lib/sms/telnyx.ts's: this module is
  // widely imported and should not drag the Supabase service client into
  // every graph that sends any email.
  const [{ isDemoOrg }, { simulateOrSend, redactEmail }] = await Promise.all([
    import('@/lib/demo/org'),
    import('@/lib/demo/simulate'),
  ])

  if (!(await isDemoOrg(orgId))) return dispatch()

  return simulateOrSend(
    true,
    {
      orgId,
      kind:    'email',
      payload: { to: redactEmail(toEmail), template: 'guest_pre_arrival', propertyName },
    },
    dispatch,
    // Shaped like a Resend success so the caller's `error`/`data` branching
    // takes the same path it would in production.
    { data: { id: `demo_email_${crypto.randomUUID()}` }, error: null } as Awaited<ReturnType<typeof dispatch>>,
  )
}

export async function sendGuidebookGracePeriodEmail({
  toEmail,
  orgName,
  activeSponsors,
  gracePeriodEndsAt,
  guidebookUrl,
}: {
  toEmail:           string
  orgName:           string
  activeSponsors:    number
  gracePeriodEndsAt: string
  guidebookUrl:      string
}) {
  const html = await renderGuidebookGracePeriodEmail({ orgName, activeSponsors, gracePeriodEndsAt, guidebookUrl })
  return resend.emails.send({
    from:    FROM,
    to:      toEmail,
    replyTo: 'help@fieldstay.app',
    subject: `Action needed: your guidebook needs sponsors — FieldStay`,
    html,
  })
}

export async function sendHospitablePriceLockEmail({
  toEmail,
  organizationName,
  sequenceNumber,
  lockYears,
  lockedTierName,
  lockedPriceCents,
}: {
  toEmail:          string
  organizationName: string
  sequenceNumber:    number | null // null for the tier-2 (1-year) lock
  lockYears:         1 | 2
  lockedTierName:    string
  lockedPriceCents:  number
}) {
  const lockedPriceDisplay = `$${(lockedPriceCents / 100).toFixed(0)}/mo`
  const html = await renderHospitablePriceLockEmail({
    organizationName,
    sequenceNumber,
    lockYears,
    lockedTierName,
    lockedPriceDisplay,
  })

  const subject = sequenceNumber !== null
    ? `You're locked in, ${organizationName} — FieldStay + Hospitable launch`
    : `Your plan's price-locked, ${organizationName} — thanks for connecting via Hospitable`

  return resend.emails.send({
    from:    FROM,
    to:      toEmail,
    replyTo: 'stephen@fieldstay.app',
    subject,
    html,
  })
}
