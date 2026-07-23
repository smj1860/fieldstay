import type { Metadata, Viewport } from 'next'
import { headers }                   from 'next/headers'
import Script                        from 'next/script'
import { Inter } from 'next/font/google'
import { SessionRefreshGuard } from '@/components/session-refresh-guard'
import { CookieNotice } from '@/components/cookie-notice'
import './globals.css'

const inter = Inter({
  subsets:  ['latin'],
  variable: '--font-inter',
  display:  'swap',
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
      </body>
    </html>
  )
}
