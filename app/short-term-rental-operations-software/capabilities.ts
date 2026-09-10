// ============================================================================
// The three-pillar product story, kept next to the evidence for it.
//
// Same discipline as app/strops/offline-capabilities.ts, and for the same
// reason: this page exists to be quoted — by a search engine's rich result,
// and increasingly by an AI assistant answering "what software handles
// short-term rental turnovers". A claim that has drifted past the product is
// far more expensive here than on a page nobody cites, because the drift gets
// repeated by a third party we cannot edit.
//
// So every entry names the file or table that implements it. Not decoration:
// a reviewer who follows the `source` line can tell in a minute whether a
// bullet is still true. Nothing below is a roadmap item.
//
// ── Where the numbers come from ─────────────────────────────────────────────
//
// NOTHING in this file hardcodes a price. The pillar-three figures are
// imported from lib/guidebook/helpers.ts (the module the billing credit
// handler itself calls) and the property ceiling from lib/stripe/brackets.ts.
// The uploaded design this page was ported from quoted the RETIRED flat-tier
// schedule ($89/$199/$479/$799, four Stripe Products) that the 2026-08-29
// graduated-pricing rebuild replaced — copy outliving the billing system is
// exactly the failure this indirection is here to prevent.
// ============================================================================

import {
  CREDIT_PER_SPONSOR_CENTS,
  SPONSOR_PRICE_CENTS,
  sponsorsToCoverPlan,
} from '@/lib/guidebook/sponsor-economics'
import { MAX_SPONSORS_PER_PROPERTY } from '@/lib/guidebook/assignment-constants'
import { MAX_SELF_SERVE_PROPERTIES, monthlyCostCents } from '@/lib/stripe/brackets'

export interface Capability {
  title: string
  body:  string
  /** Where this is implemented — for the next person editing this copy. */
  source: string
}

export interface Pillar {
  /** The tagline clause this pillar delivers. */
  tag:      string
  heading:  string
  /** One sentence a reader — or an answer engine — can lift whole. */
  claim:    string
  items:    Capability[]
}

const dollars = (cents: number) => `$${cents / 100}`

/**
 * The smallest portfolio whose full sponsor roster covers its whole plan.
 *
 * Two independent limits meet here: a property may display
 * MAX_SPONSORS_PER_PROPERTY sponsors, and it takes sponsorsToCoverPlan() of
 * them to zero the bill. Below this size a host can sell every slot their
 * guidebook has and still owe something; at and above it, a full roster
 * covers the plan outright.
 *
 * SEARCHED rather than asserted, because the answer falls out of the bracket
 * schedule and the display cap and would silently move if either changed —
 * "5" typed here would be a claim with nothing holding it true.
 */
function firstFullyCoveredPortfolio(): number {
  for (let n = 1; n <= MAX_SELF_SERVE_PROPERTIES; n++) {
    const cost = monthlyCostCents(n)
    if (cost === null) continue
    if (n * MAX_SPONSORS_PER_PROPERTY >= sponsorsToCoverPlan(cost)) return n
  }
  return MAX_SELF_SERVE_PROPERTIES
}

const BREAK_EVEN_PROPERTIES = firstFullyCoveredPortfolio()

/** The self-serve ceiling, stated once. */
export const SELF_SERVE_CEILING = MAX_SELF_SERVE_PROPERTIES

/**
 * The single definitional sentence.
 *
 * Deliberately written to survive being extracted with no surrounding
 * context, because that is what an answer engine does with it: it names the
 * category, the boundary against the PMS it sits beside, and the audience,
 * in one sentence. Rendered verbatim as the page's opening paragraph AND as
 * the SoftwareApplication description in json-ld.ts — the two must not
 * diverge, and unit/pages/str-operations-software.test.ts asserts they don't.
 */
export const DEFINITION =
  'FieldStay is short-term rental operations software: the layer that runs turnovers, crew ' +
  'scheduling, maintenance, inventory and vendor work orders after a booking is made. It does not ' +
  'replace a property management system — it connects to the one you already run (OwnerRez, ' +
  'Hospitable, Hostaway) and takes over the field work those systems leave to spreadsheets and ' +
  'group texts.'

