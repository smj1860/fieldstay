import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/inngest/paginate'
import { sendEventsChunked, IN_CLAUSE_CHUNK_SIZE, chunkArray } from '@/lib/inngest/chunk'
import { createPmNotifications } from '@/lib/inngest/helpers'
import { logAuditEvents } from '@/lib/audit'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { localDate } from '@/lib/evidence/packet/deadlines'
import { vendorDispatchFields } from '@/lib/work-orders/vendor-response'
import { reportError } from '@/lib/observability/report-error'
import { getTomorrowForecastForLocation, type DayForecast } from '@/lib/weather/tomorrow'
import {
  decideFreezeWatch, freezeWorkOrderCopy, type FreezeCandidateProperty,
} from '@/lib/evidence/freeze-watch'

const FORECAST_CONCURRENCY = 15   // same ceiling as pre-flight-friction.ts
const MAX_PROPERTIES_PER_ORG = 500
const DAY_MS = 86_400_000

type ServiceClient = ReturnType<typeof createServiceClient>

/** Tomorrow's date in the property's timezone as YYYY-MM-DD: the day whose forecast LOW is read. */
function tomorrowLocalDate(nowMs: number, timezone: string): string {
  return localDate(nowMs + DAY_MS, timezone)
}

/**
 * The night the low actually happens on. Tomorrow's forecast low is reached in
 * the early hours of tomorrow, i.e. at the end of the night that STARTS today,
 * so vacancy is judged for tonight (today's local date), not for tomorrow night.
 * A guest checking out tomorrow morning is in the house for the freeze; one
 * arriving tomorrow afternoon is not.
 */
function tonightLocalDate(nowMs: number, timezone: string): string {
  return localDate(nowMs, timezone)
}

export const freezeWatchCron = inngest.createFunction(
  { id: 'cron-freeze-watch', name: 'Cron: Freeze Watch', retries: 2 },
  { cron: '0 20 * * *' },   // 3pm CT; see confirmation F3
  async ({ step, logger }) => {
    const nowMs = await step.run('capture-now', async () => Date.now())

    const orgIds = await step.run('find-active-orgs', async () => {
      const supabase = createServiceClient({ system: 'inngest:freeze-watch' })
      // Only orgs with at least one active property that has coordinates.
      const rows = await fetchAllRows<{ org_id: string }>(
        (from, to) => supabase
          .from('properties')
          .select('org_id')
          .eq('is_active', true)
          .not('lat', 'is', null)
          .not('lng', 'is', null)
          .order('org_id', { ascending: true })
          .range(from, to),
        { label: 'properties(freeze-watch)' },
      )
      return Array.from(new Set(rows.map((r) => r.org_id)))
    })

    if (orgIds.length) {
      await sendEventsChunked(
        step,
        'fan-out-freeze-watch',
        orgIds.map((orgId) => ({
          name: 'org/freeze_watch.requested' as const,
          // forecast_date is resolved per property (timezones differ); the
          // dispatcher's date is only a label for the run.
          data: { org_id: orgId, forecast_date: new Date(nowMs + DAY_MS).toISOString().slice(0, 10), now_ms: nowMs },
        })),
      )
    }

    logger.info(`Freeze Watch: dispatched ${orgIds.length} org(s)`)
    return { dispatched: orgIds.length }
  },
)

interface PropertyRow extends FreezeCandidateProperty {
  org_id:   string
  timezone: string
}

interface PlanItem {
  property:     PropertyRow
  /** The day whose forecast low triggered this (tomorrow). */
  forecastDate: string
  /** Tonight: the night the low happens on, and the day the prep has to be done by. */
  tonight:      string
  low:          number
  threshold:    number
}

interface CreatedWorkOrder {
  work_order_id:  string
  property_id:    string
  vendor_id:      string | null
  portal_enabled: boolean
  forecast_date:  string
  property_name:  string | null
  low:            number
  /** A vendor is attached but has no portal, so nothing contacted them. */
  vendor_uncontacted: boolean
}

interface FreezeVendor { vendorId: string; portalEnabled: boolean }

async function loadProperties(supabase: ServiceClient, orgId: string): Promise<PropertyRow[]> {
  const { data, error } = await supabase
    .from('properties')
    .select('id, org_id, name, freeze_threshold_f, lat, lng, timezone')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .not('lat', 'is', null)
    .not('lng', 'is', null)
    .limit(MAX_PROPERTIES_PER_ORG)
  if (error) { reportError(error, { site: 'inngest.freeze-watch.properties', orgId }); throw error }
  return (data ?? []) as PropertyRow[]
}

