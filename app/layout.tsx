import type { Metadata, Viewport } from 'next'
import Script                       from 'next/script'
import { headers } from 'next/headers'
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

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  const nonce = (await headers()).get('x-nonce') ?? undefined
  // nonce needs to reach Next.js's own script injection — this is the
  // documented pattern (https://nextjs.org/docs/app/guides/content-security-policy):
  // calling headers() here is what signals Next.js to apply it automatically.
  return (
    <html lang="en" suppressHydrationWarning
          className={inter.variable}>
      <head>
        {/*
          Theme init — loaded from static file to avoid requiring
          'unsafe-inline' on script-src in the Content Security Policy.
          strategy="beforeInteractive" guarantees it runs before paint,
          preventing a flash of the wrong theme.
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
