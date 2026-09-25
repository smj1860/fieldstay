import { requireOrgMember } from '@/lib/auth'
import { SUPABASE_MAX_ROWS, fetchAllRows } from '@/lib/inngest/paginate'
import { reportError } from '@/lib/observability/report-error'
import { MaintenanceBoard } from './maintenance-board'
import { MaintenanceTabs } from './maintenance-tabs'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import type {
  InspectionFormOption, OrgMemberOption, VendorComplianceRow,
} from './maintenance-board'
import type { Metadata } from 'next'
import { isThumbtackConfigured } from '@/lib/integrations/thumbtack'
import { CategoryPickerFindProSection } from '@/components/thumbtack/CategoryPickerFindProSection'

export const metadata: Metadata = { title: 'Maintenance' }

const WO_CATEGORY_OPTIONS = [
  { value: 'hvac' as const,          label: 'HVAC' },
  { value: 'plumbing' as const,      label: 'Plumbing' },
  { value: 'electrical' as const,    label: 'Electrical' },
  { value: 'appliance' as const,     label: 'Appliance' },
  { value: 'roofing' as const,       label: 'Roofing' },
  { value: 'flooring' as const,      label: 'Flooring' },
  { value: 'windows_doors' as const, label: 'Windows & Doors' },
  { value: 'pest_control' as const,  label: 'Pest Control' },
  { value: 'pool' as const,          label: 'Pool' },
  { value: 'structural' as const,    label: 'Structural' },
  { value: 'general' as const,       label: 'General' },
]

/**
 * Ceiling per drained read on this board. Deliberately snug: blowing it throws
 * a labelled error rather than paging on forever inside a Server Component
 * render. Sized for a 350-property portfolio (see drainBoard's callers), not
 * for the 50-property target the previous fixed `.limit()`s were written to.
 */
const MAX_BOARD_ROWS = 20_000

/**
 * Three reads on this board were bounded with a fixed `.limit()` sized for the
 * 50-property target this product was originally sold to. Every one of those
 * ceilings is BELOW what a large portfolio actually holds:
 *
 *   maintenance_schedules  ~18 active per property -> ~6,000 at 334 properties, cap was 2,000
 *   property_assets        ~9 live avg per property (21 if fully catalogued)
 *                          -> ~3,000-7,000 at 334 properties, cap was 3,000
 *   work_orders            every OPEN work order the org has, cap was 2,000
 *
 * A `.limit()` that is hit returns a short set with a 200 and no signal, so the
 * board silently drops scheduled maintenance, assets and open work orders off
 * the page — the exact failure mode PostgREST's max_rows produces, just
 * self-inflicted at a different number. Draining instead means the read is
 * complete at any portfolio size, and MAX_BOARD_ROWS turns "too big" into a
 * loud labelled throw rather than a quiet omission.
 *
 * `.order('id')` last on every drained read is load-bearing, not presentation:
 * `.range()` is OFFSET pagination, so the ordering must be TOTAL or two pages
 * answer different questions. next_due_date, created_at and name are all
 * non-unique across a portfolio (a whole org shares one due date after a bulk
 * template apply), and Postgres may break those ties differently in two
 * separately-planned queries — returning some rows twice and others never. See
 * the same reasoning on turnovers/page.tsx and the "MUST apply a stable
 * .order(...)" note in lib/inngest/paginate.ts.
 *
 * The bound stays at the CALL SITE rather than inside this helper: the semgrep
 * unbounded-select ladder decides a read is bounded by finding `.range()` /
 * `.limit()` in the same expression, and one moved a function call away is
 * invisible to it.
 */
function drainBoard<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  return fetchAllRows<T>(page, { label: `page.maintenance.${label}`, maxRows: MAX_BOARD_ROWS })
}

