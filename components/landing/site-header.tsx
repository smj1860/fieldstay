'use client'

import Link from 'next/link'
import { SiteMenu } from '@/components/landing/site-menu'

// ============================================================================
// The marketing header, extracted from homepage-content.tsx on 2026-10-03 when
// /why-fieldstay became the second page that needed it. It is one component
// rather than a copy per page for the reason FOOTER_LINKS in homepage-content
// .tsx gives about its own list: two hand-maintained copies of the same
// navigation drift, and the drift is invisible until someone compares them.
//
// `links` is a prop, not a constant, because the two callers legitimately
// differ: the homepage points at an on-page anchor (#who) that exists nowhere
// else, so a shared constant would ship a dead link on every other page.
// <SiteMenu /> is the part that IS the same everywhere, and it is not a prop.
// ============================================================================

export interface SiteHeaderLink {
  label: string
  href:  string
}

export function SiteHeader({ links }: Readonly<{ links: readonly SiteHeaderLink[] }>) {
  return (
    <header
      className="sticky top-0 z-50 flex items-center justify-between"
      style={{
        height:       84,
        padding:      '0 clamp(20px, 5vw, 40px)',
        background:   'var(--mkt-ed-bg)',
        borderBottom: '1px solid var(--mkt-ed-rule)',
      }}
    >
      <div className="flex items-center gap-2 sm:gap-3">
        <SiteMenu />
        <Link
          href="/"
          className="font-display font-bold"
          style={{ fontSize: 'clamp(22px, 4.5vw, 28px)', color: 'var(--mkt-ed-ink)', letterSpacing: '-0.5px' }}
        >
          FieldStay
        </Link>
      </div>

      <nav className="hidden md:flex items-center gap-9 text-[15px] font-medium">
        {links.map((l) => (
          <Link key={l.href} href={l.href} style={{ color: 'var(--mkt-ed-ink)' }}>{l.label}</Link>
        ))}
      </nav>

      <div className="flex items-center gap-3 sm:gap-5 text-[15px]">
        {/* The links above do NOT collapse into the hamburger below md: they
            reappear at md: instead, and the header's job at narrow widths stays
            brand + the two auth actions. <SiteMenu /> on the left is a separate
            thing, the site map rather than a page's conversion path, and it
            shows at every width. */}
        <Link href="/login" className="hidden sm:inline font-medium" style={{ color: 'var(--mkt-ed-ink)' }}>Log in</Link>
        <Link
          href="/signup"
          className="font-semibold rounded-full whitespace-nowrap"
          style={{
            background: 'var(--mkt-ed-ink)',
            color:      '#FFFFFF',
            padding:    'clamp(10px, 2.5vw, 13px) clamp(14px, 4vw, 22px)',
            fontSize:   'clamp(13px, 3.2vw, 15px)',
          }}
        >
          Start free trial
        </Link>
      </div>
    </header>
  )
}
