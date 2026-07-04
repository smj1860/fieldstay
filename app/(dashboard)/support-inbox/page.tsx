import { redirect }           from 'next/navigation'
import { createClient }       from '@/lib/supabase/server'
import { SupportInboxClient } from './support-inbox-client'

export default async function SupportInboxPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  const { data: staff } = await supabase
    .from('platform_staff')
    .select('user_id, role')
    .eq('user_id', user.id)
    .maybeSingle()

  if (!staff) redirect('/ops')

  const [{ data: conversations }, { data: feedback }] = await Promise.all([
    supabase
      .from('support_conversations')
      .select(`
        id, org_id, status, needs_human, escalation_reason, escalated_at,
        resolved_at, last_message_at, created_at,
        organizations ( name )
      `)
      .order('needs_human', { ascending: false })
      .order('last_message_at', { ascending: false })
      .limit(100),

    supabase
      .from('crew_feedback')
      .select(`
        id, feedback_text, created_at,
        crew_members ( name ),
        organizations ( name )
      `)
      .order('created_at', { ascending: false })
      .limit(50),
  ])

  return (
    <SupportInboxClient
      initialConversations={conversations ?? []}
      initialFeedback={feedback ?? []}
    />
  )
}
