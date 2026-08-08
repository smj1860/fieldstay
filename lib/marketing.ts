// ============================================================================
// Two origins, and they are not interchangeable.
//
// The apex fieldstay.app and the subdomain app.fieldstay.app are Vercel
// aliases for the SAME deployment — verified: /ownerrez returns 200 with
// identical markup on both. So every public page is reachable at two URLs, and
// that has two consequences this module exists to handle.
//
// 1. DUPLICATE CONTENT. Google sees two URLs with the same content and picks a
//    winner itself unless told. Marketing pages therefore declare an absolute
//    canonical on the APEX, and the sitemap lists apex URLs. A relative
//    canonical would not do: the root layout's metadataBase is
//    NEXT_PUBLIC_APP_URL, so "/strops" resolves to app.fieldstay.app/strops —
//    the opposite of the intent.
//
// 2. HOST-ONLY AUTH COOKIES. Supabase's cookie writer sets no `domain`
//    (lib/supabase/server.ts), so a session created on fieldstay.app is never
//    sent to app.fieldstay.app. A marketing CTA pointing at a relative
//    "/signup" would therefore sign the user up on the marketing host and land
//    them logged-OUT on the app. Marketing CTAs into authenticated flows must
//    be absolute against APP_ORIGIN.
//
// Anything genuinely app-side (Stripe redirects, email links, owner-portal
// URLs) keeps using NEXT_PUBLIC_APP_URL and is untouched by this file.
// ============================================================================

/** Where the public marketing pages canonically live. */
export function marketingOrigin(): string {
  return (process.env.NEXT_PUBLIC_MARKETING_URL ?? 'https://fieldstay.app').replace(/\/$/, '')
}

/** Where the authenticated app lives — and where auth cookies are valid. */
export function appOrigin(): string {
  return (process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app').replace(/\/$/, '')
}

/** Absolute marketing URL, e.g. https://fieldstay.app/strops */
export function marketingUrl(path: string): string {
  return `${marketingOrigin()}${path}`
}

/**
 * Absolute app URL for a link that crosses from a marketing page into the
 * product. Absolute on purpose — see the cookie note above.
 */
export function appUrl(path: string): string {
  return `${appOrigin()}${path}`
}
