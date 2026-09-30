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

/**
 * The OLDEST check date across every Breezeway claim below, not the newest.
 *
 * The page renders it as "checked on or after", and each row carries its own
 * date inside `breezewaySource`, because a re-check is per claim: the pricing,
 * roles and mobile-app rows were re-verified 2026-09-30 and the rest were not.
 * Bumping this to the newest date would assert a sweep that did not happen,
 * which is a worse failure than a conservative date: it makes an un-rechecked
 * claim look fresh. Move it only when every row's own date has moved.
 */
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
      'properties requires a demo and a custom quote. No self-serve price is published above 4 units.',
    fieldstaySource: 'lib/stripe/brackets.ts',
    breezewaySource: 'breezeway.io pricing page + third-party pricing summaries (Capterra, GetApp, SoftwareAdvice), re-checked 2026-09-30: unchanged, plus the first property is now listed as free',
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
      'A progressive web app, no App Store or Play Store install. Works fully offline; every checklist ' +
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
      'lifespan, rolled into a 10-year capital expenditure forecast automatically, feeding the capital ' +
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
      'Included on every plan at no extra cost, and can pay for itself: every local business sponsor you ' +
      'sign into your guidebook takes a real $5/month off your bill automatically, from the first one.',
    breezeway:
      'The digital welcome book ("Guide") sits in the higher "Operations + Guest Experience" tier above the ' +
      'base Operations plan, and Breezeway\'s own pricing page lists it among the add-ons priced a la carte, ' +
      'an added monthly cost, with no revenue-sharing or bill-credit mechanism advertised.',
    fieldstaySource: 'lib/guidebook/helpers.ts, lib/inngest/functions/guidebook-billing-credit-handler.ts',
    breezewaySource: 'breezeway.io/breezeway-pricing ("Get everything in Operations Pro plus: ... Guide, digital welcome books ... All add-ons are priced a la carte."), checked 2026-08-30',
  },
  {
    category: 'Assigning work from the field',
    fieldstay:
      'One responsive app. A manager assigns crew, reassigns, and opens a work order from the same ' +
      'screens on a phone as on a desktop, with a mobile nav built for it. With autopilot on, FieldStay ' +
      'picks the crew member itself the moment a turnover is created, scoring familiarity with that ' +
      'property, current workload, reliability and travel distance, so there is usually nothing to assign.',
    breezeway:
      'Native iOS and Android apps, documented for field staff completing the tasks assigned to them ' +
      '(a "My Tasks" page). Assigning those tasks, and the readiness dashboard managers watch, are ' +
      'described on the web dashboard. Breezeway does automatically SCHEDULE turnover and recurring ' +
      'maintenance tasks; whether it also selects which team member gets one was not independently ' +
      'confirmed.',
    fieldstaySource: 'app/(dashboard)/turnovers/turnover-board.tsx, components/bottom-nav.tsx, lib/inngest/functions/auto-assign-turnover.ts',
    breezewaySource: 'help.breezeway.io "Complete Tasks in the Mobile App" + breezeway.io/work-coordination and /task-automation, checked 2026-09-30',
  },
  {
    category: 'Bookkeeper and finance access',
    fieldstay:
      'A finance role that sees the bill, its itemized breakdown, and every vendor invoice, and nothing ' +
      'else: no properties, turnovers, crew or settings. Your bookkeeper does not need an admin seat to ' +
      'close the books.',
    breezeway:
      'Five published internal roles: Administrator, Supervisor, Team Member and Vendor, with ' +
      'Supervisors scoped to their departments. Administrator is the role that manages the account and ' +
      'its users, and is documented as view and edit access to all data and all properties. No ' +
      'billing-only or finance role is published.',
    fieldstaySource: 'supabase/migrations/20260930120000_add_finance_member_role.sql, app/(dashboard)/billing/page.tsx, lib/navigation.ts',
    breezewaySource: 'help.breezeway.io/en/articles/8224900-invite-your-team, checked 2026-09-30',
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
    breezewaySource: 'breezeway.io/property-maintenance-software, checked 2026-08-30, not confirmed either way',
  },
] as const

/**
 * The 14-day trial offer — its own export, separate from FIELDSTAY_HIGHLIGHTS
 * below ("Show me what happened" — Implementation Instructions, Workstream
 * 2). A trial offer is not a capability claim — it carries no remedy, it is
 * just terms of the free trial. Matches the trial length live everywhere
 * else on the site: every other marketing page (hosts, strops, ownerrez,
 * hospitable, /signup) says 14 days.
 */
