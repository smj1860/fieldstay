import { createClient } from '@/lib/supabase/server'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { tryUnwrapList } from '@/lib/supabase/unwrap'

export interface NotificationItem {
  id:       string
  title:    string
  subtitle: string
  href:     string
  severity: 'amber' | 'red' | 'green' | 'blue'
  /** Only meaningful for persisted (event-log) notifications. */
  read?:    boolean
}

/**
 * The bell's feed, with an explicit failure flag.
 *
 * An empty `items` array used to mean two very different things — "you're all
 * caught up" and "every query behind this panel failed" — and the UI rendered
 * the reassuring one. Combined with the missing authenticated GRANT on
 * `notifications`, that is precisely how the bell went dark in production with
 * no console output and nothing in Sentry. `failed` keeps the two apart.
 */
export interface NotificationFeed {
  items:  NotificationItem[]
  failed: boolean
}

interface PersistedNotificationRow {
  id:         string
  title:      string
  subtitle:   string | null
  href:       string
  severity:   string
  read_at:    string | null
  created_at: string
}

// Recent one-time events (work order complete, dispatched, etc.) — see
// createPmNotification() in lib/inngest/helpers.ts for the write side.
// Distinct from the derived "currently true" alerts below: those resolve
// themselves (e.g. an unassigned turnover disappears once assigned), these
// are a persisted event log that needs explicit read state.
async function getPersistedNotifications(orgId: string): Promise<NotificationFeed> {
  const supabase = await createClient()
  const res = await supabase
    .from('notifications')
    .select('id, title, subtitle, href, severity, read_at, created_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .limit(20)

  const outcome = tryUnwrapList(res, { site: 'lib.notifications.getPersistedNotifications', orgId })
  if (!outcome.ok) return { items: [], failed: true }

  const items = (outcome.data as unknown as PersistedNotificationRow[]).map((n) => ({
    id:       n.id,
    title:    n.title,
    subtitle: n.subtitle ?? '',
    href:     n.href,
    severity: n.severity as NotificationItem['severity'],
    read:     n.read_at !== null,
  }))
  return { items, failed: false }
}

interface TurnoverAlertRow {
  id:                string
  checkout_datetime: string
  status:            string
  properties:        { name: string } | { name: string }[] | null
}

interface WorkOrderAlertRow {
  id:         string
  title:      string
  properties: { name: string } | { name: string }[] | null
}

interface InventoryAlertRow {
  id:                       string
  name:                     string
  current_quantity:        number
  par_level:               number
  first_count_recorded_at: string | null
  properties:              { name: string } | { name: string }[] | null
}

interface VendorComplianceAlertRow {
  vendor_id:         string
  vendor_name:       string
  compliance_status: string
}

function propertyName(p: { name: string } | { name: string }[] | null): string {
  return unwrapJoin(p)?.name ?? 'Property'
}

// Surfaces the operational alerts a PM needs to act on right now —
// unassigned/flagged turnovers, urgent work orders, below-par inventory,
// and vendor compliance issues — for the dashboard notification bell.
export async function getNotifications(orgId: string): Promise<NotificationFeed> {
  const supabase = await createClient()
  const todayIso = new Date().toISOString().split('T')[0]!

  const [turnoversRes, workOrdersRes, inventoryRes, complianceRes] = await Promise.all([
    supabase
      .from('turnovers')
      .select('id, checkout_datetime, status, properties(name)')
      .eq('org_id', orgId)
      .in('status', ['pending_assignment', 'flagged'])
      .gte('checkout_datetime', todayIso)
      .order('checkout_datetime', { ascending: true })
      .limit(5),

    supabase
      .from('work_orders')
      .select('id, title, properties(name)')
      .eq('org_id', orgId)
      .eq('priority', 'urgent')
      .in('status', ['pending', 'quote_requested', 'assigned', 'in_progress'])
      .limit(5),

    supabase
      .from('inventory_items')
      .select('id, name, current_quantity, par_level, first_count_recorded_at, properties(name)')
      .eq('org_id', orgId)
      .eq('is_active', true)
      .limit(200),

    supabase
      .from('vendor_compliance_status')
      .select('vendor_id, vendor_name, compliance_status')
      .eq('org_id', orgId)
      .in('compliance_status', ['hard_blocked', 'expiring_soon', 'grace_period']),
  ])

  // Each source degrades independently: one failing query must not blank the
  // whole bell, but it must never be silently rendered as "nothing to do".
  const turnovers  = tryUnwrapList(turnoversRes,  { site: 'lib.notifications.turnovers',  orgId })
  const workOrders = tryUnwrapList(workOrdersRes, { site: 'lib.notifications.workOrders', orgId })
  const inventory  = tryUnwrapList(inventoryRes,  { site: 'lib.notifications.inventory',  orgId })
  const compliance = tryUnwrapList(complianceRes, { site: 'lib.notifications.compliance', orgId })

  const items: NotificationItem[] = []

  for (const t of ((turnovers.ok ? turnovers.data : []) as unknown as TurnoverAlertRow[])) {
    items.push({
      id:       `turnover-${t.id}`,
      title:    t.status === 'flagged' ? 'Flagged turnover' : 'Unassigned turnover',
      subtitle: `${propertyName(t.properties)} · ${new Date(t.checkout_datetime).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      })}`,
      href:     `/turnovers/${t.id}`,
      severity: t.status === 'flagged' ? 'red' : 'amber',
    })
  }

  for (const wo of ((workOrders.ok ? workOrders.data : []) as unknown as WorkOrderAlertRow[])) {
    items.push({
      id:       `wo-${wo.id}`,
      title:    `Urgent: ${wo.title}`,
      subtitle: propertyName(wo.properties),
      href:     `/maintenance/${wo.id}`,
      severity: 'red',
    })
  }

  const belowPar = ((inventory.ok ? inventory.data : []) as unknown as InventoryAlertRow[])
    .filter((i) => i.first_count_recorded_at && i.current_quantity < i.par_level)
    .slice(0, 5)

  for (const item of belowPar) {
    items.push({
      id:       `inventory-${item.id}`,
      title:    `Low stock: ${item.name}`,
      subtitle: `${propertyName(item.properties)} · ${item.current_quantity}/${item.par_level}`,
      href:     '/inventory?filter=below_par',
      severity: 'amber',
    })
  }

  for (const v of ((compliance.ok ? compliance.data : []) as unknown as VendorComplianceAlertRow[])) {
    items.push({
      id:       `vendor-${v.vendor_id}`,
      title:    v.compliance_status === 'hard_blocked'
        ? `${v.vendor_name} — compliance blocked`
        : `${v.vendor_name} — compliance expiring`,
      subtitle: 'Vendor compliance',
      href:     '/vendors',
      severity: v.compliance_status === 'hard_blocked' ? 'red' : 'amber',
    })
  }

  // Live "currently true" alerts first, then the recent event-log feed.
  const persisted = await getPersistedNotifications(orgId)
  const failed =
    !turnovers.ok || !workOrders.ok || !inventory.ok || !compliance.ok || persisted.failed

  return { items: [...items, ...persisted.items], failed }
}
