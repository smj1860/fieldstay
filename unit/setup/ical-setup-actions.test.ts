import { describe, it, expect, vi, beforeEach } from 'vitest'

// Next.js aliases this to an empty module at build time; vitest needs an
// explicit stub since the real package isn't installed as a dependency.
// Pulled in transitively via properties/actions.ts's markStepComplete ->
// lib/checklists/apply-master-template.ts.
vi.mock('server-only', () => ({}))

const mockRedirect = vi.fn((url: string) => {
  throw new Error(`REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({
  redirect: (url: string) => mockRedirect(url),
  unstable_rethrow: (err: unknown) => {
    if (err instanceof Error && err.message.startsWith('REDIRECT:')) throw err
  },
}))
vi.mock('@/lib/auth', () => ({
  requireOrgMember: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))
// Pulled in transitively via properties/actions.ts's markStepComplete, used
// by completeIcalStep — not under test in this file.
vi.mock('@/lib/checklists/apply-master-template', () => ({
  applyMasterChecklistToProperty: vi.fn(),
}))
vi.mock('@/lib/geocoding', () => ({ geocodeZip: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))

import { requireOrgMember } from '@/lib/auth'
import { logAuditEvent } from '@/lib/audit'
import { inngest } from '@/lib/inngest/client'
import {
  addIcalFeed,
  deleteIcalFeed,
  completeIcalStep,
  triggerSingleFeedSync,
} from '@/app/(dashboard)/properties/[id]/setup/ical/actions'

type Resp = { data?: unknown; error?: unknown }

function makeSupabase(queue: Record<string, Resp[]>) {
  const from = vi.fn((table: string) => {
    const q = queue[table]
    const result: Resp = q?.length ? q.shift()! : { data: null, error: null }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'insert', 'update', 'delete', 'eq']) {
      chain[m] = vi.fn(() => chain)
    }
    chain.single      = vi.fn(() => Promise.resolve(result))
    chain.maybeSingle = vi.fn(() => Promise.resolve(result))
    chain.then        = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { from }
}

const membership = {
  org_id: 'org_1',
  role:   'admin' as const,
  org:    { name: 'Lake Martin Delivery', plan: 'growth', plan_status: 'active', max_properties: 25, trial_ends_at: null },
}

function fd(fields: Record<string, string>) {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.append(k, v)
  return f
}

describe('properties/[id]/setup/ical/actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('addIcalFeed', () => {
    function icalFd(fields: Record<string, string> = {}) {
      return fd({ name: 'Airbnb', url: 'https://airbnb.com/cal/prop1.ics', ...fields })
    }

    it('adds a feed once the property is verified to belong to the caller org', async () => {
      const supabase = makeSupabase({
        properties:  [{ data: { id: 'prop_1' } }],
        ical_feeds:  [{ error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await addIcalFeed('prop_1', null, icalFd())

      expect(result).toEqual({ success: true })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'ical.feed.added' }))
    })

    // Regression test — addIcalFeed previously inserted an ical_feeds row
    // using the caller's org_id but a client-supplied propertyId that was
    // never verified to belong to that org. See CLAUDE.md's IDOR
    // standing-audit item; fixed in this session by adding the same
    // ownership check used elsewhere in this file (triggerSingleFeedSync)
    // and its sibling setup-wizard files.
    it('rejects a property id that does not belong to the caller org (IDOR check — regression test for the fix in this session)', async () => {
      const supabase = makeSupabase({ properties: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await addIcalFeed('other-orgs-property', null, icalFd())

      expect(result).toEqual({ error: 'Property not found' })
      expect(supabase.from).not.toHaveBeenCalledWith('ical_feeds')
      expect(logAuditEvent).not.toHaveBeenCalled()
    })

    it('rejects when the feed name is missing', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await addIcalFeed('prop_1', null, icalFd({ name: '' }))

      expect(result).toEqual({ error: 'Feed name is required' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('rejects an invalid calendar URL', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      const result = await addIcalFeed('prop_1', null, icalFd({ url: 'not-a-url' }))

      expect(result).toEqual({ error: 'Please enter a valid URL' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('returns a generic error and never touches the DB when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      const result = await addIcalFeed('prop_1', null, icalFd())

      expect(result).toEqual({ error: 'Operation failed. Please try again.' })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('deleteIcalFeed', () => {
    it('deletes a feed scoped to the caller org', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await expect(deleteIcalFeed('feed_1', 'prop_1')).resolves.toBeUndefined()

      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({ action: 'ical.feed.deleted' }))
    })

    it('throws when the caller is unauthenticated', async () => {
      const supabase = makeSupabase({})
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      await expect(deleteIcalFeed('feed_1', 'prop_1')).rejects.toThrow('REDIRECT:/login')
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })

  describe('completeIcalStep', () => {
    it('marks the ical step complete and redirects to the inventory step', async () => {
      const supabase = makeSupabase({
        properties: [{ data: { setup_steps_completed: {} } }, { error: null }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await expect(completeIcalStep('prop_1'))
        .rejects.toThrow('REDIRECT:/properties/prop_1/setup/inventory')
    })

    it('rejects and never touches the DB when the caller is unauthenticated', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      await expect(completeIcalStep('prop_1')).rejects.toThrow('REDIRECT:/login')
    })
  })

  describe('triggerSingleFeedSync', () => {
    it('sends a sync-requested event for a feed verified to belong to the caller org and property', async () => {
      const supabase = makeSupabase({
        ical_feeds: [{ data: { id: 'feed_1' } }],
      })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await triggerSingleFeedSync('feed_1', 'prop_1')

      expect(inngest.send).toHaveBeenCalledWith({
        name: 'ical/sync.requested',
        data: { feed_id: 'feed_1', property_id: 'prop_1', org_id: 'org_1' },
      })
    })

    it('silently no-ops for a feed id that does not belong to the caller org/property (IDOR check)', async () => {
      const supabase = makeSupabase({ ical_feeds: [{ data: null }] })
      vi.mocked(requireOrgMember).mockResolvedValue({
        supabase, membership, user: { id: 'user_1' },
      } as never)

      await triggerSingleFeedSync('other-orgs-feed', 'prop_1')

      expect(inngest.send).not.toHaveBeenCalled()
    })

    it('throws when the caller is unauthenticated', async () => {
      vi.mocked(requireOrgMember).mockRejectedValue(new Error('REDIRECT:/login'))

      await expect(triggerSingleFeedSync('feed_1', 'prop_1')).rejects.toThrow('REDIRECT:/login')
      expect(inngest.send).not.toHaveBeenCalled()
    })
  })
})
