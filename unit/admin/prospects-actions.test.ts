import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/auth', () => ({
  requirePlatformAdmin: vi.fn(),
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/audit', () => ({ logAuditEvent: vi.fn() }))
vi.mock('@/lib/observability/report-error', () => ({ reportError: vi.fn() }))
vi.mock('@/lib/inngest/client', () => ({ inngest: { send: vi.fn() } }))

import { requirePlatformAdmin } from '@/lib/auth'
import { inngest } from '@/lib/inngest/client'
import { logAuditEvent } from '@/lib/audit'
import {
  updateProspect,
  createProspect,
  bulkSetStatus,
  logProspectTouch,
  listProspectTouches,
  triggerProspectCrawl,
} from '@/app/admin/prospects/actions'

interface Resp { data?: unknown; error?: unknown }

/**
 * Captures the payload each `.update()`/`.insert()` was called with, which is
 * what nearly every assertion below is actually about — these actions are
 * mostly payload construction, so a mock that only reports success would let
 * every rule in `buildUpdate` regress silently.
 */
function makeSupabase(result: Resp = { data: null, error: null }) {
  const payloads: Record<string, unknown>[] = []
  const from = vi.fn(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    for (const m of ['select', 'eq', 'in', 'order', 'limit']) chain[m] = vi.fn(() => chain)
    for (const m of ['update', 'insert']) {
      chain[m] = vi.fn((payload: Record<string, unknown>) => { payloads.push(payload); return chain })
    }
    chain.single = vi.fn(() => Promise.resolve(result))
    chain.then   = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
    return chain
  })
  return { supabase: { from }, payloads }
}

function asAdmin(supabase: unknown) {
  vi.mocked(requirePlatformAdmin).mockResolvedValue(
    { supabase, user: { id: 'admin_1' } } as never,
  )
}