/**
 * Properties with a guest stay covering TONIGHT (see tonightLocalDate). Dates
 * vary by property timezone, so the query takes the widest window and each stay
 * is tested against its own property's date.
 */
async function loadOccupied(
  supabase: ServiceClient, orgId: string, props: readonly PropertyRow[], tonightDates: ReadonlyMap<string, string>,
): Promise<Set<string>> {
  const sorted  = [...tonightDates.values()].sort()
  const minDate = sorted[0]
  const maxDate = sorted.at(-1) ?? minDate
  const occupied = new Set<string>()
  for (const chunk of chunkArray(props.map((p) => p.id), IN_CLAUSE_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('bookings')
      .select('property_id, checkin_date, checkout_date')
      .eq('org_id', orgId)
      .in('property_id', chunk)
      .in('status', ['confirmed', 'tentative'])
      .eq('is_block', false)
      .eq('stay_type', 'guest_stay')
      .lte('checkin_date', maxDate)
      .gt('checkout_date', minDate)
      .limit(2000)
    if (error) { reportError(error, { site: 'inngest.freeze-watch.bookings', orgId }); throw error }
    for (const s of data ?? []) {
      const d = tonightDates.get(s.property_id)
      if (d && s.checkin_date <= d && s.checkout_date > d) occupied.add(s.property_id)
    }
  }
  return occupied
}

/** F1: never stack a second freeze work order while one is open. */
async function loadOpenFreezeWorkOrders(
  supabase: ServiceClient, orgId: string, props: readonly PropertyRow[],
): Promise<Set<string>> {
  const open = new Set<string>()
  for (const chunk of chunkArray(props.map((p) => p.id), IN_CLAUSE_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('work_orders')
      .select('property_id')
      .eq('org_id', orgId)
      .in('property_id', chunk)
      .eq('source', 'freeze_watch')
      .in('status', ['pending', 'quote_requested', 'assigned', 'in_progress'])
      .limit(2000)
    if (error) { reportError(error, { site: 'inngest.freeze-watch.open-wos', orgId }); throw error }
    for (const w of data ?? []) open.add(w.property_id)
  }
  return open
}

/** Bounded concurrency; a failed forecast is "no forecast" for that property only. */
async function loadForecasts(
  orgId: string, props: readonly PropertyRow[], forecastDates: ReadonlyMap<string, string>,
): Promise<Map<string, DayForecast | null>> {
  const forecasts = new Map<string, DayForecast | null>()
  for (const chunk of chunkArray(props, FORECAST_CONCURRENCY)) {
    await Promise.all(chunk.map(async (p) => {
      try {
        forecasts.set(p.id, await getTomorrowForecastForLocation(p.lat!, p.lng!, forecastDates.get(p.id)!))
      } catch (err) {
        reportError(err, { site: 'inngest.freeze-watch.forecast', orgId, level: 'warning' })
        forecasts.set(p.id, null)
      }
    }))
  }
  return forecasts
}

/** Decide, reads only: which properties warrant a prep work order tonight. */
async function evaluateOrg(orgId: string, nowMs: number): Promise<PlanItem[]> {
  const supabase = createServiceClient({ system: 'inngest:freeze-watch' })
  const props = await loadProperties(supabase, orgId)
  if (props.length === 0) return []

  const forecastDates = new Map(props.map((p) => [p.id, tomorrowLocalDate(nowMs, p.timezone)]))
  const tonightDates  = new Map(props.map((p) => [p.id, tonightLocalDate(nowMs, p.timezone)]))
  const [occupied, openWo, forecasts] = await Promise.all([
    loadOccupied(supabase, orgId, props, tonightDates),
    loadOpenFreezeWorkOrders(supabase, orgId, props),
    loadForecasts(orgId, props, forecastDates),
  ])

  const plan: PlanItem[] = []
  for (const p of props) {
    const forecast = forecasts.get(p.id) ?? null
    const decision = decideFreezeWatch({
      property: p,
      forecast: forecast ? { temperatureMin: forecast.temperatureMin ?? null } : null,   // pre-deploy cache rows lack the key
      occupied: occupied.has(p.id),
      hasOpenFreezeWo: openWo.has(p.id),
    })
    if (!decision.fire || decision.low === null) continue
    plan.push({ property: p, forecastDate: forecastDates.get(p.id)!, tonight: tonightDates.get(p.id)!, low: decision.low, threshold: decision.threshold })
  }
  return plan
}

/**
 * F2: a freeze-prep maintenance schedule with a vendor becomes the dispatch.
 * One read for every property in the plan, not one per property.
 */
async function loadFreezeVendors(
  supabase: ServiceClient, orgId: string, propertyIds: readonly string[],
): Promise<Map<string, FreezeVendor>> {
  const out = new Map<string, FreezeVendor>()
  for (const chunk of chunkArray(propertyIds, IN_CLAUSE_CHUNK_SIZE)) {
    const { data, error } = await supabase
      .from('maintenance_schedules')
      .select('property_id, assigned_vendor_id, vendors:assigned_vendor_id(portal_enabled)')
      .eq('org_id', orgId)
      .in('property_id', chunk)
      .eq('is_active', true)
      .ilike('name', '%freeze%')
      .not('assigned_vendor_id', 'is', null)
      .limit(chunk.length * 10)
    if (error) { reportError(error, { site: 'inngest.freeze-watch.vendors', orgId }); throw error }
    for (const row of data ?? []) {
      if (!row.assigned_vendor_id || out.has(row.property_id)) continue
      out.set(row.property_id, { vendorId: row.assigned_vendor_id, portalEnabled: Boolean(unwrapJoin(row.vendors)?.portal_enabled) })
    }
  }
  return out
}

/**
 * One insert per property; the partial unique index is the idempotency guard.
 * A 23505 means a previous attempt of this step already created the row, so it
 * is RECOVERED and returned like a fresh one: the audit row, the PM bell and the
 * vendor dispatch event that followed it are keyed idempotently downstream, and
 * dropping them here is exactly how a replayed step used to lose them. Any other
 * error throws, so the caller records what did land and then fails the step.
 */
async function insertOrRecoverWorkOrder(
  supabase: ServiceClient, orgId: string, item: PlanItem, vendor: FreezeVendor | null,
): Promise<CreatedWorkOrder> {
  const copy = freezeWorkOrderCopy({
    propertyName: item.property.name, forecastDate: item.forecastDate, low: item.low, threshold: item.threshold,
  })
  // A vendor with no portal is attached but never contacted: no dispatch email
  // goes out for portal_enabled = false. Stamping vendor_dispatched_at for them
  // would start the silence timer on someone nobody asked, and the chaser would
  // nag about a job they do not know exists. The PM is told to contact them.
  const dispatched = vendor?.portalEnabled === true
  const { data: wo, error } = await supabase
    .from('work_orders')
    .insert({
      property_id:    item.property.id,
      org_id:         orgId,
      vendor_id:      vendor?.vendorId ?? null,
      title:          copy.title,
      description:    copy.description,
      category:       'plumbing',
      priority:       'high',
      status:         vendor ? 'assigned' : 'pending',
      source:         'freeze_watch',
      needed_by_date: item.tonight,
      portal_enabled: dispatched,
      ...(dispatched ? vendorDispatchFields() : {}),
    })
    .select('id')
    .single()

  const base = {
    property_id: item.property.id, forecast_date: item.forecastDate,
    property_name: item.property.name, low: item.low,
  }
  if (!error) {
    return {
      ...base, work_order_id: wo.id, vendor_id: vendor?.vendorId ?? null,
      portal_enabled: dispatched, vendor_uncontacted: Boolean(vendor) && !dispatched,
    }
  }
  if (error.code !== '23505') throw error
  return recoverExisting(supabase, orgId, item, base)
}

async function recoverExisting(
  supabase: ServiceClient, orgId: string, item: PlanItem,
  base: Pick<CreatedWorkOrder, 'property_id' | 'forecast_date' | 'property_name' | 'low'>,
): Promise<CreatedWorkOrder> {
  const { data, error } = await supabase
    .from('work_orders')
    .select('id, vendor_id, portal_enabled')
    .eq('org_id', orgId)
    .eq('property_id', item.property.id)
    .eq('source', 'freeze_watch')
    .eq('needed_by_date', item.tonight)
    .maybeSingle()
  if (error || !data) throw error ?? new Error('freeze watch work order vanished after a duplicate-key conflict')
  return {
    ...base, work_order_id: data.id, vendor_id: data.vendor_id, portal_enabled: data.portal_enabled,
    vendor_uncontacted: data.vendor_id !== null && !data.portal_enabled,
  }
}

function notificationTitle(propertyName: string | null): string {
  const where = propertyName ? ` at ${propertyName}` : ''
  return `Freeze prep needed${where}`
}

function notificationSubtitle(r: CreatedWorkOrder): string {
  const base = `Forecast low ${Math.round(r.low)}°F on ${r.forecast_date}, property vacant tonight.`
  return r.vendor_uncontacted
    ? `${base} The assigned vendor has no portal access and was not notified. Contact them directly.`
    : base
}

/** Audit rows and bell notifications, batched around the inserts rather than issued per property. */
async function recordCreated(supabase: ServiceClient, orgId: string, created: readonly CreatedWorkOrder[]): Promise<void> {
  await logAuditEvents(created.map((r) => ({
    orgId, action: 'work_order.created' as const, targetType: 'work_order', targetId: r.work_order_id,
    dedupeKey: `freeze-watch-${r.work_order_id}`,
    metadata: { source: 'freeze_watch', forecast_date: r.forecast_date },
  })))
  await createPmNotifications(supabase, created.map((r) => ({
    orgId,
    type:      'work_order_created',
    title:     notificationTitle(r.property_name),
    subtitle:  notificationSubtitle(r),
    href:      `/maintenance?wo=${r.work_order_id}`,
    severity:  'amber' as const,
    dedupeKey: `freeze-watch-${r.property_id}-${r.forecast_date}`,
  })))
}

async function createWorkOrders(orgId: string, plan: readonly PlanItem[]): Promise<CreatedWorkOrder[]> {
  const supabase = createServiceClient({ system: 'inngest:freeze-watch' })
  const vendorByProperty = await loadFreezeVendors(supabase, orgId, plan.map((p) => p.property.id))
  const results: CreatedWorkOrder[] = []
  const failures: unknown[] = []
  for (const item of plan) {
    try {
      results.push(await insertOrRecoverWorkOrder(supabase, orgId, item, vendorByProperty.get(item.property.id) ?? null))
    } catch (err) {
      // One property's failure must not cost the others their work order. They
      // are recorded below; the step then FAILS so Inngest retries, and the
      // retry recovers every row that landed (23505) and re-attempts the rest.
      reportError(err, { site: 'inngest.freeze-watch.insert', orgId })
      failures.push(err)
    }
  }
  await recordCreated(supabase, orgId, results)
  if (failures.length > 0) {
    throw new Error(`Freeze Watch could not create ${failures.length} of ${plan.length} work order(s)`)
  }
  return results
}

export const freezeWatchOrg = inngest.createFunction(
  {
    id:   'freeze-watch-org',
    name: 'Freeze Watch: per org',
    retries: 2,
    concurrency: [{ limit: 10 }, { limit: 1, key: 'event.data.org_id' }],
  },
  { event: 'org/freeze_watch.requested' },
  async ({ event, step, logger }) => {
    const { org_id: orgId, now_ms: nowMs } = event.data

    // Step 1: decide. Reads only, so the create step has no forecast calls to
    // replay if it retries.
    const plan = await step.run('evaluate-properties', () => evaluateOrg(orgId, nowMs))
    if (plan.length === 0) return { created: 0 }

    // Step 2: create. Idempotent per property/date via the partial unique index.
    const created = await step.run('create-work-orders', () => createWorkOrders(orgId, plan))

    // Vendor portal dispatch goes through the existing work-order/created
    // consumer, exactly as the maintenance cron does. Top level, never inside
    // step.run.
    const vendorEvents = created
      .filter((r) => r.vendor_id && r.portal_enabled)
      .map((r) => ({
        name: 'work-order/created' as const,
        data: { work_order_id: r.work_order_id, property_id: r.property_id, org_id: orgId, vendor_id: r.vendor_id!, portal_enabled: r.portal_enabled },
      }))
    if (vendorEvents.length) await step.sendEvent('fire-vendor-portal-events', vendorEvents)

    logger.info(`Freeze Watch org ${orgId}: created ${created.length} work order(s)`)
    return { created: created.length }
  },
)
