import { notFound } from 'next/navigation'
import { createServiceClient } from '@/lib/supabase/server'
import { isRealQueryError, throwIfAnyQueryFailed, unwrap } from '@/lib/supabase/unwrap'
import { OptInClient } from './opt-in-client'

export default async function GuestSmsOptInPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params
  const supabase = createServiceClient({ publicSurface: 'g-b--token--opt-in' })

  const bookingRes = await supabase
    .from('bookings')
    .select('id, property_id, guidebook_token')
    .eq('guidebook_token', token)
    .maybeSingle()
  const booking = unwrap(bookingRes, { site: 'page.g.b.opt-in' })

  if (!booking) notFound()

  const { data: property, error: propertyError } = await supabase
    .from('properties')
    .select('name')
    .eq('id', booking.property_id)
    .single()

  if (isRealQueryError(propertyError)) {
    throwIfAnyQueryFailed({ site: 'page.g.b.opt-in' }, propertyError)
  }

  if (!property) notFound()

  return <OptInClient token={token} propertyName={property.name} />
}
