const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Escapes a string for safe interpolation into a raw HTML template literal
 * (e.g. `resend.emails.send({ html: \`...\` })`). JSX escapes automatically —
 * this is only needed where HTML is built as a plain string.
 */
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]!)
}
