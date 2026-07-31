'use server'

import { requireOrgMember } from '@/lib/auth'
import { reportQueryError } from '@/lib/supabase/unwrap'

export async function markNotificationRead(
  notificationId: string,
): Promise<{ success: boolean }> {
  const { supabase, membership } = await requireOrgMember()

  // The error was previously discarded entirely, so a failed write — an RLS
  // denial, a missing GRANT — looked identical to a successful one and the
  // bell simply never cleared, with nothing logged and nothing in Sentry.
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('id', notificationId)
    .eq('org_id', membership.org_id)

  if (reportQueryError(error, {
    site: 'serverAction.notifications.markNotificationRead',
    orgId: membership.org_id,
    extra: { notification_id: notificationId },
  })) {
    return { success: false }
  }

  return { success: true }
}
