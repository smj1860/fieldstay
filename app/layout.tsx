import type { Metadata, Viewport } from 'next'
import Script                       from 'next/script'
import { Syne, DM_Sans } from 'next/font/google'
import { SessionRefreshGuard } from '@/components/session-refresh-guard'
import { CookieNotice } from '@/components/cookie-notice'
import './globals.css'

const syne = Syne({
  subsets:  ['latin'],
  variable: '--font-syne',
  display:  'swap',
})

const dmSans = DM_Sans({
  subsets:  ['latin'],
  variable: '--font-dm-sans',
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

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning
          className={`${syne.variable} ${dmSans.variable}`}>
      <head>
        {/*
          Theme init — loaded from static file to avoid requiring
          'unsafe-inline' on script-src in the Content Security Policy.
          strategy="beforeInteractive" guarantees it runs before paint,
          preventing a flash of the wrong theme.
        */}
        <Script src="/theme-init.js" strategy="beforeInteractive" />
      </head>
      <body>
        <SessionRefreshGuard />
        {children}
        <CookieNotice />
      </body>
    </html>
  )
}