describe('admin/prospects/actions', () => {
  beforeEach(() => { vi.clearAllMocks() })

  describe('updateProspect', () => {
    it('trims text fields and stores an emptied field as NULL, not an empty string', async () => {
      const { supabase, payloads } = makeSupabase()
      asAdmin(supabase)

      await updateProspect('p1', { contact_name: '  Tiffany Rainwater  ', phone: '' })

      expect(payloads[0]).toEqual({ contact_name: 'Tiffany Rainwater', phone: null })
    })

    it('stamps last_touch_at for a status that means we reached out', async () => {
      const { supabase, payloads } = makeSupabase()
      asAdmin(supabase)

      await updateProspect('p1', { status: 'emailed' })

      expect(payloads[0].status).toBe('emailed')
      expect(payloads[0].last_touch_at).toEqual(expect.any(String))
    })

    // The rule this pins: last_touch_at is "how long since WE reached out",
    // which is what the follow-up queue sorts on. Letting their reply reset it
    // would make a stalled account look freshly worked.
    it('does NOT stamp last_touch_at for a status that records what they did', async () => {
      const { supabase, payloads } = makeSupabase()
      asAdmin(supabase)

      await updateProspect('p1', { status: 'replied' })

      expect(payloads[0]).toEqual({ status: 'replied' })
      expect(payloads[0]).not.toHaveProperty('last_touch_at')
    })

    it('rejects a status outside the CHECK constraint before touching the database', async () => {
      const { supabase, payloads } = makeSupabase()
      asAdmin(supabase)

      const res = await updateProspect('p1', { status: 'ghosted' as never })

      expect(res.error).toBe('Unknown status.')
      expect(payloads).toHaveLength(0)
    })

    it('rejects a next_action_at that is not an ISO date', async () => {
      const { supabase, payloads } = makeSupabase()
      asAdmin(supabase)

      const res = await updateProspect('p1', { next_action_at: 'next tuesday' })

      expect(res.error).toBe('Next action must be a date.')
      expect(payloads).toHaveLength(0)
    })

    it('accepts an empty next_action_at as clearing the date', async () => {
      const { supabase, payloads } = makeSupabase()
      asAdmin(supabase)

      await updateProspect('p1', { next_action_at: '' })

      expect(payloads[0]).toEqual({ next_action_at: null })
    })

    it('refuses to blank the company name', async () => {
      const { supabase, payloads } = makeSupabase()
      asAdmin(supabase)

      const res = await updateProspect('p1', { company: '   ' })

      expect(res.error).toBe('Company name is required.')
      expect(payloads).toHaveLength(0)
    })

    it('writes nothing when the patch carries no recognized field', async () => {
      const { supabase, payloads } = makeSupabase()
      asAdmin(supabase)

      const res = await updateProspect('p1', {})

      expect(res).toEqual({})
      expect(payloads).toHaveLength(0)
    })

    it('names the duplicate-domain constraint rather than a generic failure', async () => {
      const { supabase } = makeSupabase({ data: null, error: { code: '23505' } })
      asAdmin(supabase)

      const res = await updateProspect('p1', { domain: 'rohogo.com' })

      expect(res.error).toBe('Another account already has that domain.')
    })
  })

  describe('createProspect', () => {
    it('creates a manually-added account in the new status', async () => {
      const { supabase, payloads } = makeSupabase({ data: { id: 'p9' }, error: null })
      asAdmin(supabase)

      const res = await createProspect({ company: 'Rohogo Management Group' })

      expect(res).toEqual({ id: 'p9' })
      expect(payloads[0]).toMatchObject({
        company: 'Rohogo Management Group', status: 'new', source: 'manual',
      })
    })

    it('requires a company name', async () => {
      const { supabase, payloads } = makeSupabase()
      asAdmin(supabase)

      const res = await createProspect({ company: '  ' })

      expect(res.error).toBe('Company name is required.')
      expect(payloads).toHaveLength(0)
    })
  })

  describe('bulkSetStatus', () => {
    it('stamps last_touch_at once across the whole set', async () => {
      const { supabase, payloads } = makeSupabase({ data: [{ id: 'a' }, { id: 'b' }], error: null })
      asAdmin(supabase)

      const res = await bulkSetStatus(['a', 'b'], 'emailed')

      expect(res.updated).toBe(2)
      expect(payloads[0].status).toBe('emailed')
      expect(payloads[0].last_touch_at).toEqual(expect.any(String))
    })

    it('is a no-op on an empty selection', async () => {
      const { supabase, payloads } = makeSupabase()
      asAdmin(supabase)

      const res = await bulkSetStatus([], 'emailed')

      expect(res).toEqual({ updated: 0 })
      expect(payloads).toHaveLength(0)
    })

    it('logs one prospect_touches row per updated account for a touch-logging status', async () => {
      const { supabase, payloads } = makeSupabase({ data: [{ id: 'a' }, { id: 'b' }], error: null })
      asAdmin(supabase)

      await bulkSetStatus(['a', 'b'], 'emailed')

      expect(payloads[1]).toEqual([
        { prospect_id: 'a', touch_type: 'emailed', note: null, actor_id: 'admin_1' },
        { prospect_id: 'b', touch_type: 'emailed', note: null, actor_id: 'admin_1' },
      ])
    })

    it('does not log a touch for an administrative funnel move', async () => {
      const { supabase, payloads } = makeSupabase({ data: [{ id: 'a' }], error: null })
      asAdmin(supabase)

      await bulkSetStatus(['a'], 'queued')

      expect(payloads).toHaveLength(1)
    })
  })

  describe('updateProspect — touch logging', () => {
    it('logs a prospect_touches row for a status that represents an interaction', async () => {
      const { supabase, payloads } = makeSupabase()
      asAdmin(supabase)

      await updateProspect('p1', { status: 'replied' })

      expect(payloads[1]).toEqual([
        { prospect_id: 'p1', touch_type: 'replied', note: null, actor_id: 'admin_1' },
      ])
    })

    it('does not log a touch for a plain field edit', async () => {
      const { supabase, payloads } = makeSupabase()
      asAdmin(supabase)

      await updateProspect('p1', { notes: 'called yesterday, no answer' })

      expect(payloads).toHaveLength(1)
    })
  })

  describe('logProspectTouch', () => {
    it('inserts a touch row with a cleaned note', async () => {
      const { supabase, payloads } = makeSupabase()
      asAdmin(supabase)

      await logProspectTouch('p1', 'called', '  left a voicemail  ')

      expect(payloads[0]).toEqual({
        prospect_id: 'p1', touch_type: 'called', note: 'left a voicemail', actor_id: 'admin_1',
      })
    })

    it('rejects an unknown touch type before touching the database', async () => {
      const { supabase, payloads } = makeSupabase()
      asAdmin(supabase)

      const res = await logProspectTouch('p1', 'ghosted' as never)

      expect(res.error).toBe('Unknown touch type.')
      expect(payloads).toHaveLength(0)
    })
  })

  describe('listProspectTouches', () => {
    it('returns the rows the query hands back', async () => {
      const rows = [{ id: 't1', prospect_id: 'p1', touch_type: 'emailed', note: null, occurred_at: '2026-09-19T00:00:00Z' }]
      const { supabase } = makeSupabase({ data: rows, error: null })
      asAdmin(supabase)

      const res = await listProspectTouches('p1')

      expect(res.touches).toEqual(rows)
    })

    it('surfaces a query error as a friendly message', async () => {
      const { supabase } = makeSupabase({ data: null, error: { message: 'boom' } })
      asAdmin(supabase)

      const res = await listProspectTouches('p1')

      expect(res.error).toBe('Could not load history.')
    })
  })

  describe('triggerProspectCrawl', () => {
    it('sends the dispatch event with the requested limit and audits it', async () => {
      asAdmin(makeSupabase().supabase)

      const res = await triggerProspectCrawl(40)

      expect(res).toEqual({})
      expect(inngest.send).toHaveBeenCalledWith({
        name: 'prospecting/crawl.requested',
        data: { requested_by: 'admin_1', limit: 40 },
      })
      expect(logAuditEvent).toHaveBeenCalledWith(expect.objectContaining({
        action: 'platform_admin.prospect_account.crawl_triggered',
        metadata: { limit: 40 },
      }))
    })

    it('clamps a limit above the ceiling rather than queuing an unbounded batch', async () => {
      asAdmin(makeSupabase().supabase)

      await triggerProspectCrawl(99999)

      expect(inngest.send).toHaveBeenCalledWith({
        name: 'prospecting/crawl.requested',
        data: { requested_by: 'admin_1', limit: 100 },
      })
    })

    it('falls back to the default batch size when called with no argument', async () => {
      asAdmin(makeSupabase().supabase)

      await triggerProspectCrawl()

      expect(inngest.send).toHaveBeenCalledWith({
        name: 'prospecting/crawl.requested',
        data: { requested_by: 'admin_1', limit: 25 },
      })
    })
  })
})
