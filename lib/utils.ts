import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { format, formatDistanceToNow, differenceInMinutes } from 'date-fns'

/** Merge Tailwind classes safely */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** Format a date for display */
export function formatDate(date: string | Date, pattern = 'MMM d, yyyy') {
  return format(new Date(date), pattern)
}

/** Format a datetime for display */
export function formatDateTime(date: string | Date) {
  return format(new Date(date), 'MMM d, yyyy h:mm a')
}

/** Relative time (e.g. "3 hours ago") */
export function fromNow(date: string | Date) {
  return formatDistanceToNow(new Date(date), { addSuffix: true })
}

/** Minutes between two datetimes */
export function windowMinutes(start: string | Date, end: string | Date) {
  return differenceInMinutes(new Date(end), new Date(start))
}

/** Format window minutes as human-readable */
export function formatWindow(minutes: number): string {
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

/** Generate a URL-safe slug from a string */
export function slugify(str: string): string {
  return str
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** Priority badge color map */
export const PRIORITY_COLORS = {
  low:    'bg-accent-100 text-accent-600',
  medium: 'bg-blue-50 text-blue-700',
  high:   'bg-amber-50 text-amber-700',
  urgent: 'bg-red-50 text-red-700',
} as const

/** Turnover status display map */
export const TURNOVER_STATUS_LABELS = {
  pending_assignment: 'Needs Crew',
  assigned:           'Crew Assigned',
  in_progress:        'In Progress',
  completed:          'Complete',
  flagged:            'Flagged',
  cancelled:          'Cancelled',
} as const

/** Work order status display map */
export const WO_STATUS_LABELS = {
  pending:         'Pending',
  quote_requested: 'Quote Requested',
  assigned:        'Assigned',
  in_progress:     'In Progress',
  completed:       'Complete',
  cancelled:       'Cancelled',
} as const

/** Duration between started_at and completed_at */
export function formatDuration(startedAt: string | null, completedAt: string | null): string | null {
  if (!startedAt || !completedAt) return null
  const totalMins = Math.round(
    (new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 60_000
  )
  if (totalMins < 1)  return '< 1m'
  if (totalMins < 60) return `${totalMins}m`
  const h = Math.floor(totalMins / 60)
  const m = totalMins % 60
  return m > 0 ? `${h}h ${m}m` : `${h}h`
}

/** Inventory category display labels */
export const INVENTORY_CATEGORY_LABELS = {
  paper_goods:        'Paper Goods',
  cleaning:           'Cleaning',
  kitchen:            'Kitchen',
  bath:               'Bath',
  laundry:            'Laundry',
  bedroom_linens:     'Bedroom & Linens',
  outdoor:            'Outdoor',
  maintenance_safety: 'Maintenance & Safety',
  guest_experience:   'Guest Experience',
  technology:         'Technology',
  other:              'Other',
} as const
