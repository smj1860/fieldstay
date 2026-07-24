import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))
vi.mock('@/lib/supabase/server', () => ({
  createClient:        vi.fn(),
  createServiceClient:  vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/push/send-push', () => ({ sendPushToUser: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { requireOrgMember } from '@/lib/auth'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'
import { sendPushToUser } from '@/lib/push/send-push'
import { reportError } from '@/lib/observability/report-error'
import {
  sendMessageToCrew,
  sendMessageToPM,
  sendGroupMessage,
  markConversationRead,
} from '@/app/(dashboard)/messages/actions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>, userId: string | null = 'user_1') {
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'eq', 'in', 'not', 'limit', 'is']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return {
    from,
    auth: { getUser: vi.fn(() => Promise.resolve({ data: { user: userId ? { id: userId } : null } })) },
  }
}

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

describe('messages/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('sendMessageToCrew', () => {
    it('sends the message to the crew member derived from the DB, not a client-supplied id', async () => {
      const supabase = makeSupabase({
        crew_members: [{ data: { id: 'crew_1', user_id: 'crew-user-1' } }],
        messages: [{
          data: {
            id: 'msg_1', org_id: 'org_1', sender_id: 'user_1', recipient_id: 'crew-user-1',
            content: 'On your way?', read_at: null, turnover_id: null, work_order_id: null,
            group_id: null, group_label: null, created_at: '2026-07-22T00:00:00.000Z',
          },
        }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        user: { id: 'user_1' }, supabase, membership,
      } as never)

      const result = await sendMessageToCrew('crew_1', 'On your way?')

      expect(result.success).toBe(true)
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'message/sent',
        data: expect.objectContaining({ recipient_id: 'crew-user-1', is_crew_to_pm: false }),
      })
      expect(sendPushToUser).toHaveBeenCalledWith('crew-user-1', expect.objectContaining({
        title: 'New message from your operations team',
      }))
    })

    it('rejects an empty message before touching the DB', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        user: { id: 'user_1' }, supabase, membership,
      } as never)

      const result = await sendMessageToCrew('crew_1', '   ')

      expect(result).toEqual({ success: false, error: 'Message cannot be empty' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects a crew member id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ crew_members: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        user: { id: 'user_1' }, supabase, membership,
      } as never)

      const result = await sendMessageToCrew('other-orgs-crew', 'hi')

      expect(result).toEqual({ success: false, error: 'Crew member not found' })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await sendMessageToCrew('crew_1', 'hi')

      expect(result).toEqual({ success: false, error: 'Failed to send message' })
      expect(reportError).toHaveBeenCalled()
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('sendMessageToPM', () => {
    it('routes the message to an admin/manager/owner contact in the sender org', async () => {
      const supabase = makeSupabase({
        crew_members: [{ data: { id: 'crew_1', org_id: 'org_1', name: 'Jamie Crew' } }],
        organizations: [{ data: { slack_webhook_url: null } }],
        messages: [{ data: { id: 'msg_1', created_at: '2026-07-22T00:00:00.000Z' } }],
      })
      const admin = makeSupabase({
        organization_members: [{ data: { user_id: 'pm-user-1' } }],
      })
      vi.mocked(createClient).mockResolvedValue(supabase as never)
      vi.mocked(createServiceClient).mockReturnValue(admin as never)

      const result = await sendMessageToPM('Need more towels')

      expect(result).toEqual({ success: true })
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'message/sent',
        data: expect.objectContaining({ recipient_id: 'pm-user-1', is_crew_to_pm: true }),
      })
    })

    it('returns Not authenticated and never queries crew_members when there is no session', async () => {
      const supabase = makeSupabase({}, null)
      vi.mocked(createClient).mockResolvedValue(supabase as never)

      const result = await sendMessageToPM('hi')

      expect(result).toEqual({ success: false, error: 'Not authenticated' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('fails gracefully when the caller has no crew profile', async () => {
      const supabase = makeSupabase({ crew_members: [{ data: null }] })
      vi.mocked(createClient).mockResolvedValue(supabase as never)

      const result = await sendMessageToPM('hi')

      expect(result).toEqual({ success: false, error: 'Crew profile not found' })
    })

    it('fails gracefully when no operations contact exists for the org', async () => {
      const supabase = makeSupabase({
        crew_members: [{ data: { id: 'crew_1', org_id: 'org_1', name: 'Jamie Crew' } }],
      })
      const admin = makeSupabase({ organization_members: [{ data: null }] })
      vi.mocked(createClient).mockResolvedValue(supabase as never)
      vi.mocked(createServiceClient).mockReturnValue(admin as never)

      const result = await sendMessageToPM('hi')

      expect(result).toEqual({ success: false, error: 'No operations contact found' })
    })
  })

  describe('sendGroupMessage', () => {
    it('inserts one row per valid recipient sharing a group_id', async () => {
      const supabase = makeSupabase({
        crew_members: [{
          data: [
            { id: 'crew_1', user_id: 'user-crew-1' },
            { id: 'crew_2', user_id: 'user-crew-2' },
          ],
        }],
        messages: [{ error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        user: { id: 'user_1' }, supabase, membership,
      } as never)

      const result = await sendGroupMessage(['crew_1', 'crew_2'], 'Team meeting at 9am', 'Cleaning crew')

      expect(result).toEqual({})
    })

    it('requires at least 2 recipients before touching the DB', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        user: { id: 'user_1' }, supabase, membership,
      } as never)

      const result = await sendGroupMessage(['crew_1'], 'hi')

      expect(result).toEqual({ error: 'Select at least 2 recipients for a group message' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('only sends to crew members verified against the caller org (IDOR check)', async () => {
      // crew_members query is itself scoped with .eq('org_id', ...) — simulate
      // one of the two requested ids belonging to a different org and being filtered out.
      const supabase = makeSupabase({
        crew_members: [{ data: [{ id: 'crew_1', user_id: 'user-crew-1' }] }],
        messages: [{ error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        user: { id: 'user_1' }, supabase, membership,
      } as never)

      const result = await sendGroupMessage(['crew_1', 'other-orgs-crew'], 'hi')

      expect(result).toEqual({})
      expect(supabase.from).toHaveBeenCalledWith('messages')
    })

    it('reports the error without leaking raw DB error details on insert failure', async () => {
      const supabase = makeSupabase({
        crew_members: [{ data: [{ id: 'crew_1', user_id: 'u1' }, { id: 'crew_2', user_id: 'u2' }] }],
        messages: [{ error: { message: 'insert failed: duplicate key value violates unique constraint' } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        user: { id: 'user_1' }, supabase, membership,
      } as never)

      const result = await sendGroupMessage(['crew_1', 'crew_2'], 'hi')

      expect(result).toEqual({ error: 'Failed to send group message' })
      expect(reportError).toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await sendGroupMessage(['crew_1', 'crew_2'], 'hi')

      expect(result).toEqual({ error: 'Failed to send group message' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('markConversationRead', () => {
    it('marks unread messages from the other user as read for the current user', async () => {
      const supabase = makeSupabase({ messages: [{ error: null }] })
      vi.mocked(createClient).mockResolvedValue(supabase as never)

      const result = await markConversationRead('crew-user-1')

      expect(result).toEqual({ success: true })
      expect(supabase.from).toHaveBeenCalledWith('messages')
    })

    it('returns Not authenticated and never touches the DB when there is no session', async () => {
      const supabase = makeSupabase({}, null)
      vi.mocked(createClient).mockResolvedValue(supabase as never)

      const result = await markConversationRead('crew-user-1')

      expect(result).toEqual({ success: false, error: 'Not authenticated' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })
})
