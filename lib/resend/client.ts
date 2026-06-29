import { Resend } from 'resend'
import { renderTeamInviteEmail }   from '@/emails/team-invite'
import { renderOwnerPortalEmail } from '@/emails/owner-portal'
import { renderGuestPreArrivalEmail } from '@/emails/guest-pre-arrival'
import { renderGuidebookGracePeriodEmail } from '@/emails/guidebook-grace-period'

/**
 * Resend client — single instance for all transactional email.
 * Only used server-side (Inngest functions, API routes).
 */
export const resend = new Resend(process.env.RESEND_API_KEY ?? '')

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

export async function sendGuestPreArrivalEmail({
  toEmail,
  guestName,
  propertyName,
  optInUrl,
  guidebookUrl,
}: {
  toEmail:      string
  guestName:    string
  propertyName: string
  optInUrl:     string
  guidebookUrl: string
}) {
  const html = await renderGuestPreArrivalEmail({ guestName, propertyName, optInUrl, guidebookUrl })
  return resend.emails.send({
    from:    FROM,
    to:      toEmail,
    replyTo: 'help@fieldstay.app',
    subject: `Get your door code by text — ${propertyName}`,
    html,
  })
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
