import 'server-only'
import { createServiceClient } from '@/lib/supabase/server'
import { DEMO_ORG_SLUG } from '@/lib/demo/config'
import {
  DEMO_ORG_NAME, DEMO_PROPERTIES, DEMO_CREW, DEMO_VENDORS,
  DEMO_ASSETS, DEMO_SPONSORS, DEMO_GUEST_NAMES, demoOwnerContact,
} from '@/lib/demo/seed-data'
import { seedDefaultRoomTemplatesIfNeeded } from '@/lib/checklists/seed-default-room-templates'
import { applyMasterChecklistToProperty, fetchOrgRoomTemplateData } from '@/lib/checklists/apply-master-template'
import { seedOrgInventoryCatalogIfNeeded } from '@/lib/inventory/seed-org-catalog'
import { generateTurnoversForProperty } from '@/lib/turnovers/generator'
import { REQUIRED_ASSET_TYPES, ASSET_TYPE_DISPLAY_NAMES } from '@/lib/asset-discovery/config'
import type { Database, TablesInsert } from '@/types/database'

/** Any real table in the public schema — see WIPE_ORDER for why not `string`. */
type DemoTable = keyof Database['public']['Tables']

/**
 * Tables that actually carry an org_id column. The wipe filters every DELETE
 * on `.eq('org_id', orgId)`, so a table without that column could never be
 * scoped to the demo org — listing one in WIPE_ORDER is a bug this type
 * catches at compile time rather than at `DELETE` time.
 */
type OrgScopedTable = {
  [K in DemoTable]: 'org_id' extends keyof Database['public']['Tables'][K]['Row'] ? K : never
}[DemoTable]

/**
 * Wipe + reseed the roadshow demo org.
 *
 * SAFETY MODEL — read before changing anything here:
 *
 *   1. Every destructive statement is filtered by `.eq('org_id', orgId)`.
 *      There is no unqualified DELETE in this file.
 *   2. `orgId` is only ever the id of an org whose `is_demo` column is
 *      literally true, re-verified immediately before the wipe (assertDemoOrg
 *      below). A slug collision, a stale env var, or a copy-pasted id can
 *      therefore not point the wipe at a real tenant.
 *   3. The org row itself is never deleted — only its contents — so the
 *      demo PM's membership and auth user survive a reset and the magic-link
 *      entry route keeps working between booth conversations.
 *
 * Supabase's JS client has no multi-statement transaction, so this is not
 * atomic. It is instead ordered and idempotent: the wipe runs child-to-parent
 * so a failure leaves no dangling FK, and re-running from any point converges
 * on the same state. A half-finished reset is recoverable by hitting reset
 * again — which is the property that actually matters at a trade show.
 */

// Deleted child-first, each filtered by `.eq('org_id', orgId)`.
//
// Typed as OrgScopedTable, not `string`: a bare `string` widens
// supabase.from() across every table in the schema, postgrest-js intersects
// their columns, and every argument downstream resolves to `never`. The
// narrower type also proves each entry really has an org_id column to filter
// on — a claim this list previously made only in a comment.
const WIPE_ORDER: readonly OrgScopedTable[] = [
  'demo_activity_log',
  'owner_transactions',
  'asset_depreciation_entries',
  'work_order_updates',
  'work_order_line_items',
  'work_orders',
  'checklist_instances',
  'turnover_assignments',
  'assignment_outcomes',
  'turnovers',
  'stay_extension_requests',
  'guidebook_offer_redemptions',
  'guidebook_guest_sms_optins',
  'reservation_messages',
  'bookings',
  'maintenance_schedules',
  'property_assets',
  'inventory_counts',
  'inventory_items',
  'inventory_templates',
  'purchase_orders',
  'review_responses',
  'reviews',
  'vendor_compliance_documents',
  'vendors',
  'crew_availability',
  'crew_members',
  'guidebook_property_configs',
  'guidebook_sponsors',
  'guidebook_configurations',
  'property_owners',
  'checklist_templates',
  'notifications',
  'properties',
]

