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
  saveProspectContact,
  promoteProspectContact,
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

describe('admin/prospects/actions — contacts', () => {
  beforeEach(() => { vi.clearAllMocks() })

  describe('saveProspectContact', () => {
    it('normalizes as it saves and never names the generated email_key', async () => {
      const { supabase, payloads } = makeSupabase({ data: { id: 'c1' }, error: null })
      asAdmin(supabase)

      await saveProspectContact('p1', {
        full_name: '  Dana Reed ',
        title:     'Owner',
        email:     'Dana@Example.COM',
        phone:     '(865) 555-0142',
      })

      expect(payloads[0]).toMatchObject({
        prospect_id:  'p1',
        full_name:    'Dana Reed',
        title:        'Owner',
        email:        'dana@example.com',
        phone:        '+18655550142',
        email_status: 'unknown',
      })
      // GENERATED ALWAYS: naming it makes Postgres reject the WHOLE statement
      // with 428C9, and the error is only logged, so the write vanishes.
      expect(payloads[0]).not.toHaveProperty('email_key')
    })

    it('keeps a phone it cannot parse, because it is still how you reach them', async () => {
      const { supabase, payloads } = makeSupabase({ data: { id: 'c1' }, error: null })
      asAdmin(supabase)

      await saveProspectContact('p1', { full_name: 'Dana', phone: 'call the office' })

      expect(payloads[0]).toMatchObject({ phone: 'call the office' })
    })

    it('refuses an email it cannot parse rather than storing it', async () => {
      const { supabase, payloads } = makeSupabase({ data: { id: 'c1' }, error: null })
      asAdmin(supabase)

      const res = await saveProspectContact('p1', { full_name: 'Dana', email: 'dana at example' })

      expect(res.error).toMatch(/not valid/i)
      expect(payloads).toHaveLength(0)
    })

    it('refuses a contact that names nobody and reaches nobody', async () => {
      const { supabase, payloads } = makeSupabase({ data: { id: 'c1' }, error: null })
      asAdmin(supabase)

      const res = await saveProspectContact('p1', { title: 'Owner', notes: 'found on LinkedIn' })

      expect(res.error).toMatch(/name, an email or a phone/i)
      expect(payloads).toHaveLength(0)
    })

    it('refuses a LinkedIn value that is not a usable web address', async () => {
      const { supabase, payloads } = makeSupabase({ data: { id: 'c1' }, error: null })
      asAdmin(supabase)

      const res = await saveProspectContact('p1', {
        full_name: 'Dana', linkedin_url: 'javascript:alert(1)',
      })

      expect(res.error).toMatch(/not a usable web address/i)
      expect(payloads).toHaveLength(0)
    })

    it('names the duplicate-email constraint instead of "operation failed"', async () => {
      const { supabase } = makeSupabase({ data: null, error: { code: '23505' } })
      asAdmin(supabase)

      const res = await saveProspectContact('p1', { full_name: 'Dana', email: 'dana@example.com' })

      expect(res.error).toMatch(/already has a contact with that email/i)
    })

    it('rejects an unknown email status', async () => {
      const { supabase, payloads } = makeSupabase({ data: { id: 'c1' }, error: null })
      asAdmin(supabase)

      const res = await saveProspectContact('p1', {
        full_name:    'Dana',
        email_status: 'retired' as never,
      })

      expect(res.error).toMatch(/unknown email status/i)
      expect(payloads).toHaveLength(0)
    })

    it('logs the save without putting the contact details in the audit row', async () => {
      const { supabase } = makeSupabase({ data: { id: 'c1' }, error: null })
      asAdmin(supabase)

      await saveProspectContact('p1', { full_name: 'Dana Reed', email: 'dana@example.com' })

      const entry = vi.mocked(logAuditEvent).mock.calls[0][0]
      expect(entry.action).toBe('platform_admin.prospect_contact.saved')
      expect(JSON.stringify(entry.metadata)).not.toMatch(/dana/i)
    })
  })

  describe('promoteProspectContact', () => {
    it('reads the account back rather than deriving the new primary locally', async () => {
      const primary = {
        contact_name: 'Dana Reed', contact_title: 'Owner', email: 'dana@example.com',
        phone: '+18655550142', linkedin_url: null,
        email_is_generic: false, email_status: 'valid',
      }
      const { supabase } = makeSupabase({ data: primary, error: null })
      asAdmin({ ...supabase, rpc: vi.fn(() => Promise.resolve({ error: null })) })

      const res = await promoteProspectContact('c1', 'p1')

      expect(res.error).toBeUndefined()
      expect(res.primary).toEqual(primary)
    })

    it('reports success when the swap landed but the read-back did not', async () => {
      // Saying it failed would invite a second promote, which swaps it back.
      const { supabase } = makeSupabase({ data: null, error: { code: 'PGRST116' } })
      asAdmin({ ...supabase, rpc: vi.fn(() => Promise.resolve({ error: null })) })

      const res = await promoteProspectContact('c1', 'p1')

      expect(res.error).toBeUndefined()
      expect(res.primary).toBeUndefined()
    })

    it('surfaces a colliding email instead of a generic failure', async () => {
      const { supabase } = makeSupabase()
      asAdmin({ ...supabase, rpc: vi.fn(() => Promise.resolve({ error: { code: '23505' } })) })

      const res = await promoteProspectContact('c1', 'p1')

      expect(res.error).toMatch(/same email as another contact/i)
    })
  })
})
