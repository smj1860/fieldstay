import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { CommunicationsTable } from './communications-table'

export const metadata: Metadata = { title: 'Communications' }

export default async function CommunicationsPage() {
  const { supabase, membership } = await requireOrgMember()

  // Fetch sent messages with property name
  const { data: messages } = await supabase
    .from('guest_messages_sent')
    .select(`
      id,
      property_id,
      trigger,
      recipient_name,
      recipient_email,
      subject,
      sent_at,
      status,
      properties ( name )
    `)
    .eq('org_id', membership.org_id)
    .order('sent_at', { ascending: false })
    .limit(100)

  // Fetch properties for filter dropdown
  const { data: properties } = await supabase
    .from('properties')
    .select('id, name')
    .eq('org_id', membership.org_id)
    .eq('is_active', true)
    .order('name')

  return (
    <div>
      <div className="page-header">
        <h1 className="page-title">Communications</h1>
        <p className="page-subtitle">
          Automated guest messages sent from your properties
        </p>
      </div>

      <CommunicationsTable
        messages={messages ?? []}
        properties={properties ?? []}
      />
    </div>
  )
}
