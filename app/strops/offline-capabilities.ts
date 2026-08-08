// ============================================================================
// The offline story, kept next to the evidence for it.
//
// This page's entire job is ranking for "does it work without service", so
// every claim on it has to be one the code actually delivers. Each entry below
// names the file that implements it — not decoration: the failure mode for a
// page like this is copy that ages past the product, and a reviewer who can
// follow the `source` line can tell in a minute whether a bullet is still
// true.
//
// Deliberately includes what does NOT work offline. A prospect evaluating for
// a dead-zone property will find the gaps within a day of trialling; finding
// them on the landing page first is what makes the rest of the page credible.
// ============================================================================

export interface Capability {
  title: string
  body:  string
  /** Where this is implemented — for the next person editing this copy. */
  source: string
}

/** Verified against the crew PWA on 2026-08-08. */
export const LOADS_OFFLINE: Capability = {
  title: 'The app opens with no signal at all',
  body:
    'FieldStay installs to the home screen as a PWA with a service worker that caches the app shell. ' +
    'Screens your crew has opened on that phone come straight back from the device — not a spinner, ' +
    'not a dinosaur, the actual screen. Static assets are content-hashed and cached permanently.',
  source: 'public/sw.js',
}

export const READ_OFFLINE: Capability[] = [
  {
    title: "Today's turnovers",
    body: 'The full board for every property assigned to that crew member, with times and same-day flags.',
    source: 'lib/dexie/schema.ts → CREW_SYNCED_TABLES.turnovers',
  },
  {
    title: 'Every checklist, every item',
    body: 'Room by room, including photo requirements and notes, cached before they lose signal.',
    source: 'checklist_instances / checklist_instance_items',
  },
  {
    title: 'Property details and access info',
    body: 'Addresses and the property record for each assignment.',
    source: 'CREW_SYNCED_TABLES.properties',
  },
  {
    title: 'Inventory par levels and assets',
    body: 'What should be stocked, and the asset ledger for the unit they are standing in.',
    source: 'inventory_items / property_assets',
  },
  {
    title: 'Assigned work orders',
    body: 'The maintenance items attached to that property.',
    source: 'CREW_SYNCED_TABLES.crew_work_orders',
  },
]

export const WRITE_OFFLINE: Capability[] = [
  {
    title: 'Tick off checklist items',
    body: 'Every item, with its completion timestamp — the timestamps duration tracking is built on.',
    source: 'checklist_instance_items:PUT / :PATCH',
  },
  {
    title: 'Start and complete a turnover',
    body: 'Including the final confirmation. The completion posts its owner-ledger expense once it reaches the server.',
    source: 'turnovers:PUT / :PATCH, checklist_instances',
  },
  {
    title: 'Take and attach photos',
    body:
      'Photos go to their own upload queue on the device and upload on their own schedule with retries, ' +
      'so a 40-photo turnover in a basement is not blocked on a single failed request.',
    source: 'pending_photo_uploads',
  },
  {
    title: 'Count inventory',
    body: 'A full count session, submitted when the phone finds a bar of signal.',
    source: 'inventory_counts:PUT',
  },
  {
    title: 'Flag a maintenance issue',
    body: 'Report a problem against a work order, or add a property asset with its photo.',
    source: 'work_order_reports:PUT, property_assets:PUT / :PATCH',
  },
  {
    title: 'Message the office',
    body: 'Sending queues offline. Reading the thread back needs a connection — see below.',
    source: 'messages:PUT',
  },
]

/**
 * The reliability claims. These are the actual differentiator — plenty of apps
 * cache data; the interesting question is what happens to a write made in a
 * basement, and most of the answers below exist because the failure they
 * describe already happened once.
 */
export const RELIABILITY: Capability[] = [
  {
    title: 'A tap cannot be half-saved',
    body:
      'The on-screen change and its queued upload commit in a single IndexedDB transaction. ' +
      'A phone killed by the OS mid-tap either has both or neither — never a checkbox that looks ticked ' +
      'but was never queued to send.',
    source: 'lib/dexie/helpers.ts → writeAndQueue()',
  },
  {
    title: 'Writes replay in the order they were made',
    body:
      'The queue drains oldest-first and stops on the first failure rather than skipping ahead, ' +
      'so two changes to the same turnover can never land out of order.',
    source: 'lib/dexie/syncService.ts → processOutbox()',
  },
  {
    title: 'Nothing fails silently',
    body:
      'Anything that cannot sync surfaces in the app with a retry button. Work done in a dead zone is ' +
      'never quietly thrown away, and never sits invisibly in a queue nobody can see.',
    source: 'app/crew/_components/failed-sync-banner.tsx',
  },
]

/**
 * What needs a connection. On the page, not buried — a prospect evaluating for
 * a no-service property will find these in a day of trialling anyway, and
 * saying so first is what makes everything above believable.
 */
export const NEEDS_CONNECTION: Capability[] = [
  {
    title: 'Requesting time off',
    body: 'Availability is an online-only screen. Crew can view their schedule offline; changing it needs signal.',
    source: 'crew_availability is deliberately not cached',
  },
  {
    title: 'Reading message history',
    body: 'Sending queues offline, but scrolling the thread back is server-rendered.',
    source: 'messages history is not cached',
  },
  {
    title: 'The manager dashboard',
    body: 'Offline support is built for the crew app on a phone. The PM side assumes a desk and a connection.',
    source: 'Dexie is scoped to app/crew/*',
  },
]
