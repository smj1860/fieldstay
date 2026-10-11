import type { VendorScheduledWindow } from '@/types/database'

/**
 * Which of a work order's two dates to show, and what to call it.
 *
 * Since the date split (20261011120000) a work order carries up to two dates
 * that mean different things:
 *   * `vendor_scheduled_at` — the vendor has confirmed an appointment
 *   * `needed_by_date`      — the PM's deadline, nothing confirmed
 *
 * A confirmed appointment wins, because it is the stronger claim: it is when
 * somebody has actually said they will be there. The deadline is the fallback,
 * and labelling it as such matters — rendering a needed-by date under a
 * "Scheduled" label asserts a commitment that nobody has made, which is the
 * confusion the split exists to end. A crew-assigned work order has no vendor
 * at all, so the deadline is the only date it will ever have.
 *
 * Pure and client-safe: it reads two fields and returns which one to render.
 * The caller owns the label text, so the crew PWA can supply its own
 * translation rather than having English baked in here.
 */
export interface WorkOrderDisplayDate {
  /** ISO date (`YYYY-MM-DD`) or timestamp, whichever field won. */
  value: string
  /** `appointment` = vendor-confirmed, `deadline` = the PM's needed-by. */
  kind:  'appointment' | 'deadline'
  /** Present only on an appointment, and only when the vendor gave one. */
  window: VendorScheduledWindow | null
}

const SCHEDULED_WINDOWS: ReadonlySet<string> = new Set([
  'morning', 'afternoon', 'evening', 'all_day', 'exact',
])

/**
 * Narrows the window as it comes off the database.
 *
 * `vendor_scheduled_window` is a `text` column with a CHECK constraint, not a
 * Postgres enum, so `supabase gen types` can only say `string | null` — the
 * CHECK is a real guarantee that TypeScript cannot see. A bare cast would
 * assert that guarantee without testing it; this VALIDATES, so a value that
 * somehow got past the constraint (a direct SQL write, a dropped constraint)
 * reads as "no window" rather than flowing on as a lie.
 */
export function asScheduledWindow(value: string | null | undefined): VendorScheduledWindow | null {
  return value && SCHEDULED_WINDOWS.has(value) ? (value as VendorScheduledWindow) : null
}

export function workOrderDisplayDate(wo: {
  vendor_scheduled_at?:     string | null
  // Not `| string`: that widens the union back to plain string and loses
  // every bit of checking the five literals buy.
  vendor_scheduled_window?: VendorScheduledWindow | null
  needed_by_date?:          string | null
}): WorkOrderDisplayDate | null {
  if (wo.vendor_scheduled_at) {
    return {
      value:  wo.vendor_scheduled_at,
      kind:   'appointment',
      window: wo.vendor_scheduled_window ?? null,
    }
  }
  if (wo.needed_by_date) {
    return { value: wo.needed_by_date, kind: 'deadline', window: null }
  }
  return null
}

/**
 * The `YYYY-MM-DD` day a work order sorts and buckets on.
 *
 * Returns null when it has no date at all, which callers bucket as "undated"
 * rather than coercing to today — an undated work order is not overdue.
 *
 * The slice is correct for both shapes: `needed_by_date` is already a date, and
 * `vendor_scheduled_at` is an ISO timestamp whose first ten characters are its
 * UTC date. That is the same basis the crew board's existing today/upcoming
 * comparison uses, so this does not introduce a timezone discrepancy it did
 * not already have.
 */
export function workOrderDisplayDay(wo: {
  vendor_scheduled_at?: string | null
  needed_by_date?:      string | null
}): string | null {
  const resolved = workOrderDisplayDate(wo)
  return resolved ? resolved.value.slice(0, 10) : null
}
