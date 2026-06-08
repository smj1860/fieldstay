import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { MessagesClient } from './messages-client'

export const metadata: Metadata = { title: 'Messages' }

export default async function MessagesPage() {
  const { user, supabase, membership } = await requireOrgMember()

  const [{ data: crew }, { data: messages }] = await Promise.all([
    supabase
      .from('crew_members')
      .select('id, name, specialty, user_id')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .not('user_id', 'is', null)
      .order('name'),

    supabase
      .from('messages')
      .select('id, org_id, sender_id, recipient_id, content, read_at, turnover_id, work_order_id, created_at')
      .eq('org_id', membership.org_id)
      .or(`sender_id.eq.${user.id},recipient_id.eq.${user.id}`)
      .order('created_at', { ascending: true })
      .limit(1000),
  ])

  return (
    <MessagesClient
      currentUserId={user.id}
      orgId={membership.org_id}
      crew={(crew ?? []).map((c) => ({ id: c.id, name: c.name, specialty: c.specialty, user_id: c.user_id as string }))}
      initialMessages={messages ?? []}
    />
  )
}
