import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'

import { unwrapList } from '@/lib/supabase/unwrap'
import {
  selectUpcomingSchedules,
  todayISO,
  type DueSchedule,
} from './due-schedules'

// The dashboard's Upcoming Inspections section.
//
// §9: "an Upcoming Inspections section, hidden until an inspection is within
// 30 days. `app/(dashboard)/ops/page.tsx` already computes `addDays(today, 29)`.
// Overdue stays visible and is styled as overdue."
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SELECTION IS SHARED WITH THE MAINTENANCE PAGE, THE FETCH IS NOT
//
// `selectUpcomingSchedules` is the same function the Maintenance inspections
// list calls (through `selectDueSchedules`, which is it at horizon 0), so the
// two surfaces cannot disagree about what counts as due — including the subtle
// part, which is suppressing a schedule whose walk is already under way.
//
// The FETCH differs on purpose. The Maintenance page reads the Dexie cache
// because it is the offline surface; the dashboard is a Server Component and
// reads Supabase directly, which is the split CLAUDE.md draws (Dexie is scoped
// to the crew PWA and the offline inspections route, not the whole dashboard).

/** Days ahead the section looks, inclusive — a 30-day window counting today. */
export const UPCOMING_HORIZON_DAYS = 29

/**
 * Bound on the schedule read.
 *
 * Inspection schedules run one to three per property, so a 50-property
 * portfolio holds ~150 rows and the plan ceiling puts the true maximum far
 * under this. Explicit anyway: `max_rows` truncates at 1000 with a 200 and no
 * signal, and a silently short list here reads as "nothing due" — the exact
 * failure this whole feature exists to prevent.
 */
const SCHEDULE_LIMIT = 500

export interface UpcomingInspection extends DueSchedule {
  propertyName: string | null
}

/**
 * Inspection schedules due within the horizon, overdue ones included.
 *
 * Returns `[]` rather than throwing on an empty org — but a failed READ throws,
 * via `unwrapList`. Those are different answers and must not collapse into one:
 * "this org has no inspections scheduled" is a legitimate steady state, while
 * "we could not read the schedules" rendering as an absent section would hide
 * an overdue safety walk behind a page that looks perfectly fine.
 */
export async function loadUpcomingInspections(
  supabase: SupabaseClient,
  orgId:    string,
  today:    string = todayISO(),
): Promise<UpcomingInspection[]> {
  const schedulesRes = await supabase
    .from('maintenance_schedules')
    // `properties!inner(...)`, and the active filter is on the PROPERTY as well
    // as the schedule. archiveProperty sets properties.is_active = false and
    // leaves maintenance_schedules alone on purpose, so filtering only on the
    // schedule would keep an archived house's inspection on the dashboard as
    // permanently overdue work nobody intends to do.
    .select('id, property_id, name, next_due_date, inspection_form_id, property:properties!inner(name, is_active)')
    .eq('org_id', orgId)
    .eq('creates', 'inspection')
    .eq('is_active', true)
    .eq('property.is_active', true)
    // Bounded at the DATABASE as well as by the selector. The selector has to
    // apply the horizon anyway (it also decides overdue vs. upcoming), but
    // filtering here is what keeps an org with years of dormant annual
    // schedules from shipping all of them over the wire to discard most.
    .not('next_due_date', 'is', null)
    .lte('next_due_date', addDaysISO(today, UPCOMING_HORIZON_DAYS))
    .order('next_due_date', { ascending: true })
    .limit(SCHEDULE_LIMIT)

  const schedules = unwrapList(schedulesRes, {
    site: 'inspections.upcomingForDashboard.schedules',
    orgId,
  }) as ScheduleRow[]

  if (schedules.length === 0) return []

  // OPEN walks only. A completed one does not suppress — completion advances
  // the schedule past today, so a row still reading as due after one is a
  // genuinely new occurrence. Scoped to the schedules we just read so this
  // never becomes a scan of the org's whole inspection history.
  const inspectionsRes = await supabase
    .from('inspections')
    .select('source_schedule_id, completed_at')
    .eq('org_id', orgId)
    .is('completed_at', null)
    .in('source_schedule_id', schedules.map((s) => s.id))
    .limit(schedules.length)

  const openWalks = unwrapList(inspectionsRes, {
    site: 'inspections.upcomingForDashboard.openWalks',
    orgId,
  })

  const selected = selectUpcomingSchedules(schedules, openWalks, today, UPCOMING_HORIZON_DAYS)
  const nameById = new Map(schedules.map((s) => [s.id, propertyNameOf(s)]))

  return selected.map((s) => ({ ...s, propertyName: nameById.get(s.id) ?? null }))
}

interface ScheduleRow {
  id:                 string
  property_id:        string
  name:               string
  next_due_date:      string | null
  inspection_form_id: string | null
  /** A PostgREST embed. Nested joins come back as arrays, never a bare object. */
  property:           { name: string; is_active: boolean }[] | { name: string; is_active: boolean } | null
}

/** Unwraps the embed both ways — PostgREST's shape depends on the relationship. */
function propertyNameOf(row: ScheduleRow): string | null {
  if (!row.property) return null
  return Array.isArray(row.property) ? row.property[0]?.name ?? null : row.property.name
}

/** `YYYY-MM-DD` plus whole days, via UTC so no DST seam can shift the answer. */
function addDaysISO(date: string, days: number): string {
  const ms = Date.UTC(
    Number(date.slice(0, 4)),
    Number(date.slice(5, 7)) - 1,
    Number(date.slice(8, 10)),
  )
  return new Date(ms + days * 86_400_000).toISOString().slice(0, 10)
}
