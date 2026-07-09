import { requireOrgMember } from '@/lib/auth'
import Link from 'next/link'
import { ComplianceSection } from './compliance-section'
import { ConnectStatus } from './connect-status'
import { VendorInvoiceHistory } from '@/components/work-orders/vendor-invoice-history'
import type { InvoiceHistoryRow } from '@/components/work-orders/vendor-invoice-history'
import { formatDate } from '@/lib/utils'
import type { Metadata } from 'next'
import { CheckCircle2, AlertTriangle, Ban, Star } from 'lucide-react'
import { Card } from '@/components/ui/Card'

export const metadata: Metadata = { title: 'Vendor' }

interface Props { params: Promise<{ id: string }> }

export default async function VendorDetailPage({ params }: Props) {
  const { id } = await params
  const { supabase, membership } = await requireOrgMember()

  const [
    { data: vendor },
    { data: docs },
    { data: complianceStatus },
    { data: recentWOs },
    { data: invoiceRows },
  ] = await Promise.all([
    supabase
      .from('vendors')
      .select('*')
      .eq('id', id)
      .eq('org_id', membership.org_id)
      .single(),

    supabase
      .from('vendor_compliance_documents')
      .select('*')
      .eq('vendor_id', id)
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('expiry_date', { ascending: true, nullsFirst: false }),

    supabase
      .from('vendor_compliance_status')
      .select('compliance_status, active_doc_count, expired_doc_count, expiring_soon_count')
      .eq('vendor_id', id)
      .eq('org_id', membership.org_id)
      .maybeSingle(),

    supabase
      .from('work_orders')
      .select('id, wo_number, title, status, priority, scheduled_date, completed_date, actual_cost')
      .eq('vendor_id', id)
      .eq('org_id', membership.org_id)
      .order('created_at', { ascending: false })
      .limit(10),

    supabase
      .from('work_order_invoices')
      .select('id, work_order_id, invoice_number, status, total, submitted_at, paid_at, work_orders(title, wo_number, properties(name))')
      .eq('vendor_id', id)
      .eq('org_id', membership.org_id)
      .order('submitted_at', { ascending: false }),
  ])

  if (!vendor) {
    return (
      <div className="max-w-2xl">
        <p className="text-muted-themed">Vendor not found.</p>
        <Link href="/vendors" className="text-sm underline mt-2 inline-block" style={{ color: 'var(--accent-blue)' }}>
          ← Back to vendors
        </Link>
      </div>
    )
  }

  const status = complianceStatus?.compliance_status
  const statusColor =
    status === 'compliant'      ? 'var(--accent-green)'  :
    status === 'expiring_soon'  ? 'var(--accent-amber)'  :
    status === 'grace_period'   ? 'var(--accent-red)'    :
    status === 'hard_blocked'   ? '#6b7280'               :
    'var(--text-muted)'

  const statusLabel =
    status === 'compliant'      ? 'Compliant'      :
    status === 'expiring_soon'  ? 'Expiring Soon'  :
    status === 'grace_period'   ? 'Grace Period'   :
    status === 'hard_blocked'   ? 'Blocked'        :
    'No Documents'

  const StatusIcon =
    status === 'compliant'      ? CheckCircle2 :
    status === 'expiring_soon'  ? AlertTriangle :
    status === 'grace_period'   ? AlertTriangle :
    status === 'hard_blocked'   ? Ban :
    null

  const completedWOs = (recentWOs ?? []).filter((w) => w.status === 'completed')
  const totalSpend   = completedWOs.reduce((s, w) => s + (w.actual_cost ?? 0), 0)

  const invoiceHistory: InvoiceHistoryRow[] = (invoiceRows ?? []).map((inv) => {
    const wo       = Array.isArray(inv.work_orders) ? inv.work_orders[0] : inv.work_orders
    const property = wo ? (Array.isArray(wo.properties) ? wo.properties[0] : wo.properties) : null
    return {
      id:            inv.id,
      workOrderId:   inv.work_order_id,
      woTitle:       wo?.title ?? 'Work Order',
      woNumber:      wo?.wo_number ?? null,
      invoiceNumber: inv.invoice_number,
      status:        inv.status,
      total:         inv.total,
      submittedAt:   inv.submitted_at,
      paidAt:        inv.paid_at,
      contextLabel:  property?.name ?? null,
    }
  })

  return (
    <div className="max-w-3xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm text-muted-themed mb-6">
        <Link href="/vendors" className="hover:text-secondary-themed">Vendors</Link>
        <span>/</span>
        <span className="text-secondary-themed">{vendor.name}</span>
      </div>

      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="page-title">{vendor.name}</h1>
          <p className="text-sm text-muted-themed mt-0.5 capitalize">
            {vendor.specialty.replace(/_/g, ' ')}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <span
            className="px-3 py-1 rounded-full text-sm font-semibold inline-flex items-center gap-1.5"
            style={{ color: statusColor, background: `${statusColor}1a`, border: `1px solid ${statusColor}44` }}
          >
            {StatusIcon && <StatusIcon className="w-4 h-4" />}
            {statusLabel}
          </span>
          <ConnectStatus
            vendorId={vendor.id}
            chargesEnabled={vendor.stripe_connect_charges_enabled}
            accountId={vendor.stripe_connect_account_id}
          />
        </div>
      </div>

      {/* Vendor info */}
      <Card className="mb-4">
        <h3 className="font-semibold text-primary-themed mb-4">Contact Info</h3>
        <div className="grid grid-cols-2 gap-y-3 text-sm">
          {vendor.contact_name && (
            <>
              <span className="text-muted-themed">Contact</span>
              <span className="text-secondary-themed font-medium">{vendor.contact_name}</span>
            </>
          )}
          {vendor.email && (
            <>
              <span className="text-muted-themed">Email</span>
              <a href={`mailto:${vendor.email}`} className="font-medium hover:underline" style={{ color: 'var(--accent-blue)' }}>
                {vendor.email}
              </a>
            </>
          )}
          {vendor.phone && (
            <>
              <span className="text-muted-themed">Phone</span>
              <a href={`tel:${vendor.phone}`} className="font-medium" style={{ color: 'var(--accent-blue)' }}>
                {vendor.phone}
              </a>
            </>
          )}
          {vendor.service_zip && (
            <>
              <span className="text-muted-themed">Service Area</span>
              <span className="text-secondary-themed font-medium">
                {vendor.service_zip}
                {vendor.service_radius_miles !== null && ` (+${vendor.service_radius_miles} mi)`}
              </span>
            </>
          )}
          {vendor.avg_rating !== null && vendor.rating_count > 0 && (
            <>
              <span className="text-muted-themed">Rating</span>
              <span className="text-secondary-themed font-medium inline-flex items-center gap-0.5">
                {Array.from({ length: 5 }, (_, i) => (
                  <Star
                    key={i}
                    className="w-3.5 h-3.5"
                    style={{
                      color: i < Math.round(vendor.avg_rating!) ? 'var(--accent-gold)' : 'var(--border-strong)',
                      fill:  i < Math.round(vendor.avg_rating!) ? 'var(--accent-gold)' : 'none',
                    }}
                  />
                ))}
                <span className="ml-1">({vendor.rating_count})</span>
              </span>
            </>
          )}
        </div>
        {vendor.notes && (
          <p className="text-sm text-muted-themed mt-3 pt-3 border-t border-themed">{vendor.notes}</p>
        )}
      </Card>

      {/* Work order stats */}
      {(recentWOs ?? []).length > 0 && (
        <Card className="mb-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold text-primary-themed">Work Orders</h3>
            <Link
              href={`/maintenance?vendor=${vendor.id}`}
              className="text-xs hover:underline"
              style={{ color: 'var(--accent-blue)' }}
            >
              View all →
            </Link>
          </div>
          <div className="flex gap-6 mb-4 pb-4 border-b border-themed text-sm">
            <div>
              <p className="text-xs text-muted-themed uppercase tracking-wide">Total WOs</p>
              <p className="text-2xl font-bold text-primary-themed">{(recentWOs ?? []).length}</p>
            </div>
            <div>
              <p className="text-xs text-muted-themed uppercase tracking-wide">Total Spend</p>
              <p className="text-2xl font-bold" style={{ color: 'var(--accent-gold)' }}>
                ${totalSpend.toFixed(0)}
              </p>
            </div>
          </div>
          <div className="space-y-1">
            {(recentWOs ?? []).slice(0, 5).map((wo) => (
              <Link
                key={wo.id}
                href={`/maintenance/${wo.id}`}
                className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-raised-themed transition-colors"
              >
                <span className="text-sm text-secondary-themed truncate">{wo.title}</span>
                <div className="flex items-center gap-3 flex-shrink-0 ml-2 text-xs text-muted-themed">
                  {wo.actual_cost !== null && <span>${wo.actual_cost.toFixed(0)}</span>}
                  {wo.completed_date && <span>{formatDate(wo.completed_date)}</span>}
                </div>
              </Link>
            ))}
          </div>
        </Card>
      )}

      {/* Work order history + invoices paid */}
      <VendorInvoiceHistory invoices={invoiceHistory} title="Work Order Invoices" />

      {/* Compliance documents */}
      <div id="compliance">
        <ComplianceSection
          vendorId={vendor.id}
          orgId={membership.org_id}
          documents={docs ?? []}
        />
      </div>
    </div>
  )
}
