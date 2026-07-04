import type { Metadata } from 'next'
import { requireOrgMember } from '@/lib/auth'
import { MessagesClient } from './messages-client'

export const metadata: Metadata = { title: 'Messages' }

export default async function MessagesPage({
  searchParams,
}: {
  searchParams: Promise<{ before?: string }>
}) {
  const { user, supabase, membership } = await requireOrgMember()
  const { before } = await searchParams

  const PAGE_SIZE = 50

  const query = supabase
    .from('messages')
    .select('id, org_id, sender_id, recipient_id, content, read_at, turnover_id, work_order_id, group_id, group_label, created_at')
    .eq('org_id', membership.org_id)
    .or(`sender_id.eq.${user.id},recipient_id.eq.${user.id}`)
    .order('created_at', { ascending: false })   // newest first — fixes the cutoff bug
    .limit(PAGE_SIZE + 1)                         // +1 to detect hasMore

  if (before) {
    query.lt('created_at', before)
  }

  const [{ data: crew }, { data: messages }] = await Promise.all([
    supabase
      .from('crew_members')
      .select('id, name, specialty, user_id')
      .eq('org_id', membership.org_id)
      .eq('is_active', true)
      .not('user_id', 'is', null)
      .order('name'),

    query,
  ])

  const hasMore   = (messages?.length ?? 0) > PAGE_SIZE
  const pageItems = hasMore ? (messages ?? []).slice(0, PAGE_SIZE) : (messages ?? [])
  const oldestTs  = pageItems.at(-1)?.created_at ?? null

  return (
    <MessagesClient
      currentUserId={user.id}
      orgId={membership.org_id}
      crew={(crew ?? []).map((c) => ({ id: c.id, name: c.name, specialty: c.specialty, user_id: c.user_id as string }))}
      initialMessages={pageItems}
      hasMore={hasMore}
      oldestTimestamp={oldestTs}
    />
  )
}
