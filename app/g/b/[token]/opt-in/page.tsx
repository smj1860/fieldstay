import { notFound } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/server'
import { OptInClient } from './opt-in-client'

export default async function GuestSmsOptInPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const supabase = createServiceClient()

  const { data: booking } = await supabase
    .from('bookings')
    .select('id, property_id, guidebook_token')
    .eq('guidebook_token', token)
    .maybeSingle()

  if (!booking) notFound()

  const { data: property } = await supabase
    .from('properties')
    .select('name')
    .eq('id', booking.property_id)
    .single()

  if (!property) notFound()

  return <OptInClient token={token} propertyName={property.name} />
}