export const PILLARS: Pillar[] = [
  {
    tag:     'Operations automated',
    heading: 'The crew shows up already knowing the plan.',
    claim:
      'A checkout, a maintenance schedule or an inspection window creates the job itself, and the job ' +
      'routes to the nearest crew member with room in their workload — no dispatcher, no group text.',
    items: [
      {
        title: 'Automatic job assignment by proximity and workload',
        body:
          'Every crew member carries a home location, a reliability score and a capacity score. Jobs are ' +
          'suggested against all three, and the reasoning is stored with the suggestion so you can see why ' +
          'it picked who it picked.',
        source: 'crew_members.home_lat/lng · turnovers.suggested_crew_ids / suggestion_reasoning',
      },
      {
        title: 'An offline-first crew app',
        body:
          'Checklists, photos, inventory counts and turnover completion all work with no cell service and ' +
          'sync themselves when the phone finds a bar. Not a read-only cache — the full job, start to finish.',
        source: 'lib/dexie/* · public/sw.js',
      },
      {
        title: 'Scheduled maintenance that fires itself',
        body:
          'Recurring service — filters, batteries, deep cleans — creates its own work order on schedule and ' +
          'selects the vendor, weekly through annual.',
        source: 'maintenance_schedules.auto_create_wo (default true) · schedule_frequency',
      },
      {
        title: 'A vendor portal with no login',
        body:
          'Contractors get a tokenised link to the work order. They see the job, upload photos and invoice ' +
          'from it. No account to create, no app to install, no seat to pay for.',
        source: 'app/work-orders/[token] · lib/stripe/vendor-connect-invite.ts',
      },
    ],
  },
  {
    tag:     'Assets protected',
    heading: 'Every appliance has a paper trail.',
    claim:
      'FieldStay keeps a per-asset ledger with a health score, a depreciation schedule and photo evidence ' +
      'from every visit — the documentation you want before a warranty dispute or a tax filing, not after.',
    items: [
      {
        title: 'Photo-verified inspections',
        body:
          'Structured room-by-room checklists with required photo evidence, captured on site and attached to ' +
          'the record for that visit. Reports export per property or across a whole history.',
        source: 'checklist_instance_items · work_order_photos · lib/inspections/report/*',
      },
      {
        title: 'Asset health and replacement forecasting',
        body:
          'Twenty-one asset types — HVAC, water heaters, roofs, pool pumps, septic systems and the rest — ' +
          'each with lifespan ranges and replacement costs, scored 0 to 100 so you see what is aging toward ' +
          'failure while it is still a plan rather than an emergency.',
        source: 'asset_type_standards (21 rows) · property_assets.health_score',
      },
      {
        title: 'CapEx and MACRS depreciation',
        body:
          'Purchase price, placed-in-service date, warranty expiry and MACRS class per asset, with annual ' +
          'depreciation entries your accountant can export rather than reconstruct.',
        source: 'asset_depreciation_entries · property_assets.macrs_class',
      },
      {
        title: 'Par-level inventory with automatic restocking',
        body:
          'Supply levels tracked against per-property thresholds. Drop below par and the restock cart builds ' +
          'itself — counts are fractional, so half a case is half a case.',
        source: 'inventory_items.par_level · lib/inventory/quantity.ts · Kroger cart automation',
      },
      {
        title: 'Vendor compliance that blocks the assignment',
        body:
          'Certificates of insurance, licenses and bonding tracked with expiry dates. An expired document ' +
          'warns for 45 days, then hard-blocks that vendor from being assigned at all.',
        source: 'vendor_compliance_status (grace_period 1–45d · hard_blocked 46d+)',
      },
    ],
  },
  {
    tag:     'Software paid for',
    heading: 'Local businesses fund your guidebook. Literally.',
    claim:
      `Your guest guidebook carries local sponsors. Each pays ${dollars(SPONSOR_PRICE_CENTS)} a month, and ` +
      `${dollars(CREDIT_PER_SPONSOR_CENTS)} of that credits straight against your FieldStay bill — from the ` +
      'first sponsor, with no threshold to clear and no cap on how many you sign. Enough of them and your ' +
      'bill reaches zero.',
    items: [
      {
        title: 'A turnkey sponsor media kit',
        body:
          'FieldStay generates the pitch — a print-ready one-pager for restaurants, activity companies and ' +
          'rental shops — so selling a slot is a conversation, not a design project. Every slot gets its own ' +
          'link that previews the listing and lets the business subscribe on the spot.',
        source: 'guidebook_sponsors.media_kit_token',
      },
      {
        title: `${dollars(SPONSOR_PRICE_CENTS)} per sponsor, ${dollars(CREDIT_PER_SPONSOR_CENTS)} back to you, no ceiling`,
        body:
          'A flat one-third revenue share, credited automatically on your invoice every billing cycle. No ' +
          'tiers, no minimum, and no limit on sponsor count — the only cap is your own plan cost, because ' +
          'the credit stops once your bill reaches zero rather than accruing a balance.',
        source: 'lib/guidebook/helpers.ts → resolvePlanCredit()',
      },
      {
        title: 'At scale, the software pays for itself outright',
        body:
          `Each property shows up to ${MAX_SPONSORS_PER_PROPERTY} local businesses, so a portfolio of ` +
          `${BREAK_EVEN_PROPERTIES} properties has room for ${BREAK_EVEN_PROPERTIES * MAX_SPONSORS_PER_PROPERTY} ` +
          `sponsors — exactly what it takes to cover a ${BREAK_EVEN_PROPERTIES}-property plan in full. Past ` +
          'that the ratio improves: bigger portfolios need fewer sponsors per property to reach zero.',
        source: 'MAX_SPONSORS_PER_PROPERTY · sponsorsToCoverPlan()',
      },
      {
        title: 'Guests still see a curated list, not an ad wall',
        body:
          `Selling more sponsorships never crowds a guest. How many you may sell is unbounded; how many any ` +
          `single property DISPLAYS is ${MAX_SPONSORS_PER_PROPERTY}, chosen for that property. The two limits ` +
          'are separate on purpose.',
        source: 'lib/guidebook/assignment-constants.ts → MAX_SPONSORS_PER_PROPERTY',
      },
    ],
  },
]

