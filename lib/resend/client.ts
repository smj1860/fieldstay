import { Resend } from 'resend'
import { renderTeamInviteEmail }   from '@/emails/team-invite'
import { renderOwnerPortalEmail } from '@/emails/owner-portal'

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
