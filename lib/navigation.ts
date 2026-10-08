import type { LucideIcon } from 'lucide-react'
import {
  LayoutDashboard, Building2, CalendarCheck, Package, Wrench, Mail,
  BarChart3, Settings, Users2, Briefcase, MessageSquare, ShieldCheck,
  TrendingUp, LifeBuoy, BookOpen, Inbox, Star, LayoutTemplate, CreditCard,
} from 'lucide-react'
import type { MemberRole } from '@/types/database'

export type NavCondition = 'staff'

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
/**
 * The team roles that do operational work.
 *
 * Named rather than spelled out per item because this list was about to be
 * typed into eighteen `roles:` arrays, and the eighteenth is the one that gets
 * missed. 'operations' and 'maintenance' (migration 20261008120000) are the
 * owner-facing "everything except billing" roles; they sit here and NOT on the
 * billing or settings items, which is the whole boundary.
 *
 * This is the NAV mirror of lib/auth.ts's OPS_EQUIVALENT_ROLES and
 * is_org_member()'s SQL clause. All three say the same thing about the same
 * roles, at three layers: what you can SEE, what the Server Action accepts,
 * and what the database allows.
 */
const OPS_ROLES: MemberRole[] = ['admin', 'manager', 'operations', 'maintenance']

/** Ops roles plus read-only 'viewer', for surfaces a viewer may also open. */
const OPS_AND_VIEWER: MemberRole[] = [...OPS_ROLES, 'viewer']

export const ALL_NAV_ITEMS: NavItem[] = [
  // ── Ops tier ──────────────────────────────────────────────────
  { id: 'ops',         href: '/ops',         label: 'Ops Snapshot', icon: LayoutDashboard, roles: OPS_AND_VIEWER, tier: 'ops', category: 'Ops' },
  { id: 'bookings',    href: '/bookings',    label: 'Bookings',     icon: CalendarCheck,   roles: OPS_AND_VIEWER, tier: 'ops', category: 'Ops' },
  { id: 'turnovers',   href: '/turnovers',   label: 'Turnovers',    icon: CalendarCheck,   roles: OPS_AND_VIEWER, tier: 'ops', category: 'Ops', keywords: ['cleaning', 'housekeeping'] },
  // Label deliberately still 'Maintenance', not §9's 'Maintenance & Inspections'.
  // That section carries its own ⚠️ to check the longer label does not wrap in
  // components/bottom-nav.tsx first, and it would: the bottom bar is five equal
  // flex slots at text-xs, so on a 375px phone each has about 75px and the
  // current single word already fills it. Inspections are reached from the tab
  // bar on the Maintenance page itself (§9a), which is the discoverability the
  // rename was for — so the keyword is added here and the label is not.
  { id: 'maintenance', href: '/maintenance', label: 'Maintenance',  icon: Wrench,          roles: OPS_ROLES,           tier: 'ops', category: 'Ops', keywords: ['repair', 'inspection', 'inspections'] },
  { id: 'inventory',   href: '/inventory',   label: 'Inventory',    icon: Package,         roles: OPS_ROLES,           tier: 'ops', category: 'Ops', keywords: ['stock', 'supplies'] },

  // ── Management tier — matches today's exact order ────────────
  { id: 'properties',       href: '/properties',       label: 'Properties',       icon: Building2,   roles: OPS_AND_VIEWER, tier: 'management', category: 'Portfolio' },
  { id: 'reviews',          href: '/reviews',          label: 'Reviews',          icon: Star,         roles: OPS_ROLES,           tier: 'management', category: 'Guest & Comms' },
  { id: 'assets',           href: '/assets',           label: 'Assets',           icon: ShieldCheck, roles: OPS_ROLES,           tier: 'management', category: 'Portfolio' },
  { id: 'capital-planning', href: '/capital-planning', label: 'Capital Planning', icon: TrendingUp,  roles: OPS_ROLES,           tier: 'management', category: 'Portfolio', keywords: ['capex', 'budget'] },
  { id: 'templates',        href: '/templates',        label: 'Templates',       icon: LayoutTemplate, roles: OPS_ROLES,         tier: 'management', category: 'Portfolio' },
  { id: 'crew-manage',      href: '/crew-manage',      label: 'Crew',             icon: Users2,      roles: OPS_ROLES,           tier: 'management', category: 'Team & Vendors' },
  { id: 'messages',         href: '/messages',         label: 'Messages',         icon: MessageSquare, roles: OPS_ROLES,         tier: 'management', category: 'Guest & Comms' },
  { id: 'vendors',          href: '/vendors',          label: 'Vendors',          icon: Briefcase,   roles: OPS_ROLES,           tier: 'management', category: 'Team & Vendors' },
  { id: 'comms-log',        href: '/comms-log',        label: 'Comms Log',        icon: Mail,        roles: OPS_ROLES,           tier: 'management', category: 'Guest & Comms', keywords: ['sms', 'email', 'history'] },
  { id: 'owners',           href: '/owners',           label: 'Owner Portal',     icon: BarChart3,   roles: OPS_ROLES,           tier: 'management', category: 'Guest & Comms' },
  { id: 'guidebook',        href: '/guidebook',        label: 'Guidebook',        icon: BookOpen,    roles: OPS_ROLES,           tier: 'management', category: 'Guest & Comms' },
  // Billing has its own route rather than living only as a tab inside
  // /settings, and the reason is the 'finance' role: a bookkeeper needs the
  // subscription and the org's vendor invoices without /settings' team
  // management, integration credentials and account deletion coming with
  // them. Admins keep the Billing tab in /settings too — same numbers, both
  // from lib/stripe/brackets.ts, which is the single schedule either surface
  // is allowed to derive from.
  { id: 'billing',          href: '/billing',          label: 'Billing',         icon: CreditCard,   roles: ['admin', 'finance'],           tier: 'management', category: 'Settings' },
  { id: 'settings',         href: '/settings',         label: 'Settings',        icon: Settings,     roles: ['admin'],                      tier: 'management', category: 'Settings' },

  // ── Rendered as their own hardcoded blocks below the scrollable nav
  //    list in DashboardSidebar, not part of opsNav/mgmtNav — kept here
  //    so the command palette and mobile drawer still see them.
  { id: 'help',          href: '/help',          label: 'Help & Support', icon: LifeBuoy, roles: [...OPS_AND_VIEWER, 'finance'], tier: 'management', category: 'Settings' },
  { id: 'support-inbox', href: '/support-inbox', label: 'Support Inbox', icon: Inbox,     roles: OPS_AND_VIEWER, tier: 'management', category: 'Settings', condition: 'staff' },
]

/**
 * Centralizes the role/condition filtering that was previously duplicated
 * (and had drifted) across dashboard-shell.tsx and pm-more-drawer.tsx.
 */
export function getVisibleNavItems(
  role: MemberRole,
  opts: { isStaff?: boolean } = {}
): NavItem[] {
  const effectiveRole: MemberRole = role === 'owner' ? 'admin' : role
  return ALL_NAV_ITEMS.filter((item) => {
    if (!item.roles.includes(effectiveRole)) return false
    if (item.condition === 'staff' && !opts.isStaff) return false
    return true
  })
}
