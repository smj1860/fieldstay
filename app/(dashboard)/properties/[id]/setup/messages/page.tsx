import { requireProperty } from '@/lib/auth'
import { MessagesForm } from './messages-form'
import type { Metadata } from 'next'

export const metadata: Metadata = { title: 'Guest Messages' }
interface Props { params: Promise<{ id: string }> }

export default async function MessagesPage({ params }: Props) {
  const { id } = await params
  const { property, supabase } = await requireProperty(id)

  const { data: templates } = await supabase
    .from('guest_message_templates')
    .select('*')
    .eq('property_id', property.id)
    .order('trigger')

  const booking   = templates?.find((t) => t.trigger === 'booking_confirmed') ?? null
  const preCheckout = templates?.find((t) => t.trigger === 'pre_checkout') ?? null

  return (
    <div className="card">
      <h2 className="text-lg font-semibold text-accent-900 mb-1">Guest Messages</h2>
      <p className="text-sm text-accent-500 mb-6">
        Write in your own voice. Use <code className="bg-accent-100 text-accent-700 px-1 rounded text-xs">{'{{variable}}'}</code> placeholders
        — FieldStay fills them in when sending.
      </p>
      <MessagesForm
        propertyId={property.id}
        bookingTemplate={booking}
        checkoutTemplate={preCheckout}
      />
    </div>
  )
}
