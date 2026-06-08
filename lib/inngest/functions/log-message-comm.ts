import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

// Auto-logs in-app PM ↔ crew messages to the communications log for audit history.
export const logMessageCommunication = inngest.createFunction(
  { id: 'log-message-communication', name: 'Log In-App Message to Comms Log', retries: 2 },
  { event: 'message/sent' as const },
  async ({ event, step, logger }) => {
    const { message_id, org_id, sender_id, recipient_id, is_crew_to_pm } = event.data
    const supabase = createServiceClient()

    const message = await step.run('fetch-message', async () => {
      const { data } = await supabase
        .from('messages')
        .select('content, created_at, work_order_id')
        .eq('id', message_id)
        .single()
      return data
    })

    if (!message) return { skipped: 'message_not_found' }

    const crewUserId = is_crew_to_pm ? sender_id : recipient_id

    const crewMember = await step.run('resolve-crew-member', async () => {
      const { data } = await supabase
        .from('crew_members')
        .select('id')
        .eq('user_id', crewUserId)
        .eq('org_id', org_id)
        .maybeSingle()
      return data
    })

    if (!crewMember) return { skipped: 'crew_member_not_found' }

    const result = await step.run('write-comms-log', async () => {
      // Idempotency: a message's created_at is unique to the millisecond — use
      // it as the dedup key since communication_logs has no source_reference_id.
      const { data: existing } = await supabase
        .from('communication_logs')
        .select('id')
        .eq('org_id', org_id)
        .eq('crew_member_id', crewMember.id)
        .eq('source', 'system')
        .eq('communicated_at', message.created_at)
        .maybeSingle()

      if (existing) return { logged: false, skipped: 'already_logged' }

      await supabase.from('communication_logs').insert({
        org_id,
        recipient_type:    'crew',
        crew_member_id:    crewMember.id,
        channel:           'note',
        subject:           is_crew_to_pm ? 'Crew → PM message' : 'PM → Crew message',
        body:              message.content,
        work_order_id:     message.work_order_id,
        source:            'system',
        logged_by_user_id: sender_id,
        communicated_at:   message.created_at,
      })

      return { logged: true, skipped: null as string | null }
    })

    logger.info(`Logged in-app message ${message_id} to comms log (${result.logged ? 'created' : result.skipped})`)
    return { message_id, crew_member_id: crewMember.id }
  }
)
