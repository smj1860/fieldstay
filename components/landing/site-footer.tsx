import Link from 'next/link'

// ============================================================================
// The marketing footer, extracted from homepage-content.tsx on 2026-10-03 when
// /why-fieldstay became the second page to need it. Same reasoning as
// site-header.tsx: a second hand-maintained copy drifts, and this one carries
// the link map that is load-bearing for crawlability.
//
// FOOTER_LINKS came with it and keeps its original note, which is the reason
// the list must not be trimmed: Google Search Console reported all six
// marketing and legal pages as "Discovered - currently not indexed" while this
// footer carried only /login and /signup. Every public page is linked from the
// highest-authority page on the site, on purpose. Add a new marketing page
// here when you add it to app/sitemap.ts.
//
// Relative hrefs on purpose. These are same-host marketing pages, so they
// resolve on whichever of the two aliases the visitor is on and inherit that
// page's own apex canonical, unlike a CTA into an authenticated flow, which
// lib/marketing.ts requires to be absolute against APP_ORIGIN so the session
// cookie lands on the right host.
// ============================================================================

export const FOOTER_LINKS: ReadonlyArray<{ label: string; href: string }> = [
  { label: 'Pricing',        href: '/pricing'      },
  { label: 'Why FieldStay',  href: '/why-fieldstay' },
  { label: 'Features',       href: '/features'      },
  { label: 'Integrations',   href: '/integrations'  },
  { label: 'FAQ',            href: '/faq'           },
  { label: 'STR Operations', href: '/short-term-rental-operations-software' },
  { label: 'Turnover App',   href: '/strops'       },
  { label: 'For Hosts',      href: '/hosts'        },
  { label: 'Enterprise',     href: '/enterprise'   },
  { label: 'For Vendors',    href: '/for-vendors'  },
  { label: 'OwnerRez',       href: '/ownerrez'     },
  { label: 'Hospitable',     href: '/hospitable'   },
  { label: 'vs Breezeway',   href: '/breezeway-alternative' },
  { label: 'Privacy',        href: '/privacy'      },
  { label: 'Terms',          href: '/terms'        },
  { label: 'DPA',            href: '/dpa'          },
  { label: 'Log In',         href: '/login'        },
  { label: 'Sign Up',        href: '/signup'       },
]

export function SiteFooter() {
  return (
    <footer style={{ padding: 'clamp(40px, 8vw, 64px) clamp(20px, 5vw, 40px) clamp(28px, 6vw, 44px)', background: 'var(--mkt-ed-ink-deep)' }}>
      <div className="flex flex-col gap-14">
        <div className="flex flex-col lg:flex-row justify-between gap-10">
          <div className="flex flex-col gap-3.5" style={{ maxWidth: 320 }}>
            <span className="font-display font-bold text-2xl text-white">FieldStay</span>
            <span className="text-[15px] leading-relaxed" style={{ color: 'var(--mkt-ed-on-ink-soft)' }}>
              Property operations for short-term rental managers. Made in Alabama.
            </span>
            <a href="mailto:hello@fieldstay.app" className="text-[15px]" style={{ color: 'var(--mkt-gold)' }}>hello@fieldstay.app</a>
          </div>
          <div className="flex flex-wrap items-start gap-x-6 gap-y-3 text-[15px]" style={{ maxWidth: 640 }}>
            {FOOTER_LINKS.map((l) => (
              <Link key={l.label} href={l.href} className="transition-colors" style={{ color: 'rgba(201,210,230,0.7)' }}>
                {l.label}
              </Link>
            ))}
          </div>
        </div>
        <span className="text-xs" style={{ color: 'var(--mkt-ed-on-ink-faint)' }}>
          &copy; {new Date().getFullYear()} Lake Martin Delivery LLC, d/b/a FieldStay
        </span>
      </div>
    </footer>
  )
}
