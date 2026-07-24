import Link from 'next/link'

const LINKS = [
  { id: 'master-list', href: '/templates/inventory/master-list', label: 'Master List' },
  { id: 'create',      href: '/templates/inventory/create',      label: 'Create Template' },
  { id: 'saved',       href: '/templates/inventory/saved',       label: 'Saved Templates' },
  { id: 'par-levels',  href: '/templates/inventory/par-levels',  label: 'Par Levels' },
] as const

// Link-based, not the state-driven components/ui/Tabs — these are four
// separate routes, not client-state panels of one page, which Tabs
// doesn't support (it only takes an onChange callback, no href).
export function InventorySubnav({ active }: Readonly<{ active: (typeof LINKS)[number]['id'] }>) {
  return (
    <nav aria-label="Inventory templates" className="flex items-center gap-1 border-b border-themed mb-6 overflow-x-auto">
      {LINKS.map((link) => {
        const isActive = link.id === active
        return (
          <Link
            key={link.id}
            href={link.href}
            aria-current={isActive ? 'page' : undefined}
            className="flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors rounded-t whitespace-nowrap focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[var(--accent-gold)]"
            style={isActive
              ? { borderColor: 'var(--accent-gold)', color: 'var(--accent-gold)' }
              : { borderColor: 'transparent', color: 'var(--text-muted)' }}
          >
            {link.label}
          </Link>
        )
      })}
    </nav>
  )
}
