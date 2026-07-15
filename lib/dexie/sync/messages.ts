// lib/dexie/sync/messages.ts
//
// Pulls this user's last 90 days of messages into Dexie. Extracted out of
// DexieProvider's mount effect (lib/dexie/context.tsx).

import type { DexieSupabaseClient } from './types'
import { getDexieDb, type MessageRow } from '../schema'

export async function syncMessages(
  supabase: DexieSupabaseClient,
  userId: string,
): Promise<void> {
  const db = getDexieDb(userId)
  const ninetyDaysAgo = new Date(Date.now() - 90 * 86_400_000).toISOString()
  const { data: messages } = await supabase
    .from('messages')
    .select('id, org_id, sender_id, recipient_id, content, read_at, turnover_id, group_id, group_label, created_at')
    .or(`sender_id.eq.${userId},recipient_id.eq.${userId}`)
    .gte('created_at', ninetyDaysAgo)
    .order('created_at', { ascending: false })  // newest first — limit drops oldest not newest
    .limit(500)
  if (messages?.length) await db.messages.bulkPut(messages as MessageRow[])
}
