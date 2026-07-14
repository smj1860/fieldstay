import { requireProperty } from '@/lib/auth'
import { calcSetupProgress, WIZARD_STEPS } from '@/lib/wizard'
import Link from 'next/link'
import { formatDate } from '@/lib/utils'
import { Settings, CalendarCheck, Package, Wrench, CheckCircle2, AlertCircle, Clock, AlertTriangle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { PropertyMaintenanceManager } from '@/components/property/PropertyMaintenanceManager'
import { VendorInvoiceHistory } from '@/components/work-orders/vendor-invoice-history'
import type { InvoiceHistoryRow } from '@/components/work-orders/vendor-invoice-history'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { buttonVariantClass } from '@/components/ui/Button'
import { DoorCodeReveal } from './door-code-reveal'
import type { MaintenanceSchedule, MaintenanceCatalogItem } from '@/types/database'
import type { Metadata } from 'next'

function feedStatusTone(status: string): 'green' | 'red' | 'slate' {
  if (status === 'success') return 'green'
  if (status === 'error') return 'red'
  return 'slate'
}

export const metadata: Metadata = { title: 'Property' }
interface Props { params: Promise<{ id: string }> }

export default async function PropertyDetailPage({ params }: Props) {
  const { id } = await params
  const { property, supabase } = await requireProperty(id)

  const completed = (property.setup_steps_completed as Record<string, boolean>) ?? {}
  const progress  = calcSetupProgress(completed)

  const thisYearStart = `${new Date().getFullYear()}-01-01`

  const [
    { count: turnovers },
    { count: openWO },
    { data: feeds },
    { data: recentWOs },
    { data: ytdCompletedWOs },
    { data: upcomingSchedules },
    { data: allSchedules },
    { data: catalogItems },
    { data: invoiceRows, error: invoiceError },
  ] = await Promise.all([
    supabase
      .from('turnovers')
      .select('id', { count: 'exact', head: true })
      .eq('property_id', property.id)
      .in('status', ['pending_assignment','assigned','in_progress']),

    supabase
      .from('work_orders')
      .select('id', { count: 'exact', head: true })
      .eq('property_id', property.id)
      .not('status', 'in', '("completed","cancelled")'),

    supabase
      .from('ical_feeds')
      .select('id, name, last_synced_at, last_sync_status')
      .eq('property_id', property.id),

    // Last 10 WOs for this property (open + completed)
    supabase
      .from('work_orders')
      .select('id, title, status, priority, scheduled_date, completed_date, actual_cost, estimated_cost, vendor_id, vendors(name)')
      .eq('property_id', property.id)
      .not('status', 'eq', 'cancelled')
      .order('created_at', { ascending: false })
      .limit(10),

    // All completed WOs this year (for the YTD Spend stat — not capped like recentWOs above)
    supabase
      .from('work_orders')
      .select('actual_cost, estimated_cost')
      .eq('property_id', property.id)
      .eq('status', 'completed')
      .gte('completed_date', thisYearStart),

    // Upcoming scheduled maintenance (for summary widget)
    supabase
      .from('maintenance_schedules')
      .select('id, name, frequency, next_due_date, estimated_cost')
      .eq('property_id', property.id)
      .eq('is_active', true)
      .order('next_due_date', { ascending: true })
      .limit(5),

    // Full schedule list for management UI
    supabase
      .from('maintenance_schedules')
      .select('*')
      .eq('property_id', property.id)
      .eq('is_active', true)
      .order('next_due_date', { ascending: true }),

    // Catalog for "Add from catalog" modal
    supabase
      .from('maintenance_catalog_items')
      .select('*')
      .eq('is_active', true)
      .order('category')
      .order('sort_order'),

    // Invoices paid to vendors for work orders at this property
    supabase
      .from('work_order_invoices')
      .select('id, work_order_id, invoice_number, status, total, submitted_at, paid_at, work_orders(title, wo_number, vendors(name))')
      .eq('property_id', property.id)
      .eq('org_id', property.org_id)
      .order('submitted_at', { ascending: false }),
  ])

  if (invoiceError) {
    console.error('[PropertyDetailPage] invoice history fetch failed:', invoiceError.message)
  }

  // Calculate YTD maintenance spend
  const ytdSpend = (ytdCompletedWOs ?? []).reduce((sum, wo) => {
    const cost = (wo.actual_cost ?? wo.estimated_cost ?? 0)
    return sum + cost
  }, 0)
  const openWOs      = recentWOs?.filter((wo) => wo.status !== 'completed') ?? []
  const completedLog = recentWOs?.filter((wo) => wo.status === 'completed') ?? []

  const invoiceHistory: InvoiceHistoryRow[] = (invoiceRows ?? []).map((inv) => {
    const wo     = Array.isArray(inv.work_orders) ? inv.work_orders[0] : inv.work_orders
    const vendor = wo ? (Array.isArray(wo.vendors) ? wo.vendors[0] : wo.vendors) : null
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
      contextLabel:  vendor?.name ?? null,
    }
  })

  const today = new Date().toISOString().split('T')[0]

  return (
    <div className="max-w-3xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <div className="flex items-center gap-2 text-sm text-muted-themed mb-1">
            <Link href="/properties" className="hover:text-secondary-themed">Properties</Link>
            <span>/</span>
            <span className="text-secondary-themed">{property.name}</span>
          </div>
          <h1 className="page-title">{property.name}</h1>
          {property.address && (
            <p className="text-sm text-muted-themed mt-0.5">
              {[property.address, property.city, property.state].filter(Boolean).join(', ')}
            </p>
          )}
        </div>
        <Link href={`/properties/${property.id}/setup/details`} className={buttonVariantClass('secondary')}>
          <Settings className="w-4 h-4" /> Setup
        </Link>
      </div>

      {/* Setup progress banner */}
      {progress < 100 && (
        <div className="rounded-xl px-5 py-4 mb-6 flex items-center justify-between gap-4"
             style={{ background: 'var(--accent-amber-dim)', border: '1px solid rgba(245,158,11,0.3)' }}>
          <div className="flex items-center gap-3">
            <AlertCircle className="w-5 h-5 flex-shrink-0" style={{ color: 'var(--accent-amber)' }} />
            <div>
              <p className="text-sm font-semibold" style={{ color: 'var(--accent-amber)' }}>Setup {progress}% complete</p>
              <p className="text-xs text-muted-themed mt-0.5">
                {WIZARD_STEPS.filter((s) => !completed[s.key]).map((s) => s.label).join(', ')} still needed
              </p>
            </div>
          </div>
          <Link href={`/properties/${property.id}/setup`} className={buttonVariantClass('primary') + ' text-sm flex-shrink-0'}>
            Continue Setup
          </Link>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <StatCard label="Active Turnovers" value={turnovers ?? 0}
          icon={<CalendarCheck className="w-5 h-5" style={{ color: 'var(--accent-blue)' }} />}
          href={`/turnovers?property=${property.id}`} />
        <StatCard label="Open Work Orders" value={openWO ?? 0}
          icon={<Wrench className="w-5 h-5" style={{ color: 'var(--accent-amber)' }} />}
          href={`/maintenance?property=${property.id}`} />
        <StatCard label="Calendar Feeds" value={feeds?.length ?? 0}
          icon={<Package className="w-5 h-5" style={{ color: 'var(--text-muted)' }} />}
          href={`/properties/${property.id}/setup/ical`} />
      </div>

      {/* Property details */}
      <Card className="mb-4">
        <h3 className="font-semibold text-primary-themed mb-4">Property Details</h3>
        <div className="grid grid-cols-2 gap-y-3 text-sm">
          <DetailRow label="Type" value={property.property_type} className="capitalize" />
          <DetailRow label="Bedrooms" value={`${property.bedrooms}`} />
          {property.bathrooms !== null && (
            <DetailRow label="Bathrooms" value={`${property.bathrooms}`} />
          )}
          {property.square_footage !== null && (
            <DetailRow label="Sq Footage" value={`${property.square_footage.toLocaleString()} sqft`} />
          )}
          <DetailRow label="Check-in"  value={property.checkin_time} />
          <DetailRow label="Check-out" value={property.checkout_time} />
          {property.wifi_name  && <DetailRow label="Wi-Fi" value={`${property.wifi_name} / ${property.wifi_password}`} />}
          {property.door_code_secret_id && (
            <>
              <span className="text-muted-themed">Door Code</span>
              <span className="text-secondary-themed font-medium">
                <DoorCodeReveal propertyId={property.id} />
              </span>
            </>
          )}
          {property.cleaning_cost !== null && (
            <DetailRow label="Cleaning Fee" value={`$${property.cleaning_cost.toFixed(2)}`} />
          )}
          {property.same_day_premium_pct !== null && (
            <DetailRow label="Same-Day Premium" value={`+${property.same_day_premium_pct}%`} />
          )}
        </div>
      </Card>

      {/* ── Maintenance Schedule Manager ────────────────────────────────── */}
      <Card className="mb-4">
        <PropertyMaintenanceManager
          propertyId={property.id}
          initialSchedules={(allSchedules ?? []) as MaintenanceSchedule[]}
          catalog={(catalogItems ?? []) as MaintenanceCatalogItem[]}
        />
      </Card>

      {/* ── Feature 6: Maintenance History ─────────────────────────────── */}
      <Card className="mb-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-primary-themed">Maintenance</h3>
          <Link href={`/maintenance?property=${property.id}`}
                className="text-xs hover:underline"
                style={{ color: 'var(--accent-blue)' }}>
            View all →
          </Link>
        </div>

        {/* YTD spend summary */}
        <div className="flex items-center gap-4 mb-5 pb-4 border-b border-themed">
          <div>
            <p className="text-xs text-muted-themed uppercase tracking-wide">YTD Spend</p>
            <p className="text-2xl font-bold" style={{ color: 'var(--accent-gold)' }}>
              ${ytdSpend.toFixed(0)}
            </p>
          </div>
          <div>
            <p className="text-xs text-muted-themed uppercase tracking-wide">Completed WOs</p>
            <p className="text-2xl font-bold text-primary-themed">{completedLog.length}</p>
          </div>
          {(openWO ?? 0) > 0 && (
            <div>
              <p className="text-xs text-muted-themed uppercase tracking-wide">Open WOs</p>
              <p className="text-2xl font-bold" style={{ color: 'var(--accent-amber)' }}>{openWO}</p>
            </div>
          )}
        </div>

        {/* Open WOs */}
        {openWOs.length > 0 && (
          <div className="mb-4">
            <p className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-2">Open</p>
            <div className="space-y-2">
              {openWOs.map((wo) => {
                const isOverdue = wo.scheduled_date && wo.scheduled_date < today && wo.status !== 'completed'
                return (
                  <Link key={wo.id} href={`/maintenance/${wo.id}`}
                        className="flex items-center justify-between p-3 rounded-lg border border-themed hover:bg-raised-themed transition-colors">
                    <div className="flex items-center gap-2 min-w-0">
                      {wo.priority === 'urgent' && <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent-red)' }} />}
                      {wo.priority === 'high' && <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent-amber)' }} />}
                      <span className="text-sm text-primary-themed font-medium truncate">{wo.title}</span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0 ml-2">
                      {isOverdue && <span className="text-xs font-medium" style={{ color: 'var(--accent-red)' }}>Overdue</span>}
                      {wo.scheduled_date && !isOverdue && (
                        <span className="text-xs text-muted-themed">{formatDate(wo.scheduled_date)}</span>
                      )}
                    </div>
                  </Link>
                )
              })}
            </div>
          </div>
        )}

        {/* Recent completed */}
        {completedLog.length > 0 && (
          <div className="mb-4">
            <p className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-2">Recent Completed</p>
            <div className="space-y-1">
              {completedLog.slice(0, 5).map((wo) => {
                const vendor = Array.isArray(wo.vendors) ? wo.vendors[0] : wo.vendors
                const cost   = wo.actual_cost ?? wo.estimated_cost
                return (
                  <Link key={wo.id} href={`/maintenance/${wo.id}`}
                        className="flex items-center justify-between py-2 px-3 rounded-lg hover:bg-raised-themed transition-colors">
                    <div className="flex items-center gap-2 min-w-0">
                      <CheckCircle2 className="w-3.5 h-3.5 flex-shrink-0" style={{ color: 'var(--accent-green)' }} />
                      <span className="text-sm text-secondary-themed truncate">{wo.title}</span>
                      {vendor && <span className="text-xs text-muted-themed hidden sm:block">· {vendor.name}</span>}
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0 ml-2 text-xs text-muted-themed">
                      {cost !== null && <span>${cost.toFixed(0)}</span>}
                      {wo.completed_date && <span>{formatDate(wo.completed_date, 'MMM d')}</span>}
                    </div>
                  </Link>
                )
              })}
            </div>
          </div>
        )}

        {/* Upcoming scheduled */}
        {upcomingSchedules && upcomingSchedules.length > 0 && (
          <div>
            <p className="text-xs font-semibold text-muted-themed uppercase tracking-wide mb-2">Scheduled Maintenance</p>
            <div className="space-y-1">
              {upcomingSchedules.map((s) => {
                const isOverdue = s.next_due_date && s.next_due_date < today
                return (
                  <div key={s.id} className="flex items-center justify-between py-2 px-3 rounded-lg"
                       style={{ background: isOverdue ? 'var(--accent-red-dim)' : 'transparent' }}>
                    <div className="flex items-center gap-2">
                      <Clock className="w-3.5 h-3.5 flex-shrink-0"
                             style={{ color: isOverdue ? 'var(--accent-red)' : 'var(--text-muted)' }} />
                      <span className="text-sm text-secondary-themed">{s.name}</span>
                    </div>
                    <div className="flex items-center gap-2 text-xs">
                      {s.estimated_cost !== null && (
                        <span className="text-muted-themed">${s.estimated_cost}</span>
                      )}
                      {s.next_due_date && (
                        <span className={cn('font-medium', isOverdue ? '' : 'text-muted-themed')}
                              style={isOverdue ? { color: 'var(--accent-red)' } : undefined}>
                          {isOverdue ? 'Overdue · ' : ''}{formatDate(s.next_due_date, 'MMM d')}
                        </span>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {openWOs.length === 0 && completedLog.length === 0 && (!upcomingSchedules || upcomingSchedules.length === 0) && (
          <p className="text-sm text-muted-themed text-center py-4">No maintenance history yet.</p>
        )}
      </Card>

      {/* Vendor invoices paid for this property's work orders */}
      <VendorInvoiceHistory invoices={invoiceHistory} title="Vendor Invoices" loadError={!!invoiceError} />

      {/* Calendar feeds */}
      {feeds && feeds.length > 0 && (
        <Card>
          <h3 className="font-semibold text-primary-themed mb-4">Calendar Feeds</h3>
          <div className="space-y-2">
            {feeds.map((feed) => (
              <div key={feed.id} className="flex items-center justify-between text-sm">
                <span className="text-secondary-themed">{feed.name}</span>
                <div className="flex items-center gap-2">
                  {feed.last_synced_at && (
                    <span className="text-xs text-muted-themed">Synced {formatDate(feed.last_synced_at)}</span>
                  )}
                  <Badge tone={feedStatusTone(feed.last_sync_status)}>
                    {feed.last_sync_status}
                  </Badge>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  )
}

function StatCard({ label, value, icon, href }: Readonly<{
  label: string; value: number; icon: React.ReactNode; href: string
}>) {
  return (
    <Link href={href} className="card hover:shadow-card-md transition-shadow flex flex-col gap-2">
      <div className="flex items-center justify-between">
        {icon}
        <span className="text-2xl font-bold text-primary-themed">{value}</span>
      </div>
      <p className="text-xs text-muted-themed">{label}</p>
    </Link>
  )
}

function DetailRow({ label, value, className }: Readonly<{ label: string; value: string | number; className?: string }>) {
  return (
    <>
      <span className="text-muted-themed">{label}</span>
      <span className={`text-secondary-themed font-medium ${className ?? ''}`}>{value}</span>
    </>
  )
}
