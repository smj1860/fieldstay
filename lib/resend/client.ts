import { Resend } from 'resend'
import { renderTeamInviteEmail }   from '@/emails/team-invite'

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

