'use server'

import { revalidatePath }     from 'next/cache'
import { requireOrgMember }   from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent }      from '@/lib/audit'
import type { CommChannel, CommRecipientType } from '@/types/database'

export type CommsActionState = { error?: string; success?: boolean }

// ── Create manual communication log entry ────────────────────────────────────

export async function createCommunicationLog(
  _prev: CommsActionState | null,
  formData: FormData
): Promise<CommsActionState> {
  const { supabase, membership, user } = await requireOrgMember()

  const recipient_type  = formData.get('recipient_type') as CommRecipientType
  const vendor_id       = (formData.get('vendor_id') as string)    || null
  const crew_member_id  = (formData.get('crew_member_id') as string) || null
  const channel         = (formData.get('channel') as CommChannel)  || 'email'
  const subject         = (formData.get('subject') as string)?.trim()  || null
  const body            = (formData.get('body') as string)?.trim()     || null
  const property_id     = (formData.get('property_id') as string)  || null
  const work_order_id   = (formData.get('work_order_id') as string) || null
  const communicated_at = (formData.get('communicated_at') as string) || new Date().toISOString()

  if (!recipient_type)                          return { error: 'Recipient type is required' }
  if (recipient_type === 'vendor' && !vendor_id)
    return { error: 'Select a vendor' }
  if (recipient_type === 'crew' && !crew_member_id)
    return { error: 'Select a crew member' }
  if (!body && !subject)
    return { error: 'Add a subject or message body' }

  const { data: logEntry, error } = await supabase
    .from('communication_logs')
    .insert({
      org_id:             membership.org_id,
      recipient_type,
      vendor_id:          recipient_type === 'vendor' ? vendor_id       : null,
      crew_member_id:     recipient_type === 'crew'   ? crew_member_id  : null,
      channel,
      subject,
      body,
      property_id:        property_id    || null,
      work_order_id:      work_order_id  || null,
      source:             'manual',
      logged_by_user_id:  user.id,
      communicated_at:    communicated_at
        ? new Date(communicated_at).toISOString()
        : new Date().toISOString(),
    })
    .select('id')
    .single()

  if (error) return { error: error.message }

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'comms.log.created',
    targetType: 'communication_log',
    targetId:   logEntry?.id ?? undefined,
    metadata:   { recipient_type, channel, source: 'manual' },
  })

  revalidatePath('/comms-log')
  return { success: true }
}

// ── Delete a log entry ───────────────────────────────────────────────────────

export async function deleteCommunicationLog(
  logId: string
): Promise<{ error?: string }> {
  const { supabase, membership, user } = await requireOrgMember()

  const { error } = await supabase
    .from('communication_logs')
    .delete()
    .eq('id', logId)
    .eq('org_id', membership.org_id)
    .is('deleted_at', null)

  if (error) return { error: error.message }

  await logAuditEvent({
    orgId:      membership.org_id,
    actorId:    user.id,
    action:     'comms.log.deleted',
    targetType: 'communication_log',
    targetId:   logId,
  })

  revalidatePath('/comms-log')
  return {}
}

// ── System log (called by Inngest when sending vendor/crew emails) ────────────
// Uses service client since Inngest has no user session.

export async function logSystemCommunication(data: {
  org_id:          string
  recipient_type:  CommRecipientType
  vendor_id?:      string | null
  crew_member_id?: string | null
  channel:         CommChannel
  subject:         string
  body?:           string | null
  property_id?:    string | null
  work_order_id?:  string | null
}): Promise<void> {
  const admin = createServiceClient()

  await admin.from('communication_logs').insert({
    org_id:            data.org_id,
    recipient_type:    data.recipient_type,
    vendor_id:         data.vendor_id         ?? null,
    crew_member_id:    data.crew_member_id     ?? null,
    channel:           data.channel,
    subject:           data.subject,
    body:              data.body               ?? null,
    property_id:       data.property_id        ?? null,
    work_order_id:     data.work_order_id       ?? null,
    source:            'system',
    logged_by_user_id: null,
    communicated_at:   new Date().toISOString(),
  })
}
