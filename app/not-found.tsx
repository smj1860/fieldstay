import Link from 'next/link'
import { buttonVariantClass } from '@/components/ui/Button'

// DYNAMIC ON PURPOSE, and it is the reason this file exists at all.
//
// Removing `force-dynamic` from app/layout.tsx (see the block there) made
// Next's built-in /_not-found prerender too. A prerendered page's inline
// scripts carry no nonce, and an unmatched path is by definition not in
// proxy.ts's PRERENDERED_ROUTES, so every hard-loaded 404 anywhere in the app
// would have been served nonce-less HTML under a nonced CSP: ~15 blocked
// inline scripts and a console full of CSP violations on a page that renders
// fine but never hydrates.
//
// Adding `/_not-found` to PRERENDERED_ROUTES is not the alternative — that
// list is matched on the REQUEST path, and the request path for a 404 is
// whatever the visitor typed. There is no path to list.
//
// So the 404 stays server-rendered and keeps its nonce. This also replaces
// Next's unstyled default, which is why there is markup here rather than an
// empty component with a config export.
export const dynamic = 'force-dynamic'

export default function NotFound() {
  return (
    <main
      className="min-h-screen flex items-center justify-center px-6"
      style={{ background: 'var(--bg-base)' }}
    >
      <div className="text-center max-w-md">
        <p
          className="text-sm font-semibold tracking-wide mb-3"
          style={{ color: 'var(--text-muted)' }}
        >
          404
        </p>
        <h1 className="text-2xl font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>
          We couldn&apos;t find that page.
        </h1>
        <p className="text-sm mb-6" style={{ color: 'var(--text-muted)' }}>
          It may have been moved or deleted, or the link may be incomplete.
        </p>
        <Link href="/" className={buttonVariantClass('primary')}>
          Back to FieldStay
        </Link>
      </div>
    </main>
  )
}
