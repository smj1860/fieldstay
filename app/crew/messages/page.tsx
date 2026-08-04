import { unwrap }      from '@/lib/supabase/unwrap'
import { redirect }     from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { CrewMessagesView } from './messages-view'

/**
 * Message history is read from the server, not the Dexie cache.
 *
 * Caching 90 days of it on every device was the single heaviest thing the
 * crew safety poll pulled — up to 500 rows, uncursored, every five minutes —
 * to back a screen whose entire purpose is getting a reply, which needs a
 * connection anyway. Reading old messages offline is close to worthless;
 * being able to COMPOSE one offline is not, and that half now goes through
 * the outbox (see lib/dexie/helpers.ts's queueMessageToPM).
 */
export const dynamic = 'force-dynamic'

/** Mirrors the retention window the crew conversation ever showed. */
const WINDOW_DAYS = 90
const MAX_MESSAGES = 200

export default async function CrewMessagesPage() {
  const supabase           = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const since = new Date()
  since.setDate(since.getDate() - WINDOW_DAYS)

  const res = await supabase
    .from('messages')
    .select('id, sender_id, content, group_label, created_at')
    .or(`sender_id.eq.${user.id},recipient_id.eq.${user.id}`)
    .gte('created_at', since.toISOString())
    .order('created_at', { ascending: false })
    .limit(MAX_MESSAGES)

  // A failed read is NOT an empty inbox — unwrap logs, reports and throws to
  // the segment's error boundary rather than rendering "no messages yet".
  const rows = unwrap(res, { site: 'page.crew.messages' }) ?? []

  return (
    <CrewMessagesView
      userId={user.id}
      // Newest-first from the query so the limit drops the OLDEST, then
      // reversed for display.
      messages={[...rows].reverse()}
    />
  )
}
