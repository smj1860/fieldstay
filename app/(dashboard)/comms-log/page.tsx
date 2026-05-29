import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { CommsLogClient } from './comms-log-client'

export const metadata: Metadata = { title: 'Comms Log' }

export default async function CommsLogPage() {
  const { supabase, membership } = await requireOrgMember()

  const [
    { data: logs },
    { data: vendors },
    { data: crew },
    { data: properties },
    { data: workOrders },
  ] = await Promise.all([
    supabase
      .from('communication_logs')
      .select(`
        id, recipient_type, channel, subject, body, source,
        communicated_at, created_at,
        vendor_id,       vendors      ( id, name, specialty ),
        crew_member_id,  crew_members ( id, name, specialty ),
        property_id,     properties   ( id, name ),
        work_order_id,   work_orders  ( id, title )
      `)
      .eq('org_id', membership.org_id)
      .order('communicated_at', { ascending: false })
      .limit(500),

    supabase
      .from('vendors')
      .select('id, name, specialty')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),

    supabase
      .from('crew_members')
      .select('id, name, specialty')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),

    supabase
      .from('properties')
      .select('id, name')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .order('name'),

    supabase
      .from('work_orders')
      .select('id, title')
      .eq('org_id', membership.org_id)
      .not('status', 'in', '("cancelled")')
      .order('created_at', { ascending: false })
      .limit(100),
  ])

  return (
    <CommsLogClient
      logs={(logs ?? []) as never}
      vendors={vendors   ?? []}
      crew={crew         ?? []}
      properties={properties ?? []}
      workOrders={workOrders ?? []}
    />
  )
}
