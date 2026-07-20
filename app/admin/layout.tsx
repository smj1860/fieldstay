import Link from 'next/link'
import type { Metadata } from 'next'
import { requirePlatformAdmin } from '@/lib/auth'

export const metadata: Metadata = { title: 'Platform Admin — FieldStay' }

const NAV_LINKS = [
  { href: '/admin',                  label: 'Overview' },
  { href: '/admin/seed-templates',   label: 'Default Room Templates' },
  { href: '/admin/inventory-catalog', label: 'Inventory Catalog' },
]

export default async function AdminLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  await requirePlatformAdmin()

  return (
    <div className="min-h-screen" style={{ background: 'var(--bg-base)' }}>
      <header
        className="border-b"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-card)' }}
      >
        <div className="max-w-5xl mx-auto px-6 py-4">
          <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--accent-gold)' }}>
            FieldStay Platform Admin
          </p>
          <nav className="flex items-center gap-4 mt-2">
            {NAV_LINKS.map((link) => (
              <Link
                key={link.href}
                href={link.href}
                className="text-sm font-medium hover:underline"
                style={{ color: 'var(--text-secondary)' }}
              >
                {link.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="max-w-5xl mx-auto px-6 py-8">{children}</main>
    </div>
  )
}
