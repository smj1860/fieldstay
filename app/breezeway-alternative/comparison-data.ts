// ============================================================================
// Every FieldStay claim on this page cites the file that implements it, same
// discipline as app/strops/offline-capabilities.ts — see that file's header
// for why: a claim with no source is the first one that goes stale.
//
// Every Breezeway claim cites the public source it came from, with the date
// it was checked. Breezeway is a live competitor's product — its pricing and
// feature set can change under us at any time — so RESEARCHED_ON is not
// decoration, it's what a reader (or a future editor of this file) needs to
// know how stale a claim might be. Nothing here is inferred or assumed; if a
// claim isn't independently confirmable from a public page, it isn't on this
// page. unit/pages/breezeway-alternative.test.ts enforces both citation
// fields being present on every row.
// ============================================================================

export const RESEARCHED_ON = '2026-08-30'

export interface ComparisonRow {
  category:        string
  fieldstay:        string
  breezeway:        string
  /** File(s) that make the FieldStay claim true. */
  fieldstaySource:  string
  /** Public URL the Breezeway claim was checked against. */
  breezewaySource:  string
}

export const COMPARISON_ROWS: readonly ComparisonRow[] = [
  {
    category: 'Pricing model',
    fieldstay:
      'One published graduated rate schedule, calculable to the dollar for any count from 1 to 150 ' +
      'properties. No sales call at any size.',
    breezeway:
      '$19.99/property/month, but only published for portfolios of 4 properties or fewer. 5 or more ' +
      'properties requires a demo and a custom quote — no self-serve price is published above 4 units.',
    fieldstaySource: 'lib/stripe/brackets.ts',
    breezewaySource: 'breezeway.io pricing page + third-party pricing summaries, checked 2026-08-30',
  },
  {
    category: 'Vendor work orders',
    fieldstay:
      'A vendor gets a link by text or email, opens it on their phone, and can view, quote, or complete ' +
      'the work order with no account and nothing to install.',
    breezeway:
      'Vendors and cleaners are invited to a Breezeway account and use dedicated Android/iOS apps, logging ' +
      'in with the same credentials as the desktop dashboard.',
    fieldstaySource: 'app/work-orders/[token]/vendor-portal.tsx',
    breezewaySource: 'Breezeway Help Center ("Complete Tasks in the Mobile App") + breezeway.io/checklists-mobile-app, checked 2026-08-30',
  },
  {
    category: 'Crew app',
    fieldstay:
      'A progressive web app — no App Store or Play Store install. Works fully offline; every checklist ' +
      'step, photo, and inventory count queues locally and syncs automatically once signal returns.',
    breezeway:
      'Native iOS and Android apps (separate App Store / Play Store installs), with offline syncing for ' +
      'field staff working without WiFi.',
    fieldstaySource: 'lib/dexie/schema.ts, lib/dexie/syncService.ts',
    breezewaySource: 'breezeway.io/checklists-mobile-app + Google Play / App Store listings, checked 2026-08-30',
  },
  {
    category: 'Asset planning & CapEx forecasting',
    fieldstay:
      'Every major appliance and system gets a health score that updates daily from its age and expected ' +
      'lifespan, rolled into a 10-year capital expenditure forecast automatically — feeding the capital ' +
      'planning page, the owner portal, and a CPA-ready CSV export.',
    breezeway:
      'Asset tracking logs appliance performance and maintenance history for reference. No health scoring or ' +
      'forward-looking capital expenditure forecast is published.',
    fieldstaySource: 'lib/inngest/functions/cron/asset-health.ts, lib/inngest/functions/capex-projection-core.ts, app/(dashboard)/capital-planning/**',
    breezewaySource: 'breezeway.io/property-maintenance-software ("Monitor appliance performance and maintenance history with asset reporting"), checked 2026-08-30',
  },
  {
    category: 'Guest review responses',
    fieldstay:
      'RepuGuard drafts AI-generated responses to guest reviews synced from your PMS, included in every ' +
      'plan at no extra cost. You approve and post it yourself.',
    breezeway:
      'Breezeway markets an AI-powered guest messaging "Concierge" for in-stay communication; whether it ' +
      'drafts responses to posted reviews specifically was not independently confirmed, so no comparison is made here.',
    fieldstaySource: 'lib/inngest/functions/repuguard-batch-generate.ts, components/repuguard/',
    breezewaySource: 'breezeway.io/property-maintenance-software, checked 2026-08-30 — not confirmed either way',
  },
] as const

/**
 * The Glass Box Operations Guarantee — FieldStay's own policy, not a
 * Breezeway-comparison claim, so it needs only a FieldStay-side citation.
 * Adapted from the drafted copy to match the trial length actually live
 * everywhere else on the site: every other marketing page (hosts, strops,
 * ownerrez, hospitable, /signup) says 14 days, and the draft this was built
 * from said 30 — publishing that mismatch would have been exactly the kind
 * of live inconsistency this page's own citation discipline exists to catch.
 */
export interface GuaranteePillar {
  title: string
  body:  string
  source: string
}

export const GUARANTEE_PILLARS: readonly GuaranteePillar[] = [
  {
    title: 'Try it on your hardest properties, risk-free.',
    body:
      'Run FieldStay on 3–5 of your most demanding properties for 14 days — the ones with spotty signal, ' +
      'tricky access, or vendors who barely answer texts. If it doesn\'t make your week easier, cancel with ' +
      'one click. No contract, no penalty.',
    source: 'app/(auth)/signup/page.tsx',
  },
  {
    title: 'If something goes wrong, we show you the record.',
    body:
      'Every checklist step, synced photo, and work order status change in FieldStay is timestamped and ' +
      'logged. If you ever think something was missed or mishandled, we don\'t ask you to trust us — we ' +
      'pull the actual record and show you exactly what happened, and when.',
    source: 'lib/audit.ts, types/database.ts (WorkOrderUpdate / AuditEvent)',
  },
  {
    title: 'Built for the people who actually have to use it.',
    body:
      'Your crew doesn\'t need training — the app works offline and walks them through the checklist step ' +
      'by step. Your vendors don\'t need to download anything or remember a password — every work order ' +
      'arrives as a link they open, quote, and complete from their phone.',
    source: 'lib/dexie/schema.ts, app/work-orders/[token]/vendor-portal.tsx',
  },
] as const

/**
 * Capabilities called out on their own — not because Breezeway definitely
 * lacks them (unconfirmed either way, so no comparison claim is made), but
 * because they're real, shipped FieldStay features worth naming on a page
 * a prospect deep in evaluation will actually read closely.
 */
export const FIELDSTAY_HIGHLIGHTS: ReadonlyArray<{ title: string; body: string; source: string }> = [
  {
    title: 'Owner P&L portal',
    body: 'A secure, tokenized link for property owners — no account, no login — showing revenue, expenses, and net income by period.',
    source: 'app/owner/[token]/**',
  },
  {
    title: 'Inventory with auto-restock',
    body: 'Par levels per property; a low-stock item is added to a purchase order automatically, with a one-click Kroger cart build.',
    source: 'lib/inngest/functions/inventory-events.ts, lib/inngest/functions/build-shopping-cart.ts',
  },
] as const
