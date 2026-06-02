import { Resend } from 'resend'

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

  return resend.emails.send({
    from:    'FieldStay <hello@fieldstay.app>',
    to:      toEmail,
    subject: `You've been invited to join ${orgName} on FieldStay`,
    html: `
      <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto; padding: 32px;">
        <h2 style="color: #0a1628;">You're invited to FieldStay</h2>
        <p style="color: #5a6a7a;">
          <strong>${inviterEmail}</strong> has invited you to join
          <strong>${orgName}</strong> on FieldStay as a team admin.
        </p>
        <a href="${acceptUrl}"
           style="display:inline-block; background:#FCD116; color:#0a1628;
                  font-weight:700; padding:12px 24px; border-radius:8px;
                  text-decoration:none; margin: 16px 0;">
          Accept Invitation
        </a>
        <p style="color: #8a9bb0; font-size: 13px;">
          This invitation expires in 7 days. If you didn't expect this email, you can ignore it.
        </p>
      </div>
    `,
  })
}

/**
 * Substitute {{variable}} placeholders in a template string.
 * Used for guest message templates where PMs write their own
 * copy with named variables.
 */
export function renderTemplate(
  template: string,
  variables: Record<string, string | null | undefined>
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (match, key) => {
    return variables[key] ?? match
  })
}
