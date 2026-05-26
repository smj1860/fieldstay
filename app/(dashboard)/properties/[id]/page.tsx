import { requireProperty } from '@/lib/auth'
import { calcSetupProgress, WIZARD_STEPS } from '@/lib/wizard'
import Link from 'next/link'
import { formatDate } from '@/lib/utils'
import { Settings, CalendarCheck, Package, Wrench, CheckCircle2, AlertCircle } from 'lucide-react'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Property' }
interface Props { params: Promise<{ id: string }> }

export default async function PropertyDetailPage({ params }: Props) {
  const { id } = await params
  const { property, supabase } = await requireProperty(id)

  const completed = (property.setup_steps_completed as Record<string, boolean>) ?? {}
  const progress  = calcSetupProgress(completed)

  const [
    { count: turnovers },
    { count: openWO },
    { data: feeds },
  ] = await Promise.all([
    supabase.from('turnovers').select('id', { count: 'exact', head: true }).eq('property_id', property.id).in('status', ['pending_assignment','assigned','in_progress']),
    supabase.from('work_orders').select('id', { count: 'exact', head: true }).eq('property_id', property.id).not('status', 'in', '("completed","cancelled")'),
    supabase.from('ical_feeds').select('id, name, last_synced_at, last_sync_status').eq('property_id', property.id),
  ])

  return (
    <div className="max-w-3xl">
      {/* Header */}
      <div className="flex items-start justify-between mb-8">
        <div>
          <div className="flex items-center gap-2 text-sm text-accent-400 mb-1">
            <Link href="/properties" className="hover:text-accent-600">Properties</Link>
            <span>/</span>
            <span className="text-accent-600">{property.name}</span>
          </div>
          <h1 className="page-title">{property.name}</h1>
          {property.address && (
            <p className="text-sm text-accent-400 mt-0.5">
              {[property.address, property.city, property.state].filter(Boolean).join(', ')}
            </p>
          )}
        </div>
        <Link href={`/properties/${property.id}/setup/details`} className="btn-secondary">
          <Settings className="w-4 h-4" />
          Setup
        </Link>
      </div>

      {/* Setup progress banner */}
      {progress < 100 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-5 py-4 mb-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <AlertCircle className="w-5 h-5 text-amber-500 flex-shrink-0" />
            <div>
              <p className="text-sm font-semibold text-amber-800">Setup {progress}% complete</p>
              <p className="text-xs text-amber-600 mt-0.5">
                {WIZARD_STEPS.filter((s) => !completed[s.key]).map((s) => s.label).join(', ')} still needed
              </p>
            </div>
          </div>
          <Link href={`/properties/${property.id}/setup`} className="btn-primary text-sm flex-shrink-0">
            Continue Setup
          </Link>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-8">
        <StatCard
          label="Active Turnovers"
          value={turnovers ?? 0}
          icon={<CalendarCheck className="w-5 h-5 text-brand-600" />}
          href={`/turnovers?property=${property.id}`}
        />
        <StatCard
          label="Open Work Orders"
          value={openWO ?? 0}
          icon={<Wrench className="w-5 h-5 text-amber-600" />}
          href={`/maintenance?property=${property.id}`}
        />
        <StatCard
          label="Calendar Feeds"
          value={feeds?.length ?? 0}
          icon={<Package className="w-5 h-5 text-accent-500" />}
          href={`/properties/${property.id}/setup/ical`}
        />
      </div>

      {/* Property details */}
      <div className="card mb-4">
        <h3 className="font-semibold text-accent-900 mb-4">Property Details</h3>
        <div className="grid grid-cols-2 gap-y-3 text-sm">
          <DetailRow label="Type" value={property.property_type} className="capitalize" />
          <DetailRow label="Beds / Baths" value={`${property.bedrooms} bed · ${property.bathrooms} bath`} />
          <DetailRow label="Check-in" value={property.checkin_time} />
          <DetailRow label="Check-out" value={property.checkout_time} />
          {property.wifi_name && <DetailRow label="Wi-Fi" value={`${property.wifi_name} / ${property.wifi_password}`} />}
          {property.door_code && <DetailRow label="Door Code" value={property.door_code} />}
        </div>
      </div>

      {/* Calendar feeds */}
      {feeds && feeds.length > 0 && (
        <div className="card">
          <h3 className="font-semibold text-accent-900 mb-4">Calendar Feeds</h3>
          <div className="space-y-2">
            {feeds.map((feed) => (
              <div key={feed.id} className="flex items-center justify-between text-sm">
                <span className="text-accent-700">{feed.name}</span>
                <div className="flex items-center gap-2">
                  {feed.last_synced_at && (
                    <span className="text-xs text-accent-400">
                      Synced {formatDate(feed.last_synced_at)}
                    </span>
                  )}
                  <span className={`badge ${
                    feed.last_sync_status === 'success' ? 'badge-green' :
                    feed.last_sync_status === 'error'   ? 'badge-red' : 'badge-slate'
                  }`}>
                    {feed.last_sync_status}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function StatCard({ label, value, icon, href }: {
  label: string; value: number; icon: React.ReactNode; href: string
}) {
  return (
    <Link href={href} className="card hover:shadow-card-md transition-shadow flex flex-col gap-2">
      <div className="flex items-center justify-between">
        {icon}
        <span className="text-2xl font-bold text-accent-900">{value}</span>
      </div>
      <p className="text-xs text-accent-500">{label}</p>
    </Link>
  )
}

function DetailRow({ label, value, className }: { label: string; value: string | number; className?: string }) {
  return (
    <>
      <span className="text-accent-400">{label}</span>
      <span className={`text-accent-800 font-medium ${className ?? ''}`}>{value}</span>
    </>
  )
}