// Reached only through a parent FK. `Exclude<DemoTable, OrgScopedTable>` is
// the compiler checking the claim this comment used to assert by hand: these
// tables have NO org_id column, so a `.eq('org_id', ...)` delete against them
// would error. They are removed by cascade from the parent rows WIPE_ORDER
// deletes above.
//
// Exported because it is a schema fact this seeder's safety model depends on,
// not merely a local note: if one of these ever gains an org_id column, the
// `Exclude` stops matching and this list fails to compile — which is the
// signal to give it an explicit filtered delete in WIPE_ORDER instead of
// trusting the cascade.
export const CASCADE_ONLY: readonly Exclude<DemoTable, OrgScopedTable>[] = [
  'work_order_photos',
  'checklist_instance_items',
  'inventory_template_items',
  'purchase_order_items',
  'checklist_template_items',
  'checklist_template_sections',
]

export interface SeedOptions {
  /** Delete all existing demo-org content before inserting. */
  wipeFirst?: boolean
}

export interface SeedResult {
  orgId:  string
  counts: Record<string, number>
}

type ServiceClient = ReturnType<typeof createServiceClient>

/** ISO date (YYYY-MM-DD) `days` from today. Negative = past. */
function dayOffset(days: number): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/**
 * Re-reads is_demo straight from the database and refuses to continue unless
 * it is true. This is the single check standing between a reset request and
 * a production tenant — it deliberately does not trust any value passed in.
 */
async function assertDemoOrg(supabase: ServiceClient, orgId: string): Promise<void> {
  const { data, error } = await supabase
    .from('organizations')
    .select('id, is_demo, slug')
    .eq('id', orgId)
    .maybeSingle()

  if (error) throw new Error(`Could not verify demo org: ${error.message}`)
  if (!data)  throw new Error(`Org ${orgId} does not exist — refusing to wipe.`)
  if (data.is_demo !== true) {
    throw new Error(
      `REFUSING TO WIPE: org ${orgId} (${data.slug}) has is_demo = ${String(data.is_demo)}. ` +
      `The demo seeder only ever operates on an org explicitly flagged is_demo = true.`
    )
  }
}

async function wipeDemoOrg(supabase: ServiceClient, orgId: string): Promise<void> {
  await assertDemoOrg(supabase, orgId)

  for (const table of WIPE_ORDER) {
    // Sequential by necessity: the deletes are ordered child-to-parent, so
    // parallelizing them would violate FK ordering.
    const { error } = await supabase.from(table).delete().eq('org_id', orgId)

    // A table that doesn't exist yet (migration not applied to this project)
    // must not abort the whole reset — the rest of the wipe is still correct.
    if (error && !/does not exist/i.test(error.message)) {
      throw new Error(`Wipe failed on ${table}: ${error.message}`)
    }
  }
}

/**
 * Up to 2 items per category from the org's catalog — enough for a realistic
 * per-property list (~14-18 items across the catalog's 11 categories)
 * without hardcoding specific item names that could drift from the platform
 * catalog's actual contents.
 */
export function pickDemoInventorySelection<T extends { category: string }>(items: T[]): T[] {
  const perCategory = new Map<string, T[]>()
  for (const item of items) {
    const bucket = perCategory.get(item.category) ?? []
    if (bucket.length < 2) {
      bucket.push(item)
      perCategory.set(item.category, bucket)
    }
  }
  return [...perCategory.values()].flat()
}

/** Insert helper that surfaces the failing table instead of a bare PostgREST error. */
async function insertRows<T extends DemoTable>(
  supabase: ServiceClient,
  table:    T,
  rows:     TablesInsert<T>[],
): Promise<Array<{ id: string }>> {
  if (rows.length === 0) return []

  // postgrest-js resolves .insert()'s payload type from a LITERAL table name
  // and cannot do it through a generic parameter: `.from(table)` here is a
  // union of all 94 table builders, so their payload types intersect to
  // `never`. The schema check that matters is NOT lost — it moved to the call
  // sites, each of which passes TablesInsert<'that_table'>[] and is checked
  // against the real Insert type of the table it names. This one assertion
  // only carries already-checked rows across the generic boundary.
  const request = supabase.from(table).insert(rows as never).select('id') as unknown as
    PromiseLike<{ data: Array<{ id: string }> | null; error: { message: string } | null }>

  const { data, error } = await request
  if (error) throw new Error(`Seed insert failed on ${table}: ${error.message}`)
  return data ?? []
}

