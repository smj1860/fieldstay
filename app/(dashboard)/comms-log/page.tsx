import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { CommsLogClient } from './comms-log-client'

export const metadata: Metadata = { title: 'Comms Log' }

const PAGE_SIZE = 100

export default async function CommsLogPage({
  searchParams,
}: {
  searchParams: { page?: string }
}) {
  const { supabase, membership } = await requireOrgMember()

  const page   = Math.max(1, parseInt(searchParams.page ?? '1', 10) || 1)
  const offset = (page - 1) * PAGE_SIZE

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
      .is('deleted_at', null)
      .order('communicated_at', { ascending: false })
      // Fetch one extra row to detect a next page without a separate count query.
      .range(offset, offset + PAGE_SIZE),

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

  const toPersonOption = (rows: { id: string; name: string; specialty: string | null }[] | null) =>
    (rows ?? []).map((r) => ({ id: r.id, name: r.name, specialty: r.specialty ?? undefined }))

  const fetched = logs ?? []
  const hasMore = fetched.length > PAGE_SIZE
  const pageLogs = hasMore ? fetched.slice(0, PAGE_SIZE) : fetched

  return (
    <CommsLogClient
      logs={pageLogs as never}
      vendors={toPersonOption(vendors)}
      crew={toPersonOption(crew)}
      properties={properties ?? []}
      workOrders={workOrders ?? []}
      page={page}
      hasMore={hasMore}
    />
  )
}
