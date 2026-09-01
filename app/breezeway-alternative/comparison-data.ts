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

import { GUARANTEE_NAME } from '@/lib/guarantee'

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
    category: 'Guest guidebook',
    fieldstay:
      'Included on every plan at no extra cost, and can pay for itself: sign 5 local business sponsors into ' +
      'your guidebook and FieldStay applies a real $10 credit against your monthly bill automatically; 6 or ' +
      'more sponsors earns $25.',
    breezeway:
      'The digital welcome book ("Guide") sits in the higher "Operations + Guest Experience" tier above the ' +
      'base Operations plan, and Breezeway\'s own pricing page lists it among the add-ons priced a la carte — ' +
      'an added monthly cost, with no revenue-sharing or bill-credit mechanism advertised.',
    fieldstaySource: 'lib/guidebook/helpers.ts, lib/inngest/functions/guidebook-billing-credit-handler.ts',
    breezewaySource: 'breezeway.io/breezeway-pricing ("Get everything in Operations Pro plus: ... Guide, digital welcome books ... All add-ons are priced a la carte."), checked 2026-08-30',
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
 * The 14-day trial offer — split out from the guarantee pillars below
 * (RECORD_GUARANTEE_IMPLEMENTATION.md Workstream 2.2). It used to be pillar
 * one of a three-pillar "Glass Box Operations Guarantee" box, but a trial
 * offer is not a guarantee — it carries no remedy, it is just terms of the
 * free trial — and lumping it in next to a real, credit-bearing commitment
 * blurred the difference between the two. Matches the trial length live
 * everywhere else on the site: every other marketing page (hosts, strops,
 * ownerrez, hospitable, /signup) says 14 days.
 */
export interface TrialOffer {
  title: string
  body:  string
  source: string
}

export const TRIAL_OFFER: TrialOffer = {
  title: 'Try it on your hardest properties, risk-free.',
  body:
    'Run FieldStay on 3–5 of your most demanding properties for 14 days — the ones with spotty signal, ' +
    'tricky access, or vendors who barely answer texts. If it doesn\'t make your week easier, cancel with ' +
    'one click. No contract, no penalty.',
  source: 'app/(auth)/signup/page.tsx',
}

/**
 * The FieldStay Record Guarantee — FieldStay's own policy, not a
 * Breezeway-comparison claim, so it needs only a FieldStay-side citation.
 * Collapsed from three pillars to one (RECORD_GUARANTEE_IMPLEMENTATION.md
 * Workstream 2.2): the trial offer above was never a guarantee, and "built
 * for the people who actually have to use it" is product description, not a
 * promise with a remedy — both moved out. What remains is the one thing that
 * actually is a guarantee: FieldStay logs the record, and credits you if it
 * cannot produce one.
 */
export interface GuaranteePillar {
  title: string
  body:  string
  source: string
}

export const GUARANTEE_PILLARS: readonly GuaranteePillar[] = [
  {
    title: 'If something goes wrong, we show you the record — or credit you.',
    body:
      'Every checklist step, synced photo, and work order status change in FieldStay is timestamped and ' +
      'logged. If you ask what happened on a job and FieldStay cannot produce that record, the billing ' +
      `period is credited under ${GUARANTEE_NAME}.`,
    source: 'lib/audit.ts, types/database.ts (WorkOrderUpdate / AuditEvent), lib/guarantee.ts, ' +
      'supabase/migrations/20260901120748_add_crew_sync_incidents.sql',
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
  {
    // Moved from GUARANTEE_PILLARS (RECORD_GUARANTEE_IMPLEMENTATION.md
    // Workstream 2.2/2.4) — this is product description, not a promise, and
    // the absolute "doesn't need training" claim is softened: crew adoption
    // is the acknowledged rollout risk, and the first struggling cleaner
    // disproves an absolute the way this version can't.
    title: 'Built for the people who actually have to use it.',
    body:
      'The app walks your crew through the checklist step by step, and works with no signal. Your vendors ' +
      'don\'t need to download anything or remember a password — every work order arrives as a link they ' +
      'open, quote, and complete from their phone.',
    source: 'lib/dexie/schema.ts, app/work-orders/[token]/vendor-portal.tsx',
  },
] as const
