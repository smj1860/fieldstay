import { redirect }           from 'next/navigation'
import { createClient }       from '@/lib/supabase/server'
import { SupportInboxClient } from './support-inbox-client'
import { unwrap, unwrapList } from '@/lib/supabase/unwrap'

export default async function SupportInboxPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  // A failed staff lookup must not read as "not staff" — that silently
  // redirects an actual staff member away from the inbox with no signal.
  const staff = unwrap(
    await supabase
      .from('platform_staff')
      .select('user_id, role')
      .eq('user_id', user.id)
      .maybeSingle(),
    { site: 'page.support-inbox.staff' },
  )

  if (!staff) redirect('/ops')

  const [conversationsRes, feedbackRes] = await Promise.all([
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
        id, feedback_text, submitted_at,
        crew_members ( name ),
        organizations ( name )
      `)
      .order('submitted_at', { ascending: false })
      .limit(50),
  ])

  // unwrapList throws on a query failure so the segment error boundary renders
  // a real error state, instead of an empty inbox that looks like a quiet day.
  const conversations = unwrapList(conversationsRes, { site: 'page.support-inbox.conversations' })
  const feedback      = unwrapList(feedbackRes,      { site: 'page.support-inbox.feedback' })

  return (
    <SupportInboxClient
      initialConversations={conversations}
      initialFeedback={feedback}
    />
  )
}
