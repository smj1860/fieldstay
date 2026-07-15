import type { SupabaseClient } from '@supabase/supabase-js'
import { resend, FROM } from '@/lib/resend/client'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'
import { isMaintenanceItemActiveThisMonth } from '@/lib/utils/maintenance'
import { logAuditEvent } from '@/lib/audit'

/**
 * Helpers for dailyMaintenanceScheduleCheck's Pass 1 (due-soon schedules)
 * and Pass 3 (vacancy-gap suggestions) — extracted out of
 * lib/inngest/functions/cron/maintenance-schedules.ts. The auto-create-WO
 * and notify-only flows used to be interleaved in one ~140-line step body;
 * they're independent business flows sharing only the schedule/property/
 * vendor/pmEmail inputs, so they're split into their own functions here.
 */

export interface DueSoonScheduleRow {
  id:                 string
  name:               string
  instructions:        string | null
  auto_create_wo:      boolean
  next_due_date:       string | null
  assigned_vendor_id:  string | null
  property_id:         string
  org_id:              string
  estimated_cost:      number | null
}

export interface DueSoonProperty {
  name: string
}

export interface DueSoonVendor {
  id:             string
  name:           string
  email:          string | null
  portal_enabled: boolean
}

export type VendorPortalEvent = {
  work_order_id: string
  property_id:   string
  org_id:        string
  vendor_id:     string
  portal_enabled: true
}

/**
 * schedule.auto_create_wo === true path: create the WO (idempotent on
 * schedule + due date), audit log, notify the PM, and return the vendor
 * portal-dispatch event to fire (or null when nothing new was created).
 */
