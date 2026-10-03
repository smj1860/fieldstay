'use client'

import Link from 'next/link'
import { useRef, useState } from 'react'
import { Menu, X } from 'lucide-react'
import { useFocusTrap } from '@/lib/hooks/use-focus-trap'

// ============================================================================
// The homepage's hamburger menu.
//
// This is a SECOND, separate navigation from the header's inline links (How it
// works / Who it's for / Pricing / vs Breezeway). Those are the conversion
// path through the page; this is the site map, and it is deliberately the full
// list the site is heading towards rather than only the pages that exist
// today. It shows at every width, not only on mobile: the header comment in
// homepage-content.tsx used to say there was no drawer on purpose, which was
// true of a mobile-collapse drawer and is not true of this.
//
// ── Why four items are not links ───────────────────────────────────────────
//
// About, Why FieldStay, Features and Integrations are not built. They are
// listed with a visible "Soon" marker rather than linked, because a menu entry
// that 404s costs more trust than one that says it is coming, and because a
// link to a stub page would be indexed by Google as a real, empty page. Each
// becomes a link by giving it an `href` below and nothing else, so building
// the page and wiring the menu stay one step apart rather than two.
//
// `useFocusTrap` is the SHARED hook (components/ui/Dialog.tsx and the
// dashboard drawers use the same one) and brings focus trapping, Escape to
// close and the body-scroll lock with it. Dialog itself is deliberately NOT
// reused here: its chrome is the app's theme tokens (`bg-card-themed`,
// `text-primary-themed`), which are theme-DEPENDENT, so a prospect on a
// dark-mode phone would get a dark panel over a cream page. See the marketing
// palette note in globals.css for why marketing surfaces keep their own.
// ============================================================================

interface MenuItem {
  label: string
  /** null = the page is not built yet, so the row renders as "Soon" text. */
  href: string | null
}

const MENU_ITEMS: readonly MenuItem[] = [
  { label: 'Home',          href: '/'         },
  { label: 'About',         href: null        },
  { label: 'Why FieldStay', href: null        },
  { label: 'Features',      href: null        },
  { label: 'Pricing',       href: '/pricing'  },
  { label: 'Integrations',  href: null        },
]

const rowStyle: React.CSSProperties = {
  display:       'flex',
  alignItems:    'center',
  gap:           10,
  padding:       '14px 4px',
  fontSize:      17,
  fontWeight:    600,
  borderBottom:  '1px solid var(--mkt-ed-rule)',
}

function SoonBadge() {
  return (
    <span
      className="rounded-full uppercase"
      style={{
        fontSize:      10,
        fontWeight:    700,
        letterSpacing: '0.1em',
        padding:       '3px 8px',
        color:         'var(--mkt-ed-muted)',
        border:        '1px solid var(--mkt-ed-rule)',
      }}
    >
      Soon
    </span>
  )
}

function MenuRow({ item, onNavigate }: Readonly<{ item: MenuItem; onNavigate: () => void }>) {
  if (item.href === null) {
    return (
      <li style={{ ...rowStyle, color: 'var(--mkt-ed-muted)' }}>
        {item.label}
        <SoonBadge />
      </li>
    )
  }

  return (
    <li>
      <Link
        href={item.href}
        onClick={onNavigate}
        className="focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mkt-ed-ink)] rounded"
        style={{ ...rowStyle, color: 'var(--mkt-ed-ink)' }}
      >
        {item.label}
      </Link>
    </li>
  )
}

// Every focus ring below is the NAVY ink, not the brand gold. Gold on this
// cream measures 1.38:1, short of the 3:1 WCAG asks of a non-text indicator and
// close to invisible in practice; the navy is 14.66:1. The gold rings elsewhere
// in the product sit on navy surfaces, where gold is the correct choice.
export function SiteMenu() {
  const [open, setOpen] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)

  const close = () => setOpen(false)
  useFocusTrap(panelRef, open, close)

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Open menu"
        aria-expanded={open}
        aria-controls="site-menu-panel"
        className="flex items-center justify-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mkt-ed-ink)]"
        style={{ width: 44, height: 44, marginLeft: -10, color: 'var(--mkt-ed-ink)' }}
      >
        <Menu size={24} strokeWidth={2.25} aria-hidden="true" />
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0"
            style={{ background: 'rgba(16, 34, 70, 0.45)' }}
            onClick={close}
            aria-hidden="true"
          />
          <div
            ref={panelRef}
            id="site-menu-panel"
            role="dialog"
            aria-modal="true"
            aria-label="Site menu"
            className="fixed left-0 top-0 h-full flex flex-col overflow-y-auto"
            style={{
              width:       'min(320px, 86vw)',
              background:  'var(--mkt-ed-bg)',
              borderRight: '1px solid var(--mkt-ed-rule)',
              padding:     '20px 24px 32px',
            }}
          >
            <div className="flex items-center justify-between" style={{ marginBottom: 12 }}>
              <span
                className="font-display font-bold"
                style={{ fontSize: 22, color: 'var(--mkt-ed-ink)', letterSpacing: '-0.5px' }}
              >
                FieldStay
              </span>
              <button
                type="button"
                onClick={close}
                aria-label="Close menu"
                className="flex items-center justify-center rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--mkt-ed-ink)]"
                style={{ width: 44, height: 44, marginRight: -10, color: 'var(--mkt-ed-ink)' }}
              >
                <X size={22} strokeWidth={2.25} aria-hidden="true" />
              </button>
            </div>

            <nav aria-label="Site">
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {MENU_ITEMS.map((item) => (
                  <MenuRow key={item.label} item={item} onNavigate={close} />
                ))}
              </ul>
            </nav>
          </div>
        </>
      )}
    </>
  )
}