export default async function MaintenancePage() {
  const { supabase, membership, user } = await requireOrgMember()

  let workOrders, schedules, propertyAssets
  let propertiesResult, vendorsResult, crewMembersResult,
      vendorComplianceResult, inspectionFormsResult, orgMembersResult
  try {
    ;[
    workOrders,
    propertiesResult,
    vendorsResult,
    schedules,
    crewMembersResult,
    propertyAssets,
    vendorComplianceResult,
    inspectionFormsResult,
    orgMembersResult,
  ] = await Promise.all([
    drainBoard('work_orders', (from, to) => supabase
      .from('work_orders')
      .select(`
        id, property_id, vendor_id, assigned_crew_member_id,
        wo_number, title, description, category, priority, status, source,
        scheduled_date, completed_date,
        estimated_cost, nte_amount, actual_cost,
        access_notes, completion_notes, completed_by_name, invoice_reference,
        portal_enabled, completion_token,
        vendor_acknowledged_at, vendor_acknowledged_by,
        completion_verified_at, completion_verified_by,
        vendor_dispatch_email,
        suggested_vendor_ids, suggested_crew_member_ids, suggestion_reasoning, suggestion_status,
        created_at, updated_at,
        properties ( name, address, city, state, access_instructions ),
        vendors ( id, name, specialty, phone ),
        work_order_line_items (
          id, line_type, description, quantity, unit,
          unit_cost, line_total, sort_order, created_at
        )
      `)
      .eq('org_id', membership.org_id)
      .in('status', ['pending', 'quote_requested', 'assigned', 'in_progress'])
      .order('created_at', { ascending: false })
      // created_at is not unique — a bulk import or a cron that opens one WO
      // per due schedule writes a whole batch inside the same millisecond — so
      // `id` last is what makes this ordering total enough to page over.
      .order('id', { ascending: true })
      // The embedded line items were never ordered at all here, so the board's
      // work-order detail showed them in an order Postgres chose — and could
      // choose differently on the next load. Same three keys as the standalone
      // detail page (/maintenance/[id]) so the two agree.
      .order('sort_order', { referencedTable: 'work_order_line_items', ascending: true })
      .order('created_at', { referencedTable: 'work_order_line_items', ascending: true })
      .order('id',         { referencedTable: 'work_order_line_items', ascending: true })
      // The .in() here is on STATUS, so this is NOT bounded by a four-element
      // list — it returns every open work order the org has. Drained rather
      // than `.limit(2000)`: that cap was sized for the 50-property target and
      // a large portfolio carries more open work than that.
      .range(from, to)),

    supabase
      .from('properties')
      .select('id, name, city, state, lat, lng')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),

    supabase
      .from('vendors')
      .select('id, name, specialty, lat, lng, email')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name')
      // One row per vendor in this org — tens in practice.
      .limit(1000),

    drainBoard('maintenance_schedules', (from, to) => supabase
      .from('maintenance_schedules')
      .select(`
        id, property_id, org_id, name, description,
        schedule_type, frequency, next_due_date,
        last_completed_date, estimated_cost, auto_create_wo, is_active,
        assigned_vendor_id, instructions,
        creates, inspection_form_id, assigned_to_user_id,
        properties ( name ),
        vendors ( id, name )
      `)
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('next_due_date', { ascending: true, nullsFirst: false })
      // next_due_date is very much not unique — applying a template across a
      // portfolio gives every property the same due date — so `id` last is
      // what makes this ordering total enough to page over.
      .order('id', { ascending: true })
      // NOT hygiene, despite the org scope: live data shows ~18 active
      // schedules per property, so a portfolio at the 50-property target sits
      // near 900 and crosses max_rows at roughly 56 properties. At 334
      // properties it is ~6,000 rows, which the previous `.limit(2000)` cut
      // by two thirds — silently, with a 200 and no signal, dropping most of
      // the org's scheduled maintenance off the page. Drained instead, so the
      // read is complete at any portfolio size.
      .range(from, to)),

    supabase
      .from('crew_members')
      .select('id, name, role')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),

    drainBoard('property_assets', (from, to) => supabase
      .from('property_assets')
      .select('id, name, asset_type, property_id')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name')
      // Asset names repeat constantly across a portfolio ("Water Heater" on
      // every property), so `id` last is what makes this ordering total
      // enough to page over.
      .order('id', { ascending: true })
      // NOT hygiene, despite the org scope: asset_type_standards carries 21
      // types, so a fully catalogued 50-property portfolio reaches ~1050 —
      // past max_rows. Live orgs average 9 per property today, which puts a
      // 334-property portfolio at ~3,000 on the live average and ~7,000 fully
      // catalogued — either side of the previous `.limit(3000)`, i.e. a cap
      // that truncates exactly when the portfolio is large enough to need it.
      // Drained instead of guessing a bigger number.
      .range(from, to)),

    // Bounded rather than left to PostgREST's silent max_rows truncation.
    // One row per vendor in this org, so 1000 is far above the target user's
    // book — but an unbounded read that happens to be small is still an
    // unbounded read, and this one decorates a picker that DISABLES blocked
    // vendors: a truncated map renders a blocked vendor as selectable. The
    // server gate (isVendorHardBlocked) still refuses it, so the failure mode
    // is a confusing refusal rather than an uninsured dispatch — but saying
    // the bound out loud is what keeps that true.
    supabase
      .from('vendor_compliance_status')
      .select('vendor_id, compliance_status, org_onboarding_grace')
      .eq('org_id', membership.org_id)
      .limit(SUPABASE_MAX_ROWS),

    // §7's two pickers. Platform-owned and tiny — three forms today — but
    // bounded anyway, because an unbounded read that happens to be small is
    // still an unbounded read.
    supabase
      .from('inspection_forms')
      .select('id, name, version')
      .eq('is_active', true)
      .order('name')
      .limit(50),

    // Who can be named as the person expected to walk it. `invite_accepted_at`
    // is the PM-side membership rule: a pending invite is not yet someone you
    // can assign work to.
    supabase
      .from('organization_members')
      .select('user_id, profiles ( full_name, email )')
      .eq('org_id', membership.org_id)
      .not('invite_accepted_at', 'is', null)
      .limit(500),
    ])
  } catch (err) {
    // fetchAllRows throws a plain Error with no Sentry context (a failed page,
    // or a read past MAX_BOARD_ROWS). Report once with the call site, then
    // rethrow so the segment's error.tsx renders a real error state — an
    // outage must never look like an empty board.
    reportError(err, { site: 'page.maintenance', orgId: membership.org_id })
    throw err
  }

  // A query erroring (bad filter value, RLS misconfiguration, etc.) and a
  // query legitimately returning zero rows both leave `data` empty — `?? []`
  // below can't tell them apart, so without this the board just silently
  // renders as if nothing exists instead of surfacing a real outage.
  //
  // The three drained reads are absent from this list because they cannot
  // reach it in a failed state: fetchAllRows throws on a failed page rather
  // than returning { data, error }, and the try/catch above turns that into
  // the segment's error boundary.
  const results = [
    ['properties', propertiesResult], ['vendors', vendorsResult],
    ['crew_members', crewMembersResult],
    ['vendor_compliance_status', vendorComplianceResult],
    ['inspection_forms', inspectionFormsResult], ['organization_members', orgMembersResult],
  ] as const
  for (const [name, result] of results) {
    if (result.error) console.error(`[MaintenancePage] ${name} query failed:`, result.error)
  }

  // vendor_compliance_status is a VIEW, so Postgres reports every column as
  // nullable regardless of the underlying tables. A row missing either field
  // can't be matched to a vendor, so drop it here rather than widen the
  // board's prop type to a shape it would only have to re-check.
  const vendorCompliance = (vendorComplianceResult.data ?? []).filter(
    (r): r is VendorComplianceRow => r.vendor_id !== null && r.compliance_status !== null
  )

  // A member with neither a name nor an email cannot be shown in a picker, so
  // it is dropped rather than rendered as a blank option somebody might select.
  const orgMembers: OrgMemberOption[] = (orgMembersResult.data ?? []).flatMap((m) => {
    const profile = unwrapJoin(m.profiles as unknown as { full_name: string | null; email: string | null } | null)
    const name = profile?.full_name?.trim() || profile?.email?.trim()
    return name && m.user_id ? [{ user_id: m.user_id, name }] : []
  })

  return (
    <>
      <MaintenanceTabs />
      {isThumbtackConfigured() && (
        <div className="mb-6">
          <CategoryPickerFindProSection
            heading="Have an open job with no vendor assigned? Find one on Thumbtack"
            categoryFieldLabel="Category"
            categoryOptions={WO_CATEGORY_OPTIONS}
          />
        </div>
      )}
      <MaintenanceBoard
        workOrders={workOrders ?? []}
        properties={propertiesResult.data ?? []}
        vendors={vendorsResult.data ?? []}
        schedules={schedules ?? []}
        crewMembers={crewMembersResult.data ?? []}
        propertyAssets={propertyAssets ?? []}
        vendorCompliance={vendorCompliance}
        inspectionForms={(inspectionFormsResult.data ?? []) as InspectionFormOption[]}
        orgMembers={orgMembers}
        orgId={membership.org_id}
        userId={user.id}
        role={membership.role}
      />
    </>
  )
}
