import { Resend } from 'resend'

/**
 * Resend client — single instance for all transactional email.
 * Only used server-side (Inngest functions, API routes).
 */
export const resend = new Resend(process.env.RESEND_API_KEY!)

export const FROM = `${process.env.RESEND_FROM_NAME} <${process.env.RESEND_FROM_EMAIL}>`

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