export interface TrialOffer {
  title: string
  body:  string
  source: string
}

export const TRIAL_OFFER: TrialOffer = {
  title: 'Try it on your hardest properties, risk-free.',
  body:
    'Run FieldStay on 3–5 of your most demanding properties for 14 days, the ones with spotty signal, ' +
    'tricky access, or vendors who barely answer texts. If it doesn\'t make your week easier, cancel with ' +
    'one click. No contract, no penalty.',
  source: 'app/(auth)/signup/page.tsx',
}

/**
 * Capabilities called out on their own — not because Breezeway definitely
 * lacks them (unconfirmed either way, so no comparison claim is made), but
 * because they're real, shipped FieldStay features worth naming on a page
 * a prospect deep in evaluation will actually read closely.
 *
 * FieldStay does not publish a guarantee. There used to be a GUARANTEE_PILLARS
 * export here making a credit-bearing promise about record availability
 * ("Show me what happened" — Implementation Instructions supersedes that
 * draft entirely) — deleted, not softened, because the capability itself
 * needs no promise to be worth stating: it is true today and verifiable
 * during the trial. That capability is the first entry below.
 */
export const FIELDSTAY_HIGHLIGHTS: ReadonlyArray<{ title: string; body: string; source: string }> = [
  {
    title: 'You\'ll never have to take anyone\'s word for it.',
    body:
      'Every checklist step, every photo, and every work order status change is timestamped and logged as ' +
      'it happens, including the ones your crew records with no signal at all. When an owner asks whether ' +
      'the house was ready, or a guest says something was missed, you open the property, pick the date, ' +
      'and read what happened.',
    source: 'lib/audit.ts, types/database.ts, app/(dashboard)/properties/[id]/history/page.tsx',
  },
  {
    title: 'Search the whole portfolio, including work that is already done.',
    body:
      'One keystroke opens search from anywhere in the dashboard. Type a few words and it finds the work order ' +
      'by its title, its number or its description, in any status, completed and cancelled included, ' +
      'alongside the property and the vendor. "The thing about the water heater" is a search, not an ' +
      'afternoon of scrolling. Pick a property instead and you get its whole record by date.',
    source: 'lib/search/entity-search.ts, components/command-palette.tsx, app/(dashboard)/properties/[id]/history/page.tsx',
  },
  {
    title: 'A photo that fails to upload is visible, not lost.',
    body:
      'Photos are shrunk on the phone before they are stored, so a full-resolution camera file cannot ' +
      'fill up the device mid-clean. If an upload fails, it queues and retries, and if it keeps failing ' +
      'your crew member sees it sitting there with a retry button instead of finding out weeks later ' +
      'that the proof was never there.',
    source: 'lib/images/compress.ts, lib/dexie/photo-sync.ts, app/crew/_components/failed-sync-banner.tsx',
  },
  {
    title: 'Support that can already see your account.',
    body:
      'Ask a question in the app and the answer comes from something that can read your own setup, not a ' +
      'help article that assumes someone else\'s. Anything that needs a person, a billing dispute, a ' +
      'consent complaint, a safety issue, is handed to one instead of guessed at. There is no assigned ' +
      'account manager to wait on, because there is nothing queued behind one.',
    source: 'lib/support/respond.ts, lib/support/account-tools.ts, app/api/support/chat',
  },
  {
    title: 'Owner P&L portal',
    body: 'A secure, tokenized link for property owners, with no account and no login, showing revenue, expenses, and net income by period.',
    source: 'app/owner/[token]/**',
  },
  {
    title: 'Inventory with auto-restock',
    body: 'Par levels per property; a low-stock item is added to a purchase order automatically, with a one-click Kroger cart build.',
    source: 'lib/inngest/functions/inventory-events.ts, lib/inngest/functions/build-shopping-cart.ts',
  },
  {
    // The absolute "doesn't need training" claim is softened: crew adoption
    // is the acknowledged rollout risk, and the first struggling cleaner
    // disproves an absolute the way this version can't.
    title: 'Built for the people who actually have to use it.',
    body:
      'The app walks your crew through the checklist step by step, and works with no signal. Your vendors ' +
      'don\'t need to download anything or remember a password. Every work order arrives as a link they ' +
      'open, quote, and complete from their phone.',
    source: 'lib/dexie/schema.ts, app/work-orders/[token]/vendor-portal.tsx',
  },
] as const
