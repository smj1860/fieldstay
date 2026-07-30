// lib/dexie/sync/messages.ts
//
// Pulls this user's last 90 days of messages into Dexie. Extracted out of
// DexieProvider's mount effect (lib/dexie/context.tsx).

import type { DexieSupabaseClient } from './types'
import { getDexieDb, type MessageRow } from '../schema'
import { reportError } from '@/lib/observability/report-error'

/** Server-side retention window this pull mirrors — also the local prune horizon. */
export const MESSAGE_WINDOW_DAYS = 90

export async function syncMessages(
  supabase: DexieSupabaseClient,
  userId: string,
): Promise<void> {
  const db = getDexieDb(userId)
  const ninetyDaysAgo = new Date(Date.now() - MESSAGE_WINDOW_DAYS * 86_400_000).toISOString()
  const { data: messages, error } = await supabase
    .from('messages')
    .select('id, org_id, sender_id, recipient_id, content, read_at, turnover_id, group_id, group_label, created_at')
    .or(`sender_id.eq.${userId},recipient_id.eq.${userId}`)
    .gte('created_at', ninetyDaysAgo)
    .order('created_at', { ascending: false })  // newest first — limit drops oldest not newest
    .limit(500)
  // A failed pull is NOT an empty inbox — without this check the two are
  // indistinguishable, so an outage silently looks like "no messages".
  if (error) {
    console.error('[messages sync] messages fetch failed:', error)
    reportError(new Error(`messages fetch failed: ${error.message}`), { site: 'dexie.sync.messages' })
    return
  }
  if (messages?.length) await db.messages.bulkPut(messages as MessageRow[])
}
