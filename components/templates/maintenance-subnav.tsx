import Link from 'next/link'

const LINKS = [
  { id: 'create',    href: '/templates/maintenance/create',    label: 'Create Template' },
  { id: 'saved',      href: '/templates/maintenance/saved',      label: 'Saved Templates' },
  { id: 'schedules',  href: '/templates/maintenance/schedules',  label: 'Schedules' },
] as const

// Link-based, not the state-driven components/ui/Tabs — three separate
// routes, not client-state panels of one page. Mirrors
// components/templates/inventory-subnav.tsx exactly — three tiles here
// instead of four (no Master List for Maintenance, per the "DO NOT build
// a Master List screen" decision — the is_system template already serves
// that role).
export function MaintenanceSubnav({ active }: Readonly<{ active: (typeof LINKS)[number]['id'] }>) {
  return (
    <nav aria-label="Maintenance templates" className="flex items-center gap-1 border-b border-themed mb-6 overflow-x-auto">
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
