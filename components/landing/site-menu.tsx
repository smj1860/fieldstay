'use client'

import Link from 'next/link'
import { useEffect, useRef, useState } from 'react'
import { Menu, X } from 'lucide-react'

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
// ── Why an item is sometimes not a link ───────────────────────────────────
//
// Every row is now a real page: Why FieldStay, Features, Integrations, FAQ and
// About have all shipped. The affordance stays because the next addition will
// need it. An unbuilt row is listed with a visible "Soon" marker rather than
// linked, because a menu entry that 404s costs more trust than one that says
// it is coming, and because a link to a stub page would be indexed by Google
// as a real, empty page. A row becomes a link by giving it an `href` below and
// nothing else, so building the page and wiring the menu stay one step apart
// rather than two. SoonBadge is kept for that reason and is unused today.
//
// ── Why a native <dialog>, and not role="dialog" ───────────────────────────
//
// This started as a div with role="dialog" plus the shared useFocusTrap hook,
// the same shape components/ui/Dialog.tsx uses. SonarCloud flagged it, and
// following the advice fixed a real bug as well as the lint:
//
//   - The drawer is rendered INSIDE the sticky header, which is a z-50
//     stacking context, so a fixed-position child of it could never paint
//     above anything with a higher z-index. The cookie banner sat on top of
//     the open menu. showModal() puts the element in the browser's TOP LAYER,
//     which is outside the z-index system entirely, so it is above everything
//     no matter where in the tree it lives.
//   - Focus trapping, Escape to close, and making the rest of the page inert
//     all come from the browser rather than from a hook that reimplements
//     them. The one thing <dialog> does NOT do is lock body scroll, so that
//     stays as an effect below.
//
// components/ui/Dialog.tsx is deliberately NOT reused here either way: its
// chrome is the app's theme tokens (`bg-card-themed`, `text-primary-themed`),
// which are theme-DEPENDENT, so a prospect on a dark-mode phone would get a
// dark panel over a cream page. See the marketing palette note in globals.css
// for why marketing surfaces keep their own.
// ============================================================================

interface MenuItem {
  label: string
  /** null = the page is not built yet, so the row renders as "Soon" text. */
  href: string | null
}

const MENU_ITEMS: readonly MenuItem[] = [
  { label: 'Home',          href: '/'         },
  { label: 'About',         href: '/about'    },
  { label: 'Why FieldStay', href: '/why-fieldstay' },
  { label: 'Features',      href: '/features' },
  { label: 'Pricing',       href: '/pricing'  },
  { label: 'Integrations',  href: '/integrations' },
  { label: 'FAQ',           href: '/faq'      },
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
  const dialogRef = useRef<HTMLDialogElement>(null)

  // React state drives the element, never the other way round: showModal() and
  // close() are imperative, so this is the one place they are called.
  useEffect(() => {
    const el = dialogRef.current
    if (!el) return
    if (open && !el.open) el.showModal()
    if (!open && el.open) el.close()
  }, [open])

  // The only behaviour <dialog> does not bring. Restores whatever was there
  // rather than assuming '', so a page that sets its own overflow is not
  // clobbered on close.
  useEffect(() => {
    if (!open) return
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = previous }
  }, [open])

  const close = () => setOpen(false)

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

      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-noninteractive-element-interactions -- the onClick is backdrop dismissal, a pointer affordance whose keyboard counterpart is Escape; <dialog> provides that natively and showModal() traps focus, so no keyboard user can reach this element */}
      <dialog
        ref={dialogRef}
        id="site-menu-panel"
        aria-label="Site menu"
        // Fires for Escape and for close() alike, so state cannot drift out of
        // sync with the element when the BROWSER closes it rather than us.
        onClose={close}
        // A click that lands on the <dialog> itself rather than on its contents
        // is a click on the backdrop: the panel fills the element, so anything
        // outside the panel is outside the element's children.
        //
        // No keyboard equivalent is needed and none is possible: dismissing by
        // clicking outside is a pointer affordance, its keyboard counterpart is
        // Escape, and <dialog> gives that natively (onClose above). showModal()
        // also traps focus inside the panel, so no keyboard user can reach this
        // element to activate it in the first place.
        onClick={(e) => { if (e.target === dialogRef.current) close() }}
        // `site-menu-dialog` carries the ::backdrop rule, which cannot be set
        // from an inline style. See globals.css.
        //
        // NO DISPLAY UTILITY HERE. The UA stylesheet hides a closed dialog with
        // `dialog:not([open]) { display: none }`, and an author rule beats a UA
        // rule whatever its specificity, so a `flex` class on this element
        // leaves the CLOSED drawer displayed: visible over the page and
        // swallowing every click on it. The layout classes live on the wrapper
        // below instead. Verified in a browser, where this was a real bug.
        className="site-menu-dialog"
        style={{
          // Resets the UA's centred-box defaults into a left drawer. A dialog
          // in the top layer is already fixed-positioned, so no `position` is
          // needed, but its auto margins and max-width/height are.
          margin:      0,
          border:      'none',
          inset:       '0 auto 0 0',
          width:       'min(320px, 86vw)',
          maxWidth:    'none',
          height:      '100dvh',
          maxHeight:   'none',
          background:  'var(--mkt-ed-bg)',
          borderRight: '1px solid var(--mkt-ed-rule)',
          padding:     '20px 24px 32px',
          color:       'var(--mkt-ed-ink)',
        }}
      >
        <div className="flex flex-col overflow-y-auto" style={{ height: '100%' }}>
        <div className="flex items-center justify-between flex-shrink-0" style={{ marginBottom: 12 }}>
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
      </dialog>
    </>
  )
}