/**
 * Resolves the demo org, creating it if absent. Creation sets is_demo = true
 * in the same INSERT so the row can never briefly exist as a normal org.
 */
async function ensureDemoOrg(supabase: ServiceClient): Promise<string> {
  const { data: existing, error: readErr } = await supabase
    .from('organizations')
    .select('id, is_demo')
    .eq('slug', DEMO_ORG_SLUG)
    .maybeSingle()

  if (readErr) throw new Error(`Could not read demo org: ${readErr.message}`)

  if (existing) {
    if (existing.is_demo !== true) {
      throw new Error(
        `Org with slug "${DEMO_ORG_SLUG}" exists but is_demo = false. ` +
        `Refusing to adopt a non-demo org as the demo tenant.`
      )
    }
    return existing.id
  }

  const { data: created, error: insErr } = await supabase
    .from('organizations')
    .insert({
      name:           DEMO_ORG_NAME,
      slug:           DEMO_ORG_SLUG,
      is_demo:        true,
      // Portfolio plan, active — the demo should never hit a plan gate or a
      // trial-expired banner mid-pitch.
      plan:           'portfolio',
      plan_status:    'active',
      max_properties: 100,
      auto_assign_mode: 'suggest',
    })
    .select('id')
    .single()

  if (insErr || !created) throw new Error(`Could not create demo org: ${insErr?.message}`)
  return created.id
}

