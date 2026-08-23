'use client'

// The Maintenance tab bar.
//
// docs/INSPECTIONS_SPEC.md §9a: "A real nested route, /maintenance/inspections,
// rendered as a tab." The choice between a tab and a `?tab=` parameter looks
// cosmetic and is not — service worker scope is path-based, so a parameter tab
// could only ever take the WHOLE of /maintenance offline or none of it. Visually
// a tab, structurally a path.
//
// Rendered explicitly by the two LIST pages rather than by a shared
// `maintenance/layout.tsx`. A layout would also put this bar on the two detail
// routes, and on the inspection fill screen in particular that is wrong: a tab
// inviting a tap to "Work orders" in the middle of a walk is an exit from a
// flow with unsaved-looking state, offered for no reason.

import { useRouter, usePathname } from 'next/navigation'
import { ClipboardCheck, Wrench } from 'lucide-react'

import { Tabs } from '@/components/ui/Tabs'

const TAB_ROUTES = {
  work:        '/maintenance',
  inspections: '/maintenance/inspections',
} as const

type TabId = keyof typeof TAB_ROUTES

const TABS = [
  { id: 'work' as const,        label: 'Work orders', icon: <Wrench className="w-4 h-4" /> },
  { id: 'inspections' as const, label: 'Inspections',  icon: <ClipboardCheck className="w-4 h-4" /> },
]

export function MaintenanceTabs() {
  const router   = useRouter()
  const pathname = usePathname()

  // startsWith, so the fill screen's own route would resolve to the same tab if
  // this were ever rendered there. Exact equality would leave both tabs
  // unselected, which reads as a broken bar rather than as a deliberate one.
  const active: TabId = pathname.startsWith(TAB_ROUTES.inspections) ? 'inspections' : 'work'

  return (
    <Tabs
      tabs={TABS}
      active={active}
      onChange={(id) => router.push(TAB_ROUTES[id])}
      className="px-4 sm:px-6 pt-4"
    />
  )
}
