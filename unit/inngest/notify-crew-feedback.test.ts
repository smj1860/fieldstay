import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn(async () => ({ data: { id: 'email_1' }, error: null })) } },
  FROM:   'FieldStay <noreply@fieldstay.app>',
}))
vi.mock('@/lib/resend/emails/pm-alert', () => ({
  renderPmAlert: vi.fn(async () => '<html>alert</html>'),
}))

import { notifyCrewFeedback } from '@/lib/inngest/functions/notify-crew-feedback'
import { createServiceClient } from '@/lib/supabase/server'
import { resend } from '@/lib/resend/client'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'
import { invokeHandler } from './test-helpers'

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function makeSupabase(opts: {
  crewNameResult?: { data: unknown; error?: { code: string; message: string } | null }
  orgNameResult?: { data: unknown; error?: { code: string; message: string } | null }
} = {}) {
  const from = vi.fn((table: string) => {
    const chain: any = {} // eslint-disable-line @typescript-eslint/no-explicit-any
    chain.select = vi.fn(() => chain)
    chain.eq     = vi.fn(() => chain)
    if (table === 'crew_members') {
      chain.single = vi.fn(() =>
        Promise.resolve(opts.crewNameResult ?? { data: { name: 'Jamie Crew' }, error: null }),
      )
    } else if (table === 'organizations') {
      chain.single = vi.fn(() =>
        Promise.resolve(opts.orgNameResult ?? { data: { name: 'Lake Martin Delivery' }, error: null }),
      )
    } else {
      chain.single = vi.fn(() => Promise.resolve({ data: null, error: null }))
    }
    return chain
  })
  return { from }
}

function feedbackEvent(overrides: Partial<{ org_id: string; crew_member_id: string; feedback_text: string }> = {}) {
  return {
    data: {
      org_id:         'org_1',
      crew_member_id: 'crew_1',
      feedback_text:  'The vacuum is broken',
      ...overrides,
    },
  }
}

describe('notifyCrewFeedback', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends a staff email with the crew member and org name resolved', async () => {
    const supabase = makeSupabase()
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(notifyCrewFeedback, {
      event: feedbackEvent(),
      step:  makeStep(),
    })

    expect(result).toEqual({ notified: true, org_id: 'org_1', crew_member_id: 'crew_1' })
    expect(renderPmAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        heading: 'New crew feedback submitted',
        body:    'The vacuum is broken',
        details: [
          { label: 'Crew member',  value: 'Jamie Crew' },
          { label: 'Organization', value: 'Lake Martin Delivery' },
        ],
      }),
    )
    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to:      'stephen@fieldstay.app',
        subject: 'New crew feedback from Jamie Crew',
      }),
    )
  })

  it('falls back to generic labels when the crew member or org lookup misses (PGRST116, no matching row)', async () => {
    const supabase = makeSupabase({
      crewNameResult: { data: null, error: { code: 'PGRST116', message: 'no rows' } },
      orgNameResult:  { data: null, error: { code: 'PGRST116', message: 'no rows' } },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(notifyCrewFeedback, {
      event: feedbackEvent(),
      step:  makeStep(),
    })

    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({ subject: 'New crew feedback from a crew member' }),
    )
    expect(renderPmAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        details: [
          { label: 'Crew member',  value: null },
          { label: 'Organization', value: null },
        ],
      }),
    )
  })

  it('propagates a genuine crew_members-query failure instead of swallowing it', async () => {
    const supabase = makeSupabase({
      crewNameResult: { data: null, error: { code: '500', message: 'connection reset' } },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(notifyCrewFeedback, { event: feedbackEvent(), step: makeStep() }),
    ).rejects.toThrow(/crew_members query failed/)

    expect(resend.emails.send).not.toHaveBeenCalled()
  })

  it('propagates a genuine organizations-query failure instead of swallowing it', async () => {
    const supabase = makeSupabase({
      orgNameResult: { data: null, error: { code: '500', message: 'connection reset' } },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(notifyCrewFeedback, { event: feedbackEvent(), step: makeStep() }),
    ).rejects.toThrow(/organizations query failed/)

    expect(resend.emails.send).not.toHaveBeenCalled()
  })

  it('throws when Resend rejects the staff notification email, so Inngest retries', async () => {
    const supabase = makeSupabase()
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(resend.emails.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      data:  null,
      error: { name: 'validation_error', message: 'Invalid `to` field' },
    })

    await expect(
      invokeHandler(notifyCrewFeedback, { event: feedbackEvent(), step: makeStep() }),
    ).rejects.toThrow(/Resend error/)
  })
})
