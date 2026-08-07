import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  hasOptOutNotice,
  withOptOutNotice,
  SMS_OPT_OUT_NOTICE,
  SMS_TEMPLATE_REGISTRY,
} from '@/lib/sms/template-registry'

// ─────────────────────────────────────────────────────────────────────────────
// Every outbound SMS carries opt-out instructions.
//
// An org override REPLACES the built-in body wholesale — renderSmsBody prefers
// org_sms_templates.body unconditionally — and nothing downstream re-adds
// anything: sendSMS hands the body straight to Telnyx. So the opt-out notice
// that all ten built-in defaults end with was exactly one custom template away
// from disappearing from every message an org sends.
//
// saveOrgSmsTemplate rejects a body without one, but that only covers rows
// written through that action. This file covers the render-time backstop,
// which covers rows written by ANY path — one saved before the rule existed, a
// direct edit in the Supabase dashboard, a future importer.
// ─────────────────────────────────────────────────────────────────────────────

describe('hasOptOutNotice', () => {
  it('accepts the canonical sentence and other real phrasings', () => {
    expect(hasOptOutNotice('Door code is 1234. Reply STOP to opt out.')).toBe(true)
    expect(hasOptOutNotice('Text STOP to unsubscribe')).toBe(true)
    expect(hasOptOutNotice('STOP para cancelar')).toBe(true)
    expect(hasOptOutNotice('Responde STOP.')).toBe(true)
    // Start of string, and immediately before punctuation.
    expect(hasOptOutNotice('STOP to end these')).toBe(true)
  })

  it('rejects a body with no opt-out instruction at all', () => {
    expect(hasOptOutNotice('Good morning from Lake House!')).toBe(false)
    expect(hasOptOutNotice('')).toBe(false)
  })

  it('does not count the word appearing inside ordinary prose', () => {
    // A hyphen is a word boundary, so a plain \bSTOP\b matches "NON-STOP" —
    // a shuttle advertisement would have satisfied the check. Both of these
    // were accepted by the first version of this function.
    expect(hasOptOutNotice('NON-STOP service to the lake!')).toBe(false)
    expect(hasOptOutNotice('The bus STOPS right outside')).toBe(false)
    expect(hasOptOutNotice('Ask about our STOP-AND-GO tour')).toBe(false)
    // Lowercase prose about stopping is not an instruction either.
    expect(hasOptOutNotice('the shuttle stops here; non-stop to town')).toBe(false)
  })
})

describe('withOptOutNotice', () => {
  it('leaves a compliant body exactly as written', () => {
    const body = 'Door code is 1234. Reply STOP to opt out.'
    expect(withOptOutNotice(body)).toBe(body)
  })

  it('does not restate our wording over a PM\'s own phrasing', () => {
    const body = 'Morning! Text STOP to unsubscribe.'
    expect(withOptOutNotice(body)).toBe(body)
  })

  it('appends the notice when one is missing', () => {
    expect(withOptOutNotice('Good morning from Lake House!'))
      .toBe(`Good morning from Lake House! ${SMS_OPT_OUT_NOTICE}`)
  })

  it('does not leave a double space when the body ends in whitespace', () => {
    expect(withOptOutNotice('Good morning!  \n'))
      .toBe(`Good morning! ${SMS_OPT_OUT_NOTICE}`)
  })

  it('returns just the notice for an empty body, rather than a leading space', () => {
    expect(withOptOutNotice('')).toBe(SMS_OPT_OUT_NOTICE)
    expect(withOptOutNotice('   ')).toBe(SMS_OPT_OUT_NOTICE)
  })
})

describe('the built-in defaults', () => {
  it('every registry default already carries an opt-out notice', () => {
    // This is the invariant the override path was silently able to break. If a
    // future default is added without one, the guard above would be enforcing
    // a rule the app itself does not follow.
    const missing = SMS_TEMPLATE_REGISTRY
      .filter((t) => !hasOptOutNotice(t.defaultBody))
      .map((t) => t.key)
    expect(missing).toEqual([])
  })
})

// ── The render-time backstop ────────────────────────────────────────────────

const maybeSingle = vi.fn()

vi.mock('server-only', () => ({}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }),
    }),
  }),
}))

describe('renderSmsBody — a stored override that lacks an opt-out notice', () => {
  beforeEach(() => vi.clearAllMocks())

  it('renders the notice onto it anyway', async () => {
    // The row this simulates cannot be created through saveOrgSmsTemplate any
    // more — it is the one saved before that guard existed, or written
    // straight to the table. The send still has to be compliant.
    maybeSingle.mockResolvedValue({
      data:  { body: 'Good morning from {{property_name}}!' },
      error: null,
    })

    const { renderSmsBody } = await import('@/lib/sms/templates')
    const out = await renderSmsBody('org_1', 'morning_nudge', { property_name: 'Lake House' })

    expect(out).toBe(`Good morning from Lake House! ${SMS_OPT_OUT_NOTICE}`)
  })

  it('leaves a compliant override untouched', async () => {
    maybeSingle.mockResolvedValue({
      data:  { body: 'Morning from {{property_name}}! Text STOP to unsubscribe.' },
      error: null,
    })

    const { renderSmsBody } = await import('@/lib/sms/templates')
    const out = await renderSmsBody('org_1', 'morning_nudge', { property_name: 'Lake House' })

    expect(out).toBe('Morning from Lake House! Text STOP to unsubscribe.')
  })

  it('still falls back to the built-in default when there is no override', async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null })

    const { renderSmsBody } = await import('@/lib/sms/templates')
    const out = await renderSmsBody('org_1', 'morning_nudge', {
      property_name: 'Lake House',
      temperature:   78,
    })

    expect(hasOptOutNotice(out)).toBe(true)
    expect(out).toContain('Lake House')
  })
})
