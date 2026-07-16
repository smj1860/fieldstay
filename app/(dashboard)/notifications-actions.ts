'use server'

import { requireOrgMember } from '@/lib/auth'

export async function markNotificationRead(notificationId: string): Promise<void> {
  const { supabase, membership } = await requireOrgMember()

  await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', notificationId)
    .eq('org_id', membership.org_id)
}
