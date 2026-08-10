import { redirect }           from 'next/navigation'
import { createClient }       from '@/lib/supabase/server'
import { SupportInboxClient } from './support-inbox-client'
import { unwrap, unwrapList } from '@/lib/supabase/unwrap'

/**
 * Open escalations shown at once. Far above any plausible simultaneous
 * backlog — the point is that a conversation asking for a human is never
 * silently dropped, not that the list is short.
 */
const ESCALATION_LIMIT = 500

/** Non-escalated conversations shown for context. */
const RECENT_CONVERSATION_LIMIT = 100

export default async function SupportInboxPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) redirect('/login')

  // A failed staff lookup must not read as "not staff" — that silently
  // redirects an actual staff member away from the inbox with no signal.
  const staffRes = await supabase
    .from('platform_staff')
    .select('user_id, role')
    .eq('user_id', user.id)
    .maybeSingle()
  const staff = unwrap(staffRes, { site: 'page.support-inbox.staff' })

  if (!staff) redirect('/ops')

  // Escalations are fetched SEPARATELY from recent conversations.
  //
  // One capped query ordered `needs_human` first does keep escalations at the
  // top, so they are not pushed off by ordinary traffic — the failure needs
  // more than RECENT_CONVERSATION_LIMIT escalations OPEN AT ONCE, not more
  // than that many conversations. But at that point the overflow is invisible
  // with no signal, and the one thing this page exists to guarantee is that a
  // conversation asking for a human is seen. Splitting the query removes the
  // interaction entirely: escalations are bounded by their own, much higher
  // ceiling and cannot compete with resolved chatter for slots.
  const [escalatedRes, recentRes, feedbackRes] = await Promise.all([
    supabase
      .from('support_conversations')
      .select(`
        id, org_id, status, needs_human, escalation_reason, escalated_at,
        resolved_at, last_message_at, created_at,
        organizations ( name )
      `)
      .eq('needs_human', true)
      .order('escalated_at', { ascending: false })
      .limit(ESCALATION_LIMIT),

    supabase
      .from('support_conversations')
      .select(`
        id, org_id, status, needs_human, escalation_reason, escalated_at,
        resolved_at, last_message_at, created_at,
        organizations ( name )
      `)
      .eq('needs_human', false)
      .order('last_message_at', { ascending: false })
      .limit(RECENT_CONVERSATION_LIMIT),

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
  // Escalations first, then recent — the order the client renders and the
  // order the single query used to produce, so nothing downstream changes.
  const conversations = [
    ...unwrapList(escalatedRes, { site: 'page.support-inbox.escalations' }),
    ...unwrapList(recentRes,    { site: 'page.support-inbox.recent' }),
  ]
  const feedback      = unwrapList(feedbackRes,      { site: 'page.support-inbox.feedback' })

  return (
    <SupportInboxClient
      initialConversations={conversations}
      initialFeedback={feedback}
    />
  )
}
