import { createServiceClient } from '@/lib/supabase/server'
import type { CommChannel, CommRecipientType } from '@/types/database'

/**
 * Logs a system-generated communication (e.g. an automated vendor/crew email
 * sent from an Inngest function). Inngest steps run server-side with no
 * incoming request or user session, so this is a plain server-only helper —
 * not a 'use server' Server Action — to avoid exposing a client-invocable
 * endpoint that accepts a caller-supplied org_id with no auth check.
 */
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
  const admin = createServiceClient({ system: 'lib/comms-log' })

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
