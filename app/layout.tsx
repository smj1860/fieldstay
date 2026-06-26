import type { Metadata, Viewport } from 'next'
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
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" suppressHydrationWarning
          className={`${syne.variable} ${dmSans.variable}`}>
      {/*
        Theme init script — runs before paint to avoid flash.
        Reads localStorage and applies .light class if needed.
        Dark is the default so we only act if user chose light.
      */}
      <head>
        <script dangerouslySetInnerHTML={{ __html: `
          (function() {
            try {
              if (localStorage.getItem('fs-theme') === 'light') {
                document.documentElement.classList.add('light');
              }
            } catch(e) {}
          })();
        ` }} />
      </head>
      <body>
        <SessionRefreshGuard />
        {children}
        <CookieNotice />
      </body>
    </html>
  )
}
