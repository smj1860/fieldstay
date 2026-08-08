import type { MetadataRoute } from 'next'

// ============================================================================
// There was no robots.txt before this, so crawlers were free to index every
// reachable URL. Most of the app is auth-gated and would just 302, but three
// classes genuinely should never be crawled:
//
//   - TOKEN-BEARING URLs (/owner/<token>, /work-orders/<token>,
//     /accept-invite/<token>, /crew-invite/<token>, /vendor-connect/<token>,
//     /unsubscribe/<token>). These are unauthenticated-by-design and the token
//     IS the credential. A crawler that follows one from a forwarded email
//     puts a live capability URL into an index.
//   - /api/* — endpoints, never pages.
//   - /demo, /g/* — throwaway and short-link surfaces that would compete with
//     the real landing pages for the same terms.
//
// Disallow is a crawl instruction, NOT an access control: it keeps these out
// of search results, and nothing more. The actual protection is still token
// validation plus the rate limiting in proxy.ts's TOKEN_ROUTES.
// ============================================================================

export default function robots(): MetadataRoute.Robots {
  const base = (process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app').replace(/\/$/, '')

  return {
    rules: [
      {
        userAgent: '*',
        allow: '/',
        disallow: [
          '/api/',
          '/ops',
          '/crew',
          '/crew/',
          '/settings',
          '/onboarding',
          '/admin',
          '/support-inbox',
          '/billing-wall',
          '/demo',
          '/g/',
          // Token-bearing, unauthenticated-by-design — the token is the credential.
          '/owner/',
          '/work-orders/',
          '/accept-invite/',
          '/crew-invite/',
          '/vendor-connect/',
          '/unsubscribe/',
          '/connect/',
        ],
      },
    ],
    sitemap: `${base}/sitemap.xml`,
  }
}
