import { requireProperty } from '@/lib/auth'
import { IcalManager } from './ical-form'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Calendar Feeds' }

interface Props { params: { id: string } }

export default async function IcalPage({ params }: Props) {
  const { property, supabase } = await requireProperty(params.id)

  const { data: feeds } = await supabase
    .from('ical_feeds')
    .select('*')
    .eq('property_id', property.id)
    .order('created_at')

  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-accent-900 mb-1">Calendar Feeds</h2>
      <p className="text-sm text-accent-500 mb-6">
        Connect your Airbnb and VRBO calendars. FieldStay syncs bookings every 4 hours
        and automatically creates turnovers in the gaps between stays.
      </p>
      <IcalManager propertyId={property.id} feeds={feeds ?? []} />
    </div>
  )
}
