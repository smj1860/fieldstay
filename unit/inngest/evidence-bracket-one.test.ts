import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: vi.fn(() => ({})) }))
vi.mock('@/lib/evidence/bracket', () => ({ bracketEvidenceEvent: vi.fn(), BRACKET_WINDOW_DAYS: 14 }))

import { evidenceBracketOne } from '@/lib/inngest/functions/cron/evidence-rebracket'
import { bracketEvidenceEvent } from '@/lib/evidence/bracket'
import { invokeHandler } from './test-helpers'

const step = { run: async (_n: string, cb: () => unknown) => cb() }
const event = { data: { org_id: 'o1', event_id: 'e1' } }

describe('evidenceBracketOne', () => {
  beforeEach(() => vi.mocked(bracketEvidenceEvent).mockReset())

  it('throws on a db_error so Inngest retries instead of reporting ok', async () => {
    vi.mocked(bracketEvidenceEvent).mockResolvedValue({ ok: false, reason: 'db_error' })
    await expect(invokeHandler(evidenceBracketOne, { event, step })).rejects.toThrow(/will retry/)
  })

  it('does not retry a missing event', async () => {
    vi.mocked(bracketEvidenceEvent).mockResolvedValue({ ok: false, reason: 'event_missing' })
    await expect(invokeHandler(evidenceBracketOne, { event, step })).resolves.toEqual({ ok: true })
  })
})
