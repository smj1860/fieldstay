import { requireOrgMember } from '@/lib/auth'
import { SUPABASE_MAX_ROWS } from '@/lib/inngest/paginate'
import { MaintenanceBoard } from './maintenance-board'
import { MaintenanceTabs } from './maintenance-tabs'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import type {
  InspectionFormOption, OrgMemberOption, VendorComplianceRow,
} from './maintenance-board'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Maintenance' }

export default async function MaintenancePage() {
  const { supabase, membership, user } = await requireOrgMember()

  const [
    workOrdersResult,
    propertiesResult,
    vendorsResult,
    schedulesResult,
    crewMembersResult,
    propertyAssetsResult,
    vendorComplianceResult,
    inspectionFormsResult,
    orgMembersResult,
  ] = await Promise.all([
    supabase
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
        suggested_vendor_ids, suggestion_reasoning, suggestion_status,
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
      // The embedded line items were never ordered at all here, so the board's
      // work-order detail showed them in an order Postgres chose — and could
      // choose differently on the next load. Same three keys as the standalone
      // detail page (/maintenance/[id]) so the two agree.
      .order('sort_order', { referencedTable: 'work_order_line_items', ascending: true })
      .order('created_at', { referencedTable: 'work_order_line_items', ascending: true })
      .order('id',         { referencedTable: 'work_order_line_items', ascending: true })
      // The .in() here is on STATUS, so this is NOT bounded by a four-element
      // list — it returns every open work order the org has. A truncated read
      // would drop work orders off the board with no sign they existed.
      .limit(2000),

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

    supabase
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
      // NOT hygiene, despite the org scope: live data shows ~18 active
      // schedules per property, so a portfolio at the 50-property target sits
      // near 900 and crosses max_rows at roughly 56 properties. A truncated
      // read silently drops scheduled maintenance off the page.
      .limit(2000),

    supabase
      .from('crew_members')
      .select('id, name, role')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),

    supabase
      .from('property_assets')
      .select('id, name, asset_type, property_id')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name')
      // NOT hygiene, despite the org scope: asset_type_standards carries 21
      // types, so a fully catalogued 50-property portfolio reaches ~1050 —
      // past max_rows. Live orgs average 9 per property today; the bound is
      // sized for the portfolio this product is sold to.
      .limit(3000),

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

  // A query erroring (bad filter value, RLS misconfiguration, etc.) and a
  // query legitimately returning zero rows both leave `data` empty — `?? []`
  // below can't tell them apart, so without this the board just silently
  // renders as if nothing exists instead of surfacing a real outage.
  const results = [
    ['work_orders', workOrdersResult], ['properties', propertiesResult], ['vendors', vendorsResult],
    ['maintenance_schedules', schedulesResult], ['crew_members', crewMembersResult],
    ['property_assets', propertyAssetsResult], ['vendor_compliance_status', vendorComplianceResult],
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
      <MaintenanceBoard
        workOrders={workOrdersResult.data ?? []}
        properties={propertiesResult.data ?? []}
        vendors={vendorsResult.data ?? []}
        schedules={schedulesResult.data ?? []}
        crewMembers={crewMembersResult.data ?? []}
        propertyAssets={propertyAssetsResult.data ?? []}
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