export async function seedDemoOrg(opts: SeedOptions = {}): Promise<SeedResult> {
  const supabase = createServiceClient({ system: 'lib/demo/seed' })
  const orgId    = await ensureDemoOrg(supabase)

  if (opts.wipeFirst) await wipeDemoOrg(supabase, orgId)

  // Re-assert after the wipe too: everything below writes, and the same
  // guarantee should hold for inserts as for deletes.
  await assertDemoOrg(supabase, orgId)

  const counts: Record<string, number> = {}

  // ── Properties ───────────────────────────────────────────────────────────
  const propertyRows = DEMO_PROPERTIES.map((p) => ({
    org_id:           orgId,
    name:             p.name,
    address:          p.address,
    city:             p.city,
    state:            p.state,
    zip:              p.zip,
    property_type:    p.property_type,
    bedrooms:         p.bedrooms,
    bathrooms:        p.bathrooms,
    max_guests:       p.max_guests,
    square_footage:   p.square_footage,
    avg_nightly_rate: p.avg_nightly_rate,
    cleaning_cost:    p.cleaning_cost,
    lat:              p.lat,
    lng:              p.lng,
    timezone:         'America/Chicago',
    is_active:        true,
  }))
  const properties = await insertRows(supabase, 'properties', propertyRows)
  counts.properties = properties.length

  // Positional map from seed key → inserted id. insertRows preserves input
  // order (PostgREST returns rows in insertion order for a multi-row INSERT),
  // which is what lets every downstream entity reference a property by key.
  const propertyIdByKey = new Map<string, string>()
  DEMO_PROPERTIES.forEach((p, i) => {
    const row = properties[i]
    if (row) propertyIdByKey.set(p.key, row.id)
  })

  // ── Checklist templates ──────────────────────────────────────────────────
  // Every property needs a real default checklist_templates row before a
  // turnover can carry an actual checklist — snapshotChecklist() in
  // lib/turnovers/generator.ts silently no-ops without one
  // (`if (!templateId) return`), which otherwise leaves every generated
  // turnover with zero checklist items. Seeded once per org
  // (seedDefaultRoomTemplatesIfNeeded + fetchOrgRoomTemplateData), then
  // applied per property — same batch shape as
  // lib/inngest/functions/apply-master-checklist.ts.
  await seedDefaultRoomTemplatesIfNeeded(orgId)
  const orgRoomData = await fetchOrgRoomTemplateData(orgId, supabase)
  for (const property of properties) {
    await applyMasterChecklistToProperty(property.id, orgId, supabase, {
      force:    true,
      orgRoomData,
      skipSeed: true,
    })
  }

  // applyMasterChecklistToProperty() is a defensive no-op (returns void,
  // logs and bails) when composeSections() produces zero sections for a
  // property — don't just trust the loop ran; verify every property actually
  // ended up with a default template, or a "successful" reset silently
  // leaves some properties generating checklist-less turnovers.
  const { data: appliedTemplates, error: appliedTemplatesError } = await supabase
    .from('checklist_templates')
    .select('property_id')
    .eq('org_id', orgId)
    .eq('is_default', true)
    .in('property_id', properties.map((p) => p.id))
    .limit(properties.length)

  if (appliedTemplatesError) {
    throw new Error(`Failed to verify seeded checklist templates: ${appliedTemplatesError.message}`)
  }
  if ((appliedTemplates ?? []).length < properties.length) {
    const covered = new Set((appliedTemplates ?? []).map((t) => t.property_id))
    const missing = properties.filter((p) => !covered.has(p.id)).map((p) => p.id)
    throw new Error(
      `Checklist template seeding incomplete — missing default templates for ${missing.length} ` +
      `of ${properties.length} properties: ${missing.join(', ')}`
    )
  }
  counts.checklist_templates = appliedTemplates!.length

  // ── Inventory ────────────────────────────────────────────────────────────
  // Every property gets a realistic, deliberately-mixed stock count: most
  // items comfortably at or above par, the first two per property below par
  // so the crew inventory-count screen and the low-stock/restock-cart
  // automation have something real to show instead of an all-green board.
  await seedOrgInventoryCatalogIfNeeded(orgId)
  const { data: orgCatalogItems, error: orgCatalogError } = await supabase
    .from('org_inventory_catalog')
    // inventory_items.catalog_item_id references the GLOBAL inventory_catalog,
    // not org_inventory_catalog — platform_catalog_item_id is the column that
    // points back to it (see CLAUDE.md's "do not mix" inventory-table pair).
    .select('platform_catalog_item_id, name, category, default_unit, default_par_level')
    .eq('org_id', orgId)
    .eq('is_active', true)
    .order('category')
    .order('name')
  if (orgCatalogError) {
    throw new Error(`Failed to fetch demo inventory catalog: ${orgCatalogError.message}`)
  }
  const demoInventoryItems = pickDemoInventorySelection(orgCatalogItems ?? [])

  const inventoryRows = properties.flatMap((property, pi) =>
    demoInventoryItems.map((item, ii) => {
      const belowPar = ii < 2
      const currentQuantity = belowPar
        ? Math.max(0, Math.floor(item.default_par_level * 0.35))
        : Math.round(item.default_par_level * (1 + ((pi + ii) % 3) * 0.1))
      return {
        org_id:                  orgId,
        property_id:             property.id,
        catalog_item_id:         item.platform_catalog_item_id,
        name:                    item.name,
        category:                item.category,
        unit:                    item.default_unit,
        par_level:               item.default_par_level,
        current_quantity:        currentQuantity,
        low_stock_threshold_pct: 30,
        is_active:               true,
      }
    })
  )
  counts.inventory_items = (await insertRows(supabase, 'inventory_items', inventoryRows)).length

  // ── Property owners ──────────────────────────────────────────────────────
  const ownerRows = DEMO_PROPERTIES.map((p, i) => {
    const contact = demoOwnerContact(i)
    return {
      org_id:             orgId,
      property_id:        propertyIdByKey.get(p.key)!,
      name:               DEMO_GUEST_NAMES[i % DEMO_GUEST_NAMES.length],
      email:              contact.email,
      phone:              contact.phone,
      revenue_share_pct:  80,
      share_capital_plan: p.flagship,
    }
  })
  counts.property_owners = (await insertRows(supabase, 'property_owners', ownerRows)).length

  // ── Crew ─────────────────────────────────────────────────────────────────
  const crewRows: TablesInsert<'crew_members'>[] = DEMO_CREW.map((c) => ({
    org_id:            orgId,
    name:              c.name,
    email:             c.email,
    phone:             c.phone,
    role:              c.role,
    home_zip:          c.home_zip,
    home_lat:          c.home_lat,
    home_lng:          c.home_lng,
    reliability_score: c.reliability_score,
    capacity_score:    c.capacity_score,
    preferred_contact: 'both',
    is_active:         true,
    // Crew are treated as onboarded — requireCrewMember() deliberately does
    // NOT filter on invite_accepted_at (see CLAUDE.md), but the PM-side crew
    // list reads better with a real acceptance date than a pending invite.
    invite_accepted_at: new Date().toISOString(),
  }))
  const crew = await insertRows(supabase, 'crew_members', crewRows)
  counts.crew_members = crew.length

  // Availability for the next 21 days so the assignment suggester has a real
  // roster to choose from. Built as one flat array, inserted once — a
  // per-crew or per-day insert here would be the classic N+1.
  const availabilityRows = DEMO_CREW.flatMap((c, ci) =>
    Array.from({ length: 21 }, (_, d) => ({
      org_id:         orgId,
      crew_member_id: crew[ci]?.id,
      available_date: dayOffset(d),
      // Tasha takes Sundays off; everyone else is open. Gives the suggester
      // a genuine constraint rather than a uniform roster.
      is_available:   !(c.key === 'tasha' && new Date(dayOffset(d)).getUTCDay() === 0),
    })).filter((r) => r.crew_member_id)
  )
  counts.crew_availability = (await insertRows(supabase, 'crew_availability', availabilityRows)).length

  // ── Vendors + compliance ─────────────────────────────────────────────────
  const vendorRows = DEMO_VENDORS.map((v) => ({
    org_id:               orgId,
    name:                 v.name,
    contact_name:         v.contact_name,
    email:                v.email,
    phone:                v.phone,
    specialty:            v.specialty,
    city:                 v.city,
    state:                v.state,
    service_zip:          v.service_zip,
    service_radius_miles: 30,
    lat:                  v.lat,
    lng:                  v.lng,
    avg_rating:           v.avg_rating,
    rating_count:         v.rating_count,
    portal_enabled:       true,
    is_active:            true,
  }))
  const vendors = await insertRows(supabase, 'vendors', vendorRows)
  counts.vendors = vendors.length

  // Every COI current and comfortably in the future — a hard-block mid-demo
  // would be a correct feature demonstration and a terrible sales moment.
  const complianceRows: TablesInsert<'vendor_compliance_documents'>[] = vendors.map((v, i) => ({
    org_id:          orgId,
    vendor_id:       v.id,
    document_type:   'coi',
    document_name:   `${DEMO_VENDORS[i]?.name} — Certificate of Insurance`,
    policy_number:   `COI-DEMO-${String(1000 + i)}`,
    issuer_name:     'Gulf Mutual Surety (Demo)',
    effective_date:  dayOffset(-200),
    expiry_date:     dayOffset(165),
    coverage_amount: 1_000_000,
    is_verified:     true,
    is_active:       true,
  }))
  counts.vendor_compliance_documents =
    (await insertRows(supabase, 'vendor_compliance_documents', complianceRows)).length

  // ── Assets ───────────────────────────────────────────────────────────────
  const assetRows = DEMO_ASSETS.flatMap((a) => {
    const propertyId = propertyIdByKey.get(a.propertyKey)
    if (!propertyId) return []
    const installed = dayOffset(-Math.round(a.installed_years_ago * 365))
    return [{
      org_id:                     orgId,
      property_id:                propertyId,
      name:                       a.name,
      asset_type:                 a.asset_type,
      make:                       a.make,
      model:                      a.model,
      installation_date:          installed,
      placed_in_service_date:     installed,
      purchase_price:             a.purchase_price,
      estimated_replacement_cost: a.estimated_replacement_cost,
      expected_lifespan_years:    a.expected_lifespan_years,
      macrs_class:                a.macrs_class,
      is_active:                  true,
    }]
  })
  counts.property_assets = (await insertRows(supabase, 'property_assets', assetRows)).length

  // ── Asset-discovery backstop ─────────────────────────────────────────────
  // snapshotChecklist() (lib/turnovers/generator.ts) injects a permanent,
  // non_deletable checklist item for any REQUIRED_ASSET_TYPES not yet
  // "verified" (make/model/photo_url set, or is_na) on a property — and once
  // created, that row can NEVER be deleted:
  // prevent_non_deletable_checklist_mutation() (20260628195657_non_deletable_
  // enforcement_inventory_order_aggregation.sql) blocks it unconditionally,
  // "regardless of the calling role," which also blocks the CASCADE delete a
  // demo reset relies on (turnovers → checklist_instances →
  // checklist_instance_items). A demo org that ever generates one of these
  // can never be wiped again. DEMO_ASSETS is a deliberately curated, realistic
  // subset per property — not every property covers all 26 required types —
  // so anything it left uncovered gets an explicit "verified, not
  // applicable" row here instead, exactly like a crew member marking N/A on
  // an asset that genuinely doesn't exist at that property.
  const naAssetRows = properties.flatMap((property) => {
    const covered = new Set(
      assetRows.filter((a) => a.property_id === property.id).map((a) => a.asset_type)
    )
    return REQUIRED_ASSET_TYPES.filter((assetType) => !covered.has(assetType)).map((assetType) => ({
      org_id:      orgId,
      property_id: property.id,
      name:        `${ASSET_TYPE_DISPLAY_NAMES[assetType] ?? assetType} (N/A)`,
      asset_type:  assetType,
      is_na:       true,
      is_active:   true,
    }))
  })
  counts.property_assets += (await insertRows(supabase, 'property_assets', naAssetRows)).length

  // ── Bookings ─────────────────────────────────────────────────────────────
  // Spread past / current / future, and — critically — the first flagship
  // property checks out TOMORROW so a live turnover can fire naturally during
  // the demo without anyone fabricating a date.
  const bookingRows = buildBookingRows(orgId, propertyIdByKey)
  counts.bookings = (await insertRows(supabase, 'bookings', bookingRows)).length

  // ── Turnovers + checklists ───────────────────────────────────────────────
  // Generated through the same code path production uses
  // (generateTurnoversForProperty, which snapshots a real checklist per
  // turnover now that every property has a default checklist_templates row
  // above) — raw-inserted bookings never fire the booking-created event
  // pipeline that would otherwise trigger this, so without this step the
  // demo org would have zero turnovers and zero checklist instances right
  // after a reset: nothing for the crew PWA to sync before airplane mode,
  // and nothing to click into on the web dashboard either.
  let turnoversGenerated = 0
  for (const property of properties) {
    const newIds = await generateTurnoversForProperty(property.id, orgId, supabase)
    turnoversGenerated += newIds.length
  }
  counts.turnovers = turnoversGenerated

  // Every new turnover starts 'pending_assignment' regardless of how far in
  // the past its checkout is (see insertStandaloneTurnover/insertPairTurnover
  // in lib/turnovers/generator.ts) — without this, the "recent past" booking
  // cluster seeded above for owner-report realism would surface as a
  // month-old backlog of unassigned turnovers, which is a worse look than no
  // history at all. Only turnovers whose checkout has already passed are
  // touched; the current/future ones stay pending, which is exactly the
  // state the live "watch a turnover generate" and crew-offline demo
  // moments need.
  const { error: completePastError } = await supabase
    .from('turnovers')
    .update({ status: 'completed', completed_at: new Date().toISOString() })
    .eq('org_id', orgId)
    .lt('checkout_datetime', new Date().toISOString())
  if (completePastError) {
    console.error('[seedDemoOrg] failed to mark past turnovers completed:', completePastError.message)
  }

  // ── Guidebook ────────────────────────────────────────────────────────────
  await insertRows(supabase, 'guidebook_configurations', [{
    org_id:                       orgId,
    is_active:                    true,
    extension_messaging_enabled:  true,
    extension_gap_threshold_days: 2,
    extension_discount_pct:       15,
  }])
  counts.guidebook_configurations = 1

  const flagships = DEMO_PROPERTIES.filter((p) => p.flagship)
  const guidebookConfigRows = flagships.map((p) => ({
    org_id:                  orgId,
    property_id:             propertyIdByKey.get(p.key)!,
    slug:                    `${p.key}-demo`,
    check_in_instructions:   `Check-in is any time after 3:00 PM. Your door code is in your arrival text — punch it in, press the Schlage button, and the deadbolt releases. Parking is the two marked spots directly under the unit; the third spot belongs to the neighbor.`,
    check_out_instructions:  `Checkout is 11:00 AM. Start the dishwasher, bag any trash and drop it in the bin at the end of the driveway, and leave towels in the tub. Leave the AC at 74 — please don't shut it off, the humidity here is unforgiving.`,
    wifi_network:            `${p.name.split(' ')[0]}Guest`,
    wifi_password:           'saltandsun2026', // NOSONAR -- fake guest-facing wifi password for a fictional demo property, not a real credential
    house_rules:             `No smoking anywhere on the property, including the deck. Quiet hours 10 PM–8 AM. Maximum ${p.max_guests} guests — this is a firm limit from the HOA, not a suggestion. No parties or events. Pets are not permitted at this property.`,
    is_published:            true,
  }))
  counts.guidebook_property_configs =
    (await insertRows(supabase, 'guidebook_property_configs', guidebookConfigRows)).length

  const sponsorRows = DEMO_SPONSORS.map((s) => ({
    org_id:               orgId,
    slot_number:          s.slot_number,
    business_name:        s.business_name,
    business_description: s.business_description,
    business_phone:       s.business_phone,
    business_website:     s.business_website,
    address:              s.address,
    lat:                  s.lat,
    lng:                  s.lng,
    slot_type:            s.slot_type,
    offer_type:           s.offer_type,
    offer_value:          s.offer_value,
    offer_item:           s.offer_item,
    custom_offer_text:    s.custom_offer_text,
    featured_item:        s.featured_item,
    status:               'active',
    activated_at:         new Date().toISOString(),
  }))
  counts.guidebook_sponsors = (await insertRows(supabase, 'guidebook_sponsors', sponsorRows)).length

  return { orgId, counts }
}

