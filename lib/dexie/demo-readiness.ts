import type { FieldStayDexie } from '@/lib/dexie/schema'

/**
 * Pre-flight readiness check for the offline crew-PWA demo.
 *
 * The centerpiece trick — fill a checklist and an inventory count in airplane
 * mode with zero lag — only works if everything the screens read is already in
 * IndexedDB before the phone goes offline. This turns "I think it synced" into
 * a checked assertion you can run on wifi at the hotel, instead of finding out
 * mid-conversation that a table was empty.
 *
 * Read-only: it inspects the local cache and never triggers a sync itself, so
 * running it can't paper over the very gap it's meant to detect.
 */

export interface DemoReadinessCheck {
  /** Short label shown in the UI list. */
  label:  string
  ok:     boolean
  /** Populated only when !ok — what to do about it. */
  detail?: string
}

export interface DemoReadinessReport {
  ready:  boolean
  checks: DemoReadinessCheck[]
}

/**
 * Minimum row counts for the demo to be worth attempting. These are floors,
 * not targets — one cached turnover is enough to demo, zero is not.
 */
const MIN_TURNOVERS      = 1
const MIN_PROPERTIES     = 1
const MIN_CHECKLIST_ITEM = 1
const MIN_INVENTORY_ITEM = 1

export async function checkDemoOfflineReadiness(
  db: FieldStayDexie,
): Promise<DemoReadinessReport> {
  const checks: DemoReadinessCheck[] = []

  // Counted in parallel — these are independent IndexedDB reads and the gate
  // is rendered synchronously behind a button press.
  const [
    pendingMutations,
    failedMutations,
    turnovers,
    properties,
    checklistInstances,
    checklistItems,
    inventoryItems,
    workOrders,
    assets,
  ] = await Promise.all([
    db.mutations.filter((m) => !m.failed).count(),
    // `failed` is 0/1, not a boolean (IndexedDB can't index booleans) — so this
    // is an index-backed count rather than a full scan of the outbox.
    db.mutations.where('failed').equals(1).count(),
    db.turnovers.count(),
    db.properties.count(),
    db.checklist_instances.count(),
    db.checklist_instance_items.count(),
    db.inventory_items.count(),
    db.crew_work_orders.count(),
    db.property_assets.count(),
  ])

  checks.push(
    // An outbox with pending work means the local cache holds writes the
    // server hasn't seen. Going offline now is safe for the demo itself, but
    // the laptop-dashboard-updates-live finale depends on the outbox being
    // EMPTY beforehand — otherwise old queued writes flush alongside the new
    // ones and the reveal is muddied.
    {
      label:  'Outbox drained',
      ok:     pendingMutations === 0,
      detail: pendingMutations > 0
        ? `${pendingMutations} unsynced local ${plural(pendingMutations, 'change', 'changes')} still queued. ` +
          `Stay on wifi until this reaches zero.`
        : undefined,
    },
    // Dead-lettered mutations are a different failure: they will never flush
    // on their own, so they'd sit in the queue forever and make the outbox
    // counter look permanently stuck.
    {
      label:  'No dead-lettered writes',
      ok:     failedMutations === 0,
      detail: failedMutations > 0
        ? `${failedMutations} ${plural(failedMutations, 'mutation', 'mutations')} exhausted all retries ` +
          `and will not flush. Resolve before the event.`
        : undefined,
    },
    countCheck('Turnovers cached',        turnovers,          MIN_TURNOVERS),
    countCheck('Properties cached',       properties,         MIN_PROPERTIES),
    countCheck('Checklist instances',     checklistInstances, MIN_CHECKLIST_ITEM),
    countCheck('Checklist items cached',  checklistItems,     MIN_CHECKLIST_ITEM),
    countCheck('Inventory items cached',  inventoryItems,     MIN_INVENTORY_ITEM),
    // Work orders and assets back secondary crew screens. Their absence
    // doesn't block the core checklist/inventory demo, so they're reported
    // as informational rather than folded into `ready`.
    {
      label:  'Work orders cached (optional)',
      ok:     true,
      detail: workOrders === 0 ? 'None cached — the crew work-order screen will be empty.' : undefined,
    },
    {
      label:  'Assets cached (optional)',
      ok:     true,
      detail: assets === 0 ? 'None cached — the crew assets screen will be empty.' : undefined,
    },
  )

  return { ready: checks.every((c) => c.ok), checks }
}

/** Named so the count messages don't need an inline ternary inside a template. */
function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many
}

function countCheck(label: string, actual: number, min: number): DemoReadinessCheck {
  return {
    label,
    ok:     actual >= min,
    detail: actual >= min
      ? undefined
      : `${actual} cached, need at least ${min}. Open the matching crew screen on wifi to pull them down.`,
  }
}
