import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard, Building2, CalendarCheck, Package, Wrench, Mail,
  BarChart3, Settings, Users2, Briefcase, MessageSquare, ShieldCheck,
  TrendingUp, LifeBuoy, BookOpen, Inbox, Star,
} from 'lucide-react'
import type { MemberRole } from '@/types/database'

export type NavCondition = 'repuguard' | 'staff'

export interface NavItem {
  id:         string
  href:       string
  label:      string
  icon:       LucideIcon
  roles:      MemberRole[]
  /** Drives the existing two-group sidebar divider — unchanged from today. */
  tier:       'ops' | 'management'
  /** Command-palette result grouping only. Not wired into sidebar rendering. */
  category:   string
  /** Extra search terms for the palette (e.g. "cleaning" for Turnovers). */
  keywords?:  string[]
  condition?: NavCondition
}

// Item order matches today's exact desktop sidebar render sequence
// (dashboard-shell.tsx's old NAV_ITEMS + spliced-in Reviews item), not the
// category groupings below — category is used only for command-palette
// grouping and intentionally doesn't reorder the sidebar. A future pass
// will restructure the sidebar into visual category clusters; until then,
// item position here stays pinned to current production order.
export const ALL_NAV_ITEMS: NavItem[] = [
  // ── Ops tier ──────────────────────────────────────────────────
  { id: 'ops',         href: '/ops',         label: 'Ops Snapshot', icon: LayoutDashboard, roles: ['admin', 'manager', 'viewer'], tier: 'ops', category: 'Ops' },
  { id: 'bookings',    href: '/bookings',    label: 'Bookings',     icon: CalendarCheck,   roles: ['admin', 'manager', 'viewer'], tier: 'ops', category: 'Ops' },
  { id: 'turnovers',   href: '/turnovers',   label: 'Turnovers',    icon: CalendarCheck,   roles: ['admin', 'manager', 'viewer'], tier: 'ops', category: 'Ops', keywords: ['cleaning', 'housekeeping'] },
  { id: 'maintenance', href: '/maintenance', label: 'Maintenance',  icon: Wrench,          roles: ['admin', 'manager'],           tier: 'ops', category: 'Ops', keywords: ['repair'] },
  { id: 'inventory',   href: '/inventory',   label: 'Inventory',    icon: Package,         roles: ['admin', 'manager'],           tier: 'ops', category: 'Ops', keywords: ['stock', 'supplies'] },

  // ── Management tier — matches today's exact order ────────────
  { id: 'properties',       href: '/properties',       label: 'Properties',       icon: Building2,   roles: ['admin', 'manager', 'viewer'], tier: 'management', category: 'Portfolio' },
  { id: 'reviews',          href: '/reviews',          label: 'Reviews',          icon: Star,         roles: ['admin', 'manager'],           tier: 'management', category: 'Guest & Comms', condition: 'repuguard' },
  { id: 'assets',           href: '/assets',           label: 'Assets',           icon: ShieldCheck, roles: ['admin', 'manager'],           tier: 'management', category: 'Portfolio' },
  { id: 'capital-planning', href: '/capital-planning', label: 'Capital Planning', icon: TrendingUp,  roles: ['admin', 'manager'],           tier: 'management', category: 'Portfolio', keywords: ['capex', 'budget'] },
  { id: 'crew-manage',      href: '/crew-manage',      label: 'Crew',             icon: Users2,      roles: ['admin', 'manager'],           tier: 'management', category: 'Team & Vendors' },
  { id: 'messages',         href: '/messages',         label: 'Messages',         icon: MessageSquare, roles: ['admin', 'manager'],         tier: 'management', category: 'Guest & Comms' },
  { id: 'vendors',          href: '/vendors',          label: 'Vendors',          icon: Briefcase,   roles: ['admin', 'manager'],           tier: 'management', category: 'Team & Vendors' },
  { id: 'comms-log',        href: '/comms-log',        label: 'Comms Log',        icon: Mail,        roles: ['admin', 'manager'],           tier: 'management', category: 'Guest & Comms', keywords: ['sms', 'email', 'history'] },
  { id: 'owners',           href: '/owners',           label: 'Owner Portal',     icon: BarChart3,   roles: ['admin', 'manager'],           tier: 'management', category: 'Guest & Comms' },
  { id: 'guidebook',        href: '/guidebook',        label: 'Guidebook',        icon: BookOpen,    roles: ['admin', 'manager'],           tier: 'management', category: 'Guest & Comms' },
  { id: 'settings',         href: '/settings',         label: 'Settings',        icon: Settings,     roles: ['admin'],                      tier: 'management', category: 'Settings' },

  // ── Rendered as their own hardcoded blocks below the scrollable nav
  //    list in DashboardSidebar, not part of opsNav/mgmtNav — kept here
  //    so the command palette and mobile drawer still see them.
  { id: 'help',          href: '/help',          label: 'Help & Support', icon: LifeBuoy, roles: ['admin', 'manager', 'viewer'], tier: 'management', category: 'Settings' },
  { id: 'support-inbox', href: '/support-inbox', label: 'Support Inbox', icon: Inbox,     roles: ['admin', 'manager', 'viewer'], tier: 'management', category: 'Settings', condition: 'staff' },
]

/**
 * Centralizes the role/condition filtering that was previously duplicated
 * (and had drifted) across dashboard-shell.tsx and pm-more-drawer.tsx.
 */
export function getVisibleNavItems(
  role: MemberRole,
  opts: { repuguardActive?: boolean; isStaff?: boolean } = {}
): NavItem[] {
  const effectiveRole: MemberRole = role === 'owner' ? 'admin' : role
  return ALL_NAV_ITEMS.filter((item) => {
    if (!item.roles.includes(effectiveRole)) return false
    if (item.condition === 'repuguard' && !opts.repuguardActive) return false
    if (item.condition === 'staff' && !opts.isStaff) return false
    return true
  })
}