export async function createMaintenanceWorkOrder(
  supabase:     SupabaseClient,
  schedule:     DueSoonScheduleRow,
  property:     DueSoonProperty | null,
  vendor:       DueSoonVendor | null,
  dueDate:      Date,
  daysUntilDue: number,
  pmEmail:      string | null,
): Promise<VendorPortalEvent | null> {
  // Idempotency: skip insert if a WO already exists for this schedule + due date
  const { data: existingWO } = await supabase
    .from('work_orders')
    .select('id')
    .eq('source_schedule_id', schedule.id)
    .eq('scheduled_date', schedule.next_due_date!)
    .eq('source', 'maintenance_schedule')
    .maybeSingle()

  const { data: wo } = existingWO
    ? { data: existingWO }
    : await supabase
        .from('work_orders')
        .insert({
          property_id:        schedule.property_id,
          org_id:             schedule.org_id,
          vendor_id:          schedule.assigned_vendor_id ?? null,
          title:              schedule.name,
          description:        schedule.instructions,
          priority:           daysUntilDue <= 1 ? 'urgent' : daysUntilDue <= 3 ? 'high' : 'medium',
          status:             'pending',
          source:             'maintenance_schedule',
          source_schedule_id: schedule.id,
          scheduled_date:     schedule.next_due_date,
          estimated_cost:     schedule.estimated_cost,
          portal_enabled:     vendor?.portal_enabled ?? false,
        })
        .select('id')
        .single()

  if (wo && !existingWO) {
    await logAuditEvent({
      orgId:      schedule.org_id,
      action:     'work_order.created',
      targetType: 'work_order',
      targetId:   wo.id,
      metadata:   { source: 'maintenance_schedule', maintenance_schedule_id: schedule.id },
    })
  }

  if (pmEmail && wo && !existingWO) {
    await resend.emails.send(
      {
        from:    FROM,
        to:      pmEmail,
        subject: `Work order created — ${schedule.name} at ${property?.name}`,
        html: await renderPmAlert({
          heading:  'Scheduled maintenance work order created',
          body:     `${schedule.name} is due in ${daysUntilDue} day${daysUntilDue !== 1 ? 's' : ''} — a work order has been created.`,
          details: [
            { label: 'Property',  value: property?.name ?? null },
            { label: 'Due Date',  value: dueDate.toLocaleDateString() },
            { label: 'Est. Cost', value: schedule.estimated_cost ? `$${schedule.estimated_cost}` : null },
            { label: 'Vendor',    value: vendor?.name ?? null },
          ],
          ctaLabel: 'View Work Order →',
          ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/maintenance`,
        }),
      },
      { idempotencyKey: `maint-wo-created-${schedule.id}-${schedule.next_due_date}` }
    )
  }

  return (wo && vendor?.email && vendor?.portal_enabled && !existingWO)
    ? {
        work_order_id:  wo.id,
        property_id:    schedule.property_id,
        org_id:         schedule.org_id,
        vendor_id:      vendor.id,
        portal_enabled: true as const,
      }
    : null
}

/** schedule.auto_create_wo === false path: just alert the PM that it's coming up. */
export async function sendDueSoonAlert(
  pmEmail:      string | null,
  schedule:     DueSoonScheduleRow,
  property:     DueSoonProperty | null,
  vendor:       DueSoonVendor | null,
  dueDate:      Date,
  daysUntilDue: number,
): Promise<void> {
  if (!pmEmail) return

  await resend.emails.send(
    {
      from:    FROM,
      to:      pmEmail,
      subject: `🔧 Maintenance due soon — ${schedule.name} at ${property?.name}`,
      html: await renderPmAlert({
        heading:  'Scheduled maintenance coming up',
        body:     `${schedule.name} is due in ${daysUntilDue} day${daysUntilDue !== 1 ? 's' : ''}.`,
        details: [
          { label: 'Property',  value: property?.name ?? null },
          { label: 'Due Date',  value: dueDate.toLocaleDateString() },
          { label: 'Est. Cost', value: schedule.estimated_cost ? `$${schedule.estimated_cost}` : null },
          { label: 'Vendor',    value: vendor?.name ?? null },
        ],
        ctaLabel: 'Create Work Order →',
        ctaUrl:   `${process.env.NEXT_PUBLIC_APP_URL}/maintenance`,
      }),
    },
    { idempotencyKey: `maint-due-soon-${schedule.id}-${schedule.next_due_date}` }
  )
}

// ── Vacancy-gap suggestions (Pass 3) ─────────────────────────────────────────

const STRONG_GAP_DAYS = 30
const LIGHT_GAP_DAYS  = 14
const LOOKAHEAD_DAYS  = 90

export interface GapProperty {
  id:     string
  org_id: string
  name:   string
}

export interface GapBooking {
  checkin_date:  string
  checkout_date: string
}

export interface GapScheduleRow {
  id:                 string
  property_id:        string
  name:               string
  next_due_date:      string | null
  estimated_cost:     number | null
  assigned_vendor_id: string | null
  active_from_month:  number | null
  active_to_month:    number | null
}

export interface GapSuggestion {
  property_id:   string
  org_id:        string
  property_name: string
  gap_start:     string
  gap_end:       string | null
  gap_days:      number
  tier:          'strong' | 'light'
  candidates: Array<{
    id: string; name: string; next_due_date: string
    estimated_cost: number | null; assigned_vendor_id: string | null
  }>
}

/**
 * Pure in-memory computation of vacancy-gap maintenance suggestions —
 * every property's bookings and schedules are already batch-fetched by the
 * caller, so this does zero DB round trips.
 */
export function computeVacancyGaps(
  properties:          GapProperty[],
  bookingsByProperty:  Map<string, GapBooking[]>,
  schedulesByProperty: Map<string, GapScheduleRow[]>,
): GapSuggestion[] {
  const results: GapSuggestion[] = []

  for (const property of properties) {
    const bookings  = bookingsByProperty.get(property.id) ?? []
    if (!bookings.length) continue
    const schedules = schedulesByProperty.get(property.id) ?? []

    for (let i = 0; i < bookings.length; i++) {
      const checkoutDate = bookings[i]!.checkout_date
      const nextCheckin  = bookings[i + 1]?.checkin_date ?? null

      const gapDays = nextCheckin
        ? Math.round((new Date(nextCheckin).getTime() - new Date(checkoutDate).getTime()) / 86_400_000)
        : LOOKAHEAD_DAYS

      if (gapDays < LIGHT_GAP_DAYS) continue

      // next_due_date <= min(windowEnd, windowStart + LOOKAHEAD_DAYS), and
      // only schedules whose seasonal window is active this month.
      const startMs        = new Date(checkoutDate).getTime()
      const capMs          = startMs + LOOKAHEAD_DAYS * 86_400_000
      const effectiveEndMs = nextCheckin
        ? Math.min(new Date(nextCheckin).getTime(), capMs)
        : capMs
      const effectiveEnd   = new Date(effectiveEndMs).toISOString().split('T')[0]!

      const eligible = schedules
        .filter((s) =>
          s.next_due_date !== null &&
          s.next_due_date <= effectiveEnd &&
          isMaintenanceItemActiveThisMonth(s.active_from_month ?? null, s.active_to_month ?? null)
        )
        .map((s) => ({
          id:                 s.id,
          name:               s.name,
          next_due_date:      s.next_due_date!,
          estimated_cost:     s.estimated_cost,
          assigned_vendor_id: s.assigned_vendor_id,
        }))

      if (!eligible.length) continue

      results.push({
        property_id:   property.id,
        org_id:        property.org_id,
        property_name: property.name,
        gap_start:     checkoutDate,
        gap_end:       nextCheckin,
        gap_days:      gapDays,
        tier:          gapDays >= STRONG_GAP_DAYS ? 'strong' : 'light',
        candidates:    eligible,
      })
    }
  }

  return results
}