/**
 * Booking spread. Extracted from seedDemoOrg to keep that function under the
 * cognitive-complexity ceiling — this is three independent date regimes that
 * happen to produce rows for the same table.
 */
function buildBookingRows(
  orgId:            string,
  propertyIdByKey:  Map<string, string>,
): TablesInsert<'bookings'>[] {
  const rows: TablesInsert<'bookings'>[] = []
  const sources = ['airbnb', 'vrbo', 'direct', 'ownerrez'] as const
  let guestIndex = 0

  const nextGuest = () => {
    const name = DEMO_GUEST_NAMES[guestIndex % DEMO_GUEST_NAMES.length]
    const email = `${name.split(' ')[0]?.toLowerCase()}.${guestIndex}@example.com`
    guestIndex += 1
    return { name, email }
  }

  const push = (key: string, checkin: number, checkout: number, sourceIdx: number) => {
    const propertyId = propertyIdByKey.get(key)
    if (!propertyId) return
    const guest = nextGuest()
    rows.push({
      org_id:        orgId,
      property_id:   propertyId,
      guest_name:    guest.name,
      guest_email:   guest.email,
      checkin_date:  dayOffset(checkin),
      checkout_date: dayOffset(checkout),
      source:        sources[sourceIdx % sources.length],
      status:        'confirmed',
    })
  }

  // THE demo booking: flagship property, checks out tomorrow. This is what
  // makes "watch a turnover generate and get an assignment suggestion" a live
  // flow rather than a screenshot.
  push('sandpiper', -3, 1, 3)

  // A same-day turnover on the second flagship — checkout and checkin both
  // tomorrow, which is what exercises is_same_day_turnover and the same-day
  // cleaning premium.
  push('pelican', -4, 1, 0)
  push('pelican',  1, 5, 1)

  // Currently in-house
  push('dunes',    -2, 4, 1)
  push('seaoats',  -1, 6, 2)
  push('tideline', -2, 3, 0)

  // Recent past — gives owner reports and P&L something to report on
  push('sandpiper', -18, -12, 0)
  push('pelican',   -22, -16, 1)
  push('dunes',     -30, -24, 2)
  push('heron',     -14, -9,  3)
  push('mariner',   -25, -20, 0)
  push('lagoon',    -11, -7,  1)
  push('starfish',  -9,  -5,  2)

  // Forward book — enough that the calendar looks like a real business
  push('sandpiper', 6,  11, 1)
  push('dunes',     8,  14, 3)
  push('heron',     4,  9,  0)
  push('tideline',  7,  12, 2)
  push('seaoats',   10, 17, 1)
  push('mariner',   5,  9,  3)
  push('starfish',  12, 15, 0)

  return rows
}
