import { inngest } from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'

// Auto-logs in-app PM ↔ crew messages to the communications log for audit history.
export const logMessageCommunication = inngest.createFunction(
  { id: 'log-message-communication', name: 'Log In-App Message to Comms Log', retries: 2 },
  { event: 'message/sent' as const },
  async ({ event, step, logger }) => {
    const { message_id, org_id, sender_id, recipient_id, is_crew_to_pm } = event.data

    const message = await step.run('fetch-message', async () => {
      const supabase = createServiceClient()
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
      const supabase = createServiceClient()
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
      const supabase = createServiceClient()
      // MEDIUM-9: dedup_key is backed by a partial unique index — a retried
      // step can no longer create a duplicate row even under a race between
      // a check and an insert, unlike the prior pure application-level check.
      const dedupKey = `message:${message_id}`

      const { error } = await supabase.from('communication_logs').insert({
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
        dedup_key:         dedupKey,
      })

      if (error) {
        if (error.code === '23505') return { logged: false, skipped: 'already_logged' as string | null }
        throw error
      }

      return { logged: true, skipped: null as string | null }
    })

    logger.info(`Logged in-app message ${message_id} to comms log (${result.logged ? 'created' : result.skipped})`)
    return { message_id, crew_member_id: crewMember.id }
  }
)