/**
 * The four-step turnover sequence, rendered on the page AND marked up as a
 * schema.org HowTo. Both read from here so the rich result can never describe
 * a sequence the page does not show.
 */
export const TURNOVER_STEPS: ReadonlyArray<{ name: string; text: string }> = [
  {
    name: 'The job creates itself',
    text:
      'A guest checkout synced from your PMS, a due maintenance schedule, or an inspection window opens a ' +
      'job automatically. Nobody types it in.',
  },
  {
    name: 'It routes to the nearest available crew',
    text:
      'FieldStay matches the job to the closest crew member who has room in their workload, and records why ' +
      'it chose them.',
  },
  {
    name: 'The crew completes it in the field',
    text:
      'Checklists, photos and inventory counts are captured on site — working with no cell service if the ' +
      'property has none.',
  },
  {
    name: 'It syncs, posts and becomes visible',
    text:
      'The moment the device reconnects the record syncs, the expense posts to the owner ledger, and the ' +
      'owner sees it in their portal if it concerns them.',
  },
]

/**
 * What FieldStay is NOT.
 *
 * On the page for the reason /strops lists what does not work offline: a
 * prospect finds the boundary in a day of trialling, and finding it on the
 * landing page first is what makes the rest credible. It also does specific
 * work for answer engines, which are asked "is X a booking platform" far more
 * often than they are asked what X does — an explicit boundary is the thing
 * that stops a model guessing wrong on our behalf.
 */
export const BOUNDARIES: ReadonlyArray<{ q: string; a: string }> = [
  {
    q: 'It is not a booking platform or channel manager.',
    a:
      'FieldStay does not list your properties, take reservations or manage rates. It connects to the ' +
      'system that does — OwnerRez, Hospitable, Hostaway, or a plain iCal feed from Airbnb and VRBO.',
  },
  {
    q: 'It is not a guest-messaging suite.',
    a:
      'Guest SMS is scoped to operations: door codes, arrival and checkout nudges, and the guidebook. Your ' +
      'PMS keeps the booking conversation.',
  },
  {
    q: 'It is not accounting software.',
    a:
      'It keeps a per-property owner ledger and exports depreciation schedules; it does not file anything ' +
      'or replace your books.',
  },
  {
    q: `Self-serve stops at ${MAX_SELF_SERVE_PROPERTIES} properties.`,
    a:
      `Above ${MAX_SELF_SERVE_PROPERTIES} the pricing is a negotiated contract rather than a published ` +
      'rate. That is a commercial boundary, not a technical one.',
  },
]
