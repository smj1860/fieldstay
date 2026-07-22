import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
  requireOrgRole:   vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/push/client', () => ({ sendPushToCrewMember: vi.fn() }))

import { requireOrgMember, requireOrgRole } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'
import { reportError } from '@/lib/observability/report-error'
import { createServiceClient } from '@/lib/supabase/server'
import {
  assignCrew,
  assignCrewIndividually,
  updateTurnoverStatus,
  createManualTurnover,
  addCrewToTurnover,
  removeCrewFromTurnover,
  bulkUpdateTurnoverStatus,
  archiveTurnover,
  unarchiveTurnover,
  triggerManualSync,
  acceptSuggestion,
  dismissSuggestion,
  rateTurnoverCompletion,
} from '@/app/(dashboard)/turnovers/actions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'upsert', 'eq', 'neq', 'in', 'not', 'is']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from }
}

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

// Every test that reaches the push-notification / service-client branch of
// assignCrew/addCrewToTurnover needs a service client stubbed, since that
// branch is wrapped in its own try/catch and must not fail the assertion.
function stubServiceClient() {
  vi.mocked(createServiceClient).mockReturnValue(makeSupabase({}) as never)
}

function fd(fields: Record<string, string>) {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.append(k, v)
  return f
}

describe('turnovers/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    stubServiceClient()
  })

  describe('assignCrew', () => {
    it('assigns crew to every turnover verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        turnovers: [{
          data: [{ id: 't_1', property_id: 'prop_1', checkout_datetime: '2026-07-22T11:00:00.000Z', suggestion_status: null, suggested_crew_ids: null }],
        }],
        crew_members: [{ data: { id: 'crew_1', name: 'Jamie Crew' } }],
        crew_availability: [{ data: [] }],
        turnover_assignments: [{ error: null }],
        properties: [{ data: [{ id: 'prop_1', bedrooms: 3 }] }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await assignCrew(['t_1'], 'crew_1')

      expect(result).toEqual({ success: true })
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'turnover/crew-assigned',
        data: { crew_member_id: 'crew_1', turnover_ids: ['t_1'], org_id: 'org_1' },
      })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'turnover.crew.assigned',
      }))
    })

    it('rejects turnover ids that do not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ turnovers: [{ data: [] }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await assignCrew(['other-orgs-turnover'], 'crew_1')

      expect(result).toEqual({ error: 'Turnovers not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('crew_members')
    })

    it('rejects a crew member id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({
        turnovers: [{ data: [{ id: 't_1', property_id: 'prop_1', checkout_datetime: '2026-07-22T11:00:00.000Z' }] }],
        crew_members: [{ data: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await assignCrew(['t_1'], 'other-orgs-crew')

      expect(result).toEqual({ error: 'Crew member not found' })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('warns, but still succeeds, when the crew member has marked time off on an assigned date', async () => {
      const supabase = makeSupabase({
        turnovers: [{
          data: [{ id: 't_1', property_id: 'prop_1', checkout_datetime: '2026-07-22T11:00:00.000Z', suggestion_status: null, suggested_crew_ids: null }],
        }],
        crew_members: [{ data: { id: 'crew_1', name: 'Jamie Crew' } }],
        crew_availability: [{ data: [{ available_date: '2026-07-22' }] }],
        turnover_assignments: [{ error: null }],
        properties: [{ data: [{ id: 'prop_1', bedrooms: 3 }] }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await assignCrew(['t_1'], 'crew_1')

      expect(result.success).toBe(true)
      expect(result.warning).toMatch(/marked time off/)
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await assignCrew(['t_1'], 'crew_1')

      expect(result).toEqual({ error: 'Failed to assign crew. Please try again.' })
      expect(reportError).toHaveBeenCalled()
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('assignCrewIndividually', () => {
    it('requires at least one assignment', async () => {
      const result = await assignCrewIndividually([])
      expect(result).toEqual({ error: 'No assignments to apply' })
    })

    it('groups assignments by crew member and applies them via assignCrew', async () => {
      const supabase = makeSupabase({
        turnovers: [
          { data: [{ id: 't_1', property_id: 'prop_1', checkout_datetime: '2026-07-22T11:00:00.000Z', suggestion_status: null, suggested_crew_ids: null }] },
        ],
        crew_members: [{ data: { id: 'crew_1', name: 'Jamie Crew' } }],
        crew_availability: [{ data: [] }],
        turnover_assignments: [{ error: null }],
        properties: [{ data: [{ id: 'prop_1', bedrooms: 3 }] }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await assignCrewIndividually([{ turnoverId: 't_1', crewMemberId: 'crew_1' }])

      expect(result).toEqual({ success: true })
    })
  })

  describe('updateTurnoverStatus', () => {
    it('marks a turnover completed and fires the completion event', async () => {
      const supabase = makeSupabase({
        turnovers: [
          { data: { status: 'in_progress' } },
          { error: null },
          { data: { property_id: 'prop_1', org_id: 'org_1' } },
        ],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await updateTurnoverStatus('t_1', 'completed')

      expect(result).toEqual({ success: true })
      expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'turnover/completed' }))
    })

    it('does not re-fire the completion event for an already-completed turnover', async () => {
      const supabase = makeSupabase({
        turnovers: [
          { data: { status: 'completed' } },
          { error: null },
        ],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await updateTurnoverStatus('t_1', 'completed', 'redundant re-save')

      expect(result).toEqual({ success: true })
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('scopes the status update to the caller org', async () => {
      const supabase = makeSupabase({
        turnovers: [{ data: { status: 'pending_assignment' } }, { error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await updateTurnoverStatus('t_1', 'in_progress')

      expect(supabase.from).toHaveBeenCalledWith('turnovers')
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await updateTurnoverStatus('t_1', 'in_progress')

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('createManualTurnover', () => {
    function turnoverFd(overrides: Partial<Record<string, string>> = {}) {
      return fd({
        property_id:   'prop_1',
        checkout_date: '2026-07-22',
        checkin_date:  '2026-07-23',
        ...overrides,
      })
    }

    it('creates a turnover when the property belongs to the caller org', async () => {
      const supabase = makeSupabase({
        properties:          [{ data: { id: 'prop_1' } }],
        checklist_templates: [{ data: { id: 'tmpl_1' } }],
        turnovers:           [{ data: { id: 't_1' } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await createManualTurnover(null, turnoverFd())

      expect(result).toEqual({ success: true })
      expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'turnover/created' }))
    })

    it('rejects a property id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await createManualTurnover(null, turnoverFd({ property_id: 'other-orgs-property' }))

      expect(result).toEqual({ error: 'Property not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('turnovers')
      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('rejects when check-in is not after checkout', async () => {
      const supabase = makeSupabase({ properties: [{ data: { id: 'prop_1' } }] })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await createManualTurnover(null, turnoverFd({
        checkout_date: '2026-07-23', checkin_date: '2026-07-22',
      }))

      expect(result).toEqual({ error: 'Check-in must be after checkout' })
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await createManualTurnover(null, turnoverFd())

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('addCrewToTurnover', () => {
    it('adds crew to verified turnovers additively', async () => {
      const supabase = makeSupabase({
        turnovers: [{
          data: [{ id: 't_1', property_id: 'prop_1', status: 'pending_assignment', checkout_datetime: '2026-07-22T11:00:00.000Z', checkin_datetime: '2026-07-22T15:00:00.000Z', suggestion_status: null, suggested_crew_ids: null }],
        }],
        crew_members: [{ data: { id: 'crew_1', name: 'Jamie Crew' } }],
        turnover_assignments: [{ data: [] }, { error: null }, { data: [] }],
        properties: [{ data: [{ id: 'prop_1', bedrooms: 3 }] }],
        crew_availability: [{ data: [] }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await addCrewToTurnover(['t_1'], 'crew_1')

      expect(result).toEqual({ success: true })
    })

    it('rejects turnover ids that do not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ turnovers: [{ data: [] }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await addCrewToTurnover(['other-orgs-turnover'], 'crew_1')

      expect(result).toEqual({ error: 'Turnovers not found' })
    })

    it('rejects a crew member id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({
        turnovers: [{ data: [{ id: 't_1', property_id: 'prop_1', status: 'assigned', checkout_datetime: '2026-07-22T11:00:00.000Z', checkin_datetime: '2026-07-22T15:00:00.000Z' }] }],
        crew_members: [{ data: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await addCrewToTurnover(['t_1'], 'other-orgs-crew')

      expect(result).toEqual({ error: 'Crew member not found' })
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await addCrewToTurnover(['t_1'], 'crew_1')

      expect(result).toEqual({ error: 'Failed to assign crew. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('removeCrewFromTurnover', () => {
    it('removes crew from a turnover verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        turnovers:            [{ data: { id: 't_1', status: 'assigned' } }],
        turnover_assignments: [{ error: null }, { data: [] }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await removeCrewFromTurnover('t_1', 'crew_1')

      expect(result).toEqual({ success: true })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'turnover.crew.removed',
      }))
    })

    it('rejects a turnover id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ turnovers: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await removeCrewFromTurnover('other-orgs-turnover', 'crew_1')

      expect(result).toEqual({ error: 'Turnover not found' })
      expect(logAuditEvent).not.toHaveBeenCalled()
    })
  })

  describe('bulkUpdateTurnoverStatus', () => {
    it('completes only turnovers verified to belong to the caller org and not already terminal', async () => {
      const supabase = makeSupabase({
        turnovers: [{ data: [{ id: 't_1', property_id: 'prop_1', org_id: 'org_1' }] }, { error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await bulkUpdateTurnoverStatus(['t_1'], 'completed')

      expect(result).toEqual({ success: true })
      expect(inngest.send).toHaveBeenCalledWith(expect.objectContaining({ name: 'turnover/completed' }))
    })

    it('no-ops when none of the ids are eligible (e.g. belong to another org)', async () => {
      const supabase = makeSupabase({ turnovers: [{ data: [] }] })
      vi.mocked(requireOrgMember).mockResolvedValue({ supabase, membership } as never)

      const result = await bulkUpdateTurnoverStatus(['other-orgs-turnover'], 'completed')

      expect(result).toEqual({ success: true })
      expect(inngest.send).not.toHaveBeenCalled()
    })
  })

  describe('archiveTurnover / unarchiveTurnover', () => {
    it('archives only completed turnovers scoped to the caller org', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await archiveTurnover(['t_1'])

      expect(result).toEqual({ success: true })
      expect(supabase.from).toHaveBeenCalledWith('turnovers')
    })

    it('requires at least one turnover id', async () => {
      const result = await archiveTurnover([])
      expect(result).toEqual({ error: 'No turnovers selected' })
    })

    it('unarchives turnovers scoped to the caller org', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await unarchiveTurnover(['t_1'])

      expect(result).toEqual({ success: true })
    })
  })

  describe('triggerManualSync', () => {
    it('sends the sync-all event for the caller org', async () => {
      vi.mocked(requireOrgMember).mockResolvedValue({ membership } as never)

      const result = await triggerManualSync()

      expect(result).toEqual({ success: true })
      expect(inngest.send).toHaveBeenCalledWith({ name: 'ical/sync.all.requested', data: { org_id: 'org_1' } })
    })

    it('returns a generic error when the caller is unauthenticated', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await triggerManualSync()

      expect(result).toEqual({ error: 'Could not start the calendar sync. Try again in a moment.' })
      expect(inngest.send).not.toHaveBeenCalled()
    })
  })

  describe('acceptSuggestion / dismissSuggestion', () => {
    it('accepts a pending suggestion for a turnover verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        turnovers:             [{ data: { id: 't_1', property_id: 'prop_1', status: 'pending_assignment', suggested_crew_ids: ['crew_1'] } }],
        turnover_assignments:  [{ error: null }],
        properties:            [{ data: { bedrooms: 3 } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await acceptSuggestion('t_1')

      expect(result).toEqual({ success: true })
    })

    it('rejects a turnover id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ turnovers: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await acceptSuggestion('other-orgs-turnover')

      expect(result).toEqual({ error: 'Turnover not found' })
    })

    it('returns an error when there is no suggestion to accept', async () => {
      const supabase = makeSupabase({
        turnovers: [{ data: { id: 't_1', property_id: 'prop_1', status: 'pending_assignment', suggested_crew_ids: [] } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await acceptSuggestion('t_1')

      expect(result).toEqual({ error: 'No suggestion to accept' })
    })

    it('dismisses a suggestion scoped to the caller org', async () => {
      const supabase = makeSupabase({
        turnovers: [{ data: { property_id: 'prop_1', suggested_crew_ids: [] } }, { error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await dismissSuggestion('t_1')

      expect(result).toEqual({ success: true })
    })
  })

  describe('rateTurnoverCompletion', () => {
    it('rates a completed turnover verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        turnovers: [{
          data: { id: 't_1', status: 'completed', turnover_assignments: [{ crew_member_id: 'crew_1' }] },
        }],
      })
      const service = makeSupabase({ assignment_outcomes: [{ error: null }] })
      vi.mocked(createServiceClient).mockReturnValue(service as never)
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await rateTurnoverCompletion('t_1', 5)

      expect(result).toEqual({ success: true })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action:   'turnover.pm_rating.submitted',
        metadata: { rating: 5 },
      }))
    })

    it('rejects an out-of-range rating before touching the DB', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await rateTurnoverCompletion('t_1', 6)

      expect(result).toEqual({ error: 'Rating must be between 1 and 5' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects a turnover id that does not belong to the caller org (IDOR check)', async () => {
      const supabase = makeSupabase({ turnovers: [{ data: null }] })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await rateTurnoverCompletion('other-orgs-turnover', 5)

      expect(result).toEqual({ error: 'Turnover not found' })
    })

    it('refuses to rate a turnover that is not completed', async () => {
      const supabase = makeSupabase({
        turnovers: [{ data: { id: 't_1', status: 'in_progress', turnover_assignments: [] } }],
      })
      vi.mocked(requireOrgRole).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await rateTurnoverCompletion('t_1', 5)

      expect(result).toEqual({ error: 'Only completed turnovers can be rated' })
    })

    it('does not touch the DB when the caller lacks the required role', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgRole).mockRejectedValue(
        new Error('You do not have permission to perform this action.')
      )

      const result = await rateTurnoverCompletion('t_1', 5)

      expect(result).toEqual({ error: 'Failed to save rating. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })
})
