import type { Metadata, Viewport } from 'next'
import { headers }                   from 'next/headers'
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

export const dynamic = 'force-dynamic'

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  // Read the per-request nonce the middleware (proxy.ts) generates and
  // sets on the x-nonce request header. Calling headers() here is what
  // signals Next.js to apply this same nonce to its own internally
  // injected scripts (the streaming/hydration scripts CSP was blocking).
  // This call is also itself a dynamic API — it forces this layout, and
  // everything under it, out of static rendering on its own.
  const nonce = (await headers()).get('x-nonce') ?? undefined

  return (
    <html lang="en" suppressHydrationWarning
          className={inter.variable}>
      <head>
        {/*
          Theme init — loaded from static file to avoid requiring
          'unsafe-inline' on script-src in the Content Security Policy.
          strategy="beforeInteractive" guarantees it runs before paint,
          preventing a flash of the wrong theme.

          nonce is added defensively here even though 'self' already
          permits this same-origin external file under the current CSP —
          see self-audit for why this one prop isn't fully confirmed
          necessary, unlike everything else in this file.
        */}
        <Script src="/theme-init.js" strategy="beforeInteractive" nonce={nonce} />
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
