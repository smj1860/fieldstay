import type { Metadata, Viewport } from 'next'
import Script                        from 'next/script'
import localFont from 'next/font/local'
import { Analytics } from '@vercel/analytics/next'
import { SessionRefreshGuard } from '@/components/session-refresh-guard'
import { CookieNotice } from '@/components/cookie-notice'
import './globals.css'

// SELF-HOSTED, not next/font/google.
//
// next/font/google downloads the font at BUILD time. When that fetch fails or
// is throttled, Next still emits a CSS module referencing files it never
// fetched, and the build dies with "Module not found:
// [next]/internal/font/google/<font>.module.css". That took down two PRODUCTION
// deploys on 2026-08-14 alone, both fixed by redeploying the identical commit —
// the signature of a flaky third-party dependency sitting in the critical path
// of every build.
//
// The woff2 files live in app/fonts/ and are the LATIN subset of each
// family's VARIABLE font, so one file covers every weight the app uses.
// Regenerate by fetching the family's css2 URL with a modern browser UA and
// downloading the woff2 named under the `/* latin */` block.
//
// NOT public/. next/font/local hands the file to the bundler, which emits a
// content-hashed copy under /_next/static/media and rewrites the @font-face to
// point there — so a copy in public/ is never fetched by anything. It would
// only be a second, unhashed, cache-bustable copy of the same bytes served on
// a path the middleware matcher does not exclude for nested files, which is
// what unit/lib/proxy-matcher.test.ts caught.
const inter = localFont({
  src:      './fonts/inter-latin-var.woff2',
  variable: '--font-inter',
  display:  'swap',
  // The variable font's full axis range. next/font/local cannot infer this
  // from the file, and omitting it makes every weight render at 400.
  weight:   '100 900',
})

export const metadata: Metadata = {
  title: {
    default:  'FieldStay',
    template: '%s — FieldStay',
  },
  description: 'STR operations platform for property managers.',
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_APP_URL ?? 'https://app.fieldstay.app'
  ),
}

export const viewport: Viewport = {
  width:        'device-width',
  initialScale: 1,
  themeColor:   '#0a1628',
}

// THIS LAYOUT MUST NOT BE DYNAMIC, AND MUST NOT READ THE NONCE.
//
// It used to do both — `export const dynamic = 'force-dynamic'` plus
// `(await headers()).get('x-nonce')`. Either one alone makes EVERY route in
// the app `ƒ (Dynamic)`, because segment config and dynamic-API usage in a
// layout apply to the whole subtree and a child cannot opt back in
// (`export const dynamic = 'force-static'` on app/dpa/page.tsx was tried
// against a real build on 2026-08-20: still ƒ).
//
// So all seven marketing and legal pages were server-rendered on every
// request and returned `cache-control: private, no-cache, no-store` —
// verified live. Nothing in them is per-request; they are compiled from
// constants in this repo.
//
// Neither call was buying anything:
//
//   - `headers()` was NOT what nonces Next's own inline hydration scripts.
//     Next reads the nonce itself, from the REQUEST's Content-Security-Policy
//     header (node_modules/next/dist/server/app-render/app-render.js —
//     `getScriptNonceFromHeader(headers['content-security-policy'])`). That
//     path is untouched by this file.
//   - the `nonce` prop below only ever covered the ONE <Script src=...> tag,
//     and the comment on it already conceded that `'self'` permits a
//     same-origin external script without a nonce.
//
// What DOES depend on this: a prerendered page's inline scripts carry no
// nonce (the HTML predates the request), so proxy.ts serves those paths a
// CSP with `'unsafe-inline'` and no nonce instead. If `force-dynamic` or a
// dynamic API comes back here, those pages go dynamic again and that CSP
// relaxation becomes a pure security loss with nothing bought. That is why
// unit/guardrails/marketing-pages-crawlable.test.ts asserts the ABSENCE of
// both in this file.

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning
          className={inter.variable}>
      <head>
        {/*
          Theme init — loaded from a static file rather than written inline,
          so script-src never needs 'unsafe-inline' for it.
          strategy="beforeInteractive" guarantees it runs before paint,
          preventing a flash of the wrong theme.

          No nonce: this is an EXTERNAL same-origin script, which `'self'`
          already permits under every CSP variant proxy.ts emits. The nonce
          prop that used to be here was described in its own comment as
          defensive and unconfirmed, and it cost a headers() call that made
          the entire app dynamic — see the block above.
        */}
        <Script src="/theme-init.js" strategy="beforeInteractive" />
      </head>
      <body suppressHydrationWarning>
        <SessionRefreshGuard />
        {children}
        <CookieNotice />
        <Analytics />
      </body>
    </html>
  )
}
