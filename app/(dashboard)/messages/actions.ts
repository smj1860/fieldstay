'use server'

import { revalidatePath } from 'next/cache'
import { requireOrgMember } from '@/lib/auth'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'
import { sendPushToUser } from '@/lib/push/send-push'
import { reportError } from '@/lib/observability/report-error'
import type { Message } from '@/types/database'

export interface MessageActionResult {
  success: boolean
  error?: string
  message?: Message
}

// PM → crew message. Sends a push notification to the crew member's device.
export async function sendMessageToCrew(
  crewMemberId: string,
  content: string,
  contextId?: string
): Promise<MessageActionResult> {
  try {
    const { user, supabase, membership } = await requireOrgMember()
    const trimmed = content.trim()
    if (!trimmed) return { success: false, error: 'Message cannot be empty' }

    // Verify the crew member belongs to this org and derive the recipient from the DB —
    // never trust a client-supplied user_id for the recipient
    const { data: crewMember } = await supabase
      .from('crew_members')
      .select('id, user_id')
      .eq('id', crewMemberId)
      .eq('org_id', membership.org_id)
      .single()

    if (!crewMember?.user_id) {
      return { success: false, error: 'Crew member not found' }
    }

    const recipientId = crewMember.user_id

    const { data: message, error } = await supabase
      .from('messages')
      .insert({
        org_id:        membership.org_id,
        sender_id:     user.id,
        recipient_id:  recipientId,
        content:       trimmed,
        turnover_id:   contextId ?? null,
      })
      .select('id, org_id, sender_id, recipient_id, content, read_at, turnover_id, work_order_id, group_id, group_label, created_at')
      .single()

    if (error || !message) {
      console.error('[sendMessageToCrew]', error)
      return { success: false, error: 'Failed to send message' }
    }

    await inngest.send({
      name: 'message/sent' as const,
      data: {
        message_id:    message.id,
        org_id:        membership.org_id,
        sender_id:     user.id,
        recipient_id:  recipientId,
        is_crew_to_pm: false,
      },
    })

    await sendPushToUser(recipientId, {
      title: 'New message from your operations team',
      body:  trimmed.length > 120 ? `${trimmed.slice(0, 117)}...` : trimmed,
      url:   '/crew/messages',
    })

    return { success: true, message }
  } catch (err) {
    console.error('[sendMessageToCrew]', err)
    reportError(err, { site: 'serverAction.messages.sendMessageToCrew' })
    return { success: false, error: 'Failed to send message' }
  }
}

// Crew → PM message. Routes to an admin/manager/owner in the crew member's org.
export async function sendMessageToPM(content: string): Promise<MessageActionResult> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { success: false, error: 'Not authenticated' }

    const trimmed = content.trim()
    if (!trimmed) return { success: false, error: 'Message cannot be empty' }

    const { data: crewMember } = await supabase
      .from('crew_members')
      .select('id, org_id, name')
      .eq('user_id', user.id)
      .maybeSingle()

    if (!crewMember) return { success: false, error: 'Crew profile not found' }

    // Crew members have no RLS visibility into organization_members (they're
    // not members of the org themselves), so this lookup intentionally
    // bypasses RLS via the service client to find a contact to route to.
    const admin = createServiceClient({ crew: crewMember })
    const { data: recipient } = await admin
      .from('organization_members')
      .select('user_id')
      .eq('org_id', crewMember.org_id)
      .in('role', ['owner', 'admin', 'manager'])
      .not('invite_accepted_at', 'is', null)
      .limit(1)
      .maybeSingle()

    if (!recipient) return { success: false, error: 'No operations contact found' }

    const { data: message, error } = await supabase
      .from('messages')
      .insert({
        org_id:       crewMember.org_id,
        sender_id:    user.id,
        recipient_id: recipient.user_id,
        content:      trimmed,
      })
      .select('id, created_at')
      .single()

    if (error || !message) {
      console.error('[sendMessageToPM]', error)
      return { success: false, error: 'Failed to send message' }
    }

    await inngest.send({
      name: 'message/sent' as const,
      data: {
        message_id:    message.id,
        org_id:        crewMember.org_id,
        sender_id:     user.id,
        recipient_id:  recipient.user_id,
        is_crew_to_pm: true,
      },
    })

    await postToSlack(supabase, crewMember.org_id, crewMember.name, trimmed)

    return { success: true }
  } catch (err) {
    console.error('[sendMessageToPM]', err)
    reportError(err, { site: 'serverAction.messages.sendMessageToPM' })
    return { success: false, error: 'Failed to send message' }
  }
}

// Sends a single message to multiple crew members with a shared group_id.
// Each recipient gets their own row; the group_id ties them together for display.
export async function sendGroupMessage(
  crewMemberIds: string[],
  content: string,
  groupLabel?: string
): Promise<{ error?: string }> {
  try {
    const { user, supabase, membership } = await requireOrgMember()
    if (crewMemberIds.length < 2) return { error: 'Select at least 2 recipients for a group message' }

    const { data: crewUsers } = await supabase
      .from('crew_members')
      .select('id, user_id')
      .in('id', crewMemberIds)
      .eq('org_id', membership.org_id)

    if (!crewUsers?.length) return { error: 'No valid recipients found' }

    const groupId = crypto.randomUUID()

    const rows = crewUsers
      .filter(c => c.user_id)
      .map(c => ({
        org_id:       membership.org_id,
        sender_id:    user.id,
        recipient_id: c.user_id as string,
        content,
        group_id:     groupId,
        group_label:  groupLabel ?? null,
      }))

    if (!rows.length) return { error: 'No valid recipients found' }

    const { error } = await supabase.from('messages').insert(rows)
    if (error) {
      console.error('[sendGroupMessage]', error.message)
      reportError(error, { site: 'serverAction.messages.sendGroupMessage' })
      return { error: 'Failed to send group message' }
    }

    revalidatePath('/messages')
    return {}
  } catch (err) {
    console.error('[sendGroupMessage]', err)
    reportError(err, { site: 'serverAction.messages.sendGroupMessage' })
    return { error: 'Failed to send group message' }
  }
}

// Marks every unread message from `otherUserId` to the current user as read.
export async function markConversationRead(otherUserId: string): Promise<MessageActionResult> {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return { success: false, error: 'Not authenticated' }

    const { error } = await supabase
      .from('messages')
      .update({ read_at: new Date().toISOString() })
      .eq('sender_id', otherUserId)
      .eq('recipient_id', user.id)
      .is('read_at', null)

    if (error) {
      console.error('[markConversationRead]', error)
      return { success: false, error: 'Failed to mark messages read' }
    }

    return { success: true }
  } catch (err) {
    console.error('[markConversationRead]', err)
    reportError(err, { site: 'serverAction.messages.markConversationRead' })
    return { success: false, error: 'Failed to mark messages read' }
  }
}

// Posts a non-fatal Slack notification when a crew member messages the PM,
// if the org has configured an Incoming Webhook URL.
async function postToSlack(
  supabase: Awaited<ReturnType<typeof createClient>>,
  orgId: string,
  crewMemberName: string,
  content: string
): Promise<void> {
  try {
    const { data: org } = await supabase
      .from('organizations')
      .select('slack_webhook_url')
      .eq('id', orgId)
      .maybeSingle()

    if (!org?.slack_webhook_url) return

    await fetch(org.slack_webhook_url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        text: `\u{1F4AC} *${crewMemberName}* sent you a message on FieldStay:\n>${content}`,
      }),
    })
  } catch (err) {
    console.error('[postToSlack]', err)
    reportError(err, { site: 'serverAction.messages.postToSlack', orgId })
  }
}
