import { requireOrgMember }                from '@/lib/auth'
import { notFound }                       from 'next/navigation'
import Link                               from 'next/link'
import { ChevronLeft }                    from 'lucide-react'
import { WorkOrderDetail }                from '@/components/work-orders/work-order-detail'
import type { WorkOrderDetailData }       from '@/components/work-orders/work-order-detail'
import { unwrapJoin }                     from '@/lib/utils/supabase-joins'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'

interface Props { params: Promise<{ id: string }> }

export default async function WorkOrderPage({ params }: Props) {
  const { id } = await params
  const { supabase, membership } = await requireOrgMember()

  const [
    { data: wo, error: woError },
    { data: lineItems, error: lineItemsError },
    { data: photos, error: photosError },
    { data: orgVendors, error: orgVendorsError },
    { data: invoice, error: invoiceError },
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
        vendor_rating, vendor_rating_notes,
        vendor_dispatch_email,
        created_at, updated_at,
        properties ( name, address, city, state, access_instructions ),
        vendors ( id, name, specialty, phone ),
        reported_by_crew:reported_by_crew_member_id ( name )
      `)
      .eq('id', id)
      .eq('org_id', membership.org_id)
      .single(),

    supabase
      .from('work_order_line_items')
      .select('id, work_order_id, line_type, description, quantity, unit, unit_cost, line_total, sort_order, created_at')
      .eq('work_order_id', id)
      .order('sort_order', { ascending: true }),

    supabase
      .from('work_order_photos')
      .select('id, storage_path')
      .eq('work_order_id', id)
      .order('created_at', { ascending: true }),

    supabase
      .from('vendors')
      .select('id, name, email')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),

    supabase
      .from('work_order_invoices')
      .select('id, status')
      .eq('work_order_id', id)
      .eq('org_id', membership.org_id)
      .maybeSingle(),
  ])

  // Logs + reports every failure, then throws so the segment's error.tsx
  // renders a real error state — an outage must not look like empty data.
  throwIfAnyQueryFailed({ site: 'page.maintenance.id', orgId: membership.org_id }, woError, lineItemsError, photosError, orgVendorsError, invoiceError)

  if (!wo) notFound()

  const property        = unwrapJoin(wo.properties)
  const vendor           = unwrapJoin(wo.vendors)
  // The ONE assertion in this file, and it is a supabase-js limitation rather
  // than a schema question: its select-string TYPE parser cannot read the
  // FK-column embed form (`alias:fk_column(name)`), so for
  // work_orders→crew_members — which has three FK columns (the deprecated
  // one, plus assigned_crew_member_id and reported_by_crew_member_id) — it
  // reports a false ambiguity even though the select names the FK column
  // explicitly.
  //
  // PostgREST resolves it. Verified 2026-08-02 against the live project, with
  // controls, and the status codes are the proof because PostgREST raises the
  // ambiguity error BEFORE the grant check:
  //   select=reported_by_crew:reported_by_crew_member_id(name) → 401 (grant)
  //   select=crew_members(name)                                → 300 PGRST201
  //   select=reported_by_crew:no_such_fk_column(name)          → 400 PGRST200
  // Reaching the grant check at all means the embed resolved; the third case
  // confirms the FK-column form is really parsed, not silently ignored.
  const reportedByCrew   = unwrapJoin(
    wo.reported_by_crew as unknown as { name: string } | { name: string }[] | null
  )

  const workOrderData: WorkOrderDetailData = {
    id:                     wo.id,
    wo_number:              wo.wo_number,
    org_id:                 membership.org_id,
    property_id:            wo.property_id,
    title:                  wo.title,
    description:            wo.description,
    category:               wo.category as WorkOrderDetailData['category'],
    priority:               wo.priority,
    status:                 wo.status,
    source:                 wo.source ?? '',
    scheduled_date:         wo.scheduled_date,
    completed_date:         wo.completed_date,
    estimated_cost:         wo.estimated_cost,
    nte_amount:             wo.nte_amount,
    actual_cost:            wo.actual_cost,
    access_notes:           wo.access_notes,
    completion_notes:       wo.completion_notes,
    completed_by_name:      wo.completed_by_name,
    invoice_reference:      wo.invoice_reference,
    invoiceStatus:          invoice?.status as WorkOrderDetailData['invoiceStatus'],
    invoiceId:              invoice?.id ?? null,
    vendor_acknowledged_at: wo.vendor_acknowledged_at,
    completion_verified_at: wo.completion_verified_at,
    vendor_rating:          wo.vendor_rating,
    vendor_rating_notes:    wo.vendor_rating_notes,
    reported_by_crew_name:  reportedByCrew?.name ?? null,
    created_at:             wo.created_at,
    properties: {
      name:                property?.name ?? '',
      address:             property?.address ?? null,
      city:                property?.city   ?? null,
      state:               property?.state  ?? null,
      access_instructions: property?.access_instructions ?? null,
    },
    vendors: vendor ? {
      id:        vendor.id,
      name:      vendor.name,
      specialty: vendor.specialty as WorkOrderDetailData['vendors'] extends { specialty: infer S } | null ? S : never,
      phone:     vendor.phone ?? null,
    } : null,
    vendor_dispatch_email: wo.vendor_dispatch_email ?? null,
    work_order_line_items: (lineItems ?? []) as WorkOrderDetailData['work_order_line_items'],
    work_order_photos:     (photos    ?? []) as WorkOrderDetailData['work_order_photos'],
  }

  return (
    <div className="max-w-4xl mx-auto">
      <Link
        href="/maintenance"
        className="inline-flex items-center gap-1.5 text-sm mb-5 transition-colors"
        style={{ color: 'var(--text-muted)' }}
      >
        <ChevronLeft className="w-4 h-4" />
        Maintenance
      </Link>

      <div
        className="rounded-2xl overflow-hidden"
        style={{ background: 'var(--bg-card)', border: '1px solid var(--border)' }}
      >
        <WorkOrderDetail
          workOrder={workOrderData}
          userRole={membership.role as 'admin' | 'manager' | 'crew' | 'viewer'}
          vendors={(orgVendors ?? []).map(v => ({ id: v.id, name: v.name, email: v.email ?? null }))}
        />
      </div>
    </div>
  )
}
