import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Controllable Redis mock for the nudge-budget tests below. hoisted() so the
// vi.mock factory (which vitest hoists above imports) can close over them.
const { mockIncr, mockExpire } = vi.hoisted(() => ({
  mockIncr:   vi.fn(async () => 1),
  mockExpire: vi.fn(async () => undefined),
}))
vi.mock('@upstash/redis', () => ({
  Redis: class {
    incr   = mockIncr
    expire = mockExpire
  },
}))

import { sendSMS } from '@/lib/sms/telnyx'

// CLAUDE.md: SMS_ENABLED is the single most safety-critical flag in this
// codebase — every SMS send must be gated on it. These tests prove sendSMS()
// actually suppresses the real Telnyx API call when it isn't exactly 'true',
// and actually proceeds (with the correct request shape) when it is.
describe('sendSMS — SMS_ENABLED gate', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('suppresses the send and never calls fetch when SMS_ENABLED is unset', async () => {
    delete process.env.SMS_ENABLED
    const fetchSpy = vi.spyOn(global, 'fetch')

    const result = await sendSMS('+15551234567', 'Door code: 1234')

    expect(result).toEqual({ sent: false, reason: 'SMS_ENABLED is not true' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('suppresses the send when SMS_ENABLED is "false"', async () => {
    process.env.SMS_ENABLED = 'false'
    const fetchSpy = vi.spyOn(global, 'fetch')

    const result = await sendSMS('+15551234567', 'Door code: 1234')

    expect(result).toEqual({ sent: false, reason: 'SMS_ENABLED is not true' })
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('suppresses the send for any value other than the exact string "true" (e.g. "1", "True")', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')

    for (const value of ['1', 'True', 'TRUE', 'yes']) {
      process.env.SMS_ENABLED = value
      const result = await sendSMS('+15551234567', 'Door code: 1234')
      expect(result).toEqual({ sent: false, reason: 'SMS_ENABLED is not true' })
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('never logs the phone number or message body when disabled — only a redacted last-4 + length', async () => {
    delete process.env.SMS_ENABLED
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const body = 'Door code: 4321 — do not share'
    await sendSMS('+15559876543', body)

    expect(logSpy).toHaveBeenCalledWith('[sms:disabled]', { to: '***6543', bodyLength: body.length })
    const loggedArgs = JSON.stringify(logSpy.mock.calls)
    expect(loggedArgs).not.toContain('15559876543')
    expect(loggedArgs).not.toContain('4321')
  })

  it('proceeds and calls the real Telnyx API when SMS_ENABLED is exactly "true"', async () => {
    process.env.SMS_ENABLED               = 'true'
    process.env.TELNYX_API_KEY            = 'test-api-key'
    process.env.TELNYX_MESSAGING_PROFILE_ID = 'test-profile-id'
    process.env.TELNYX_FROM_NUMBER        = '+15550001111'

    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 'msg_1' } }), { status: 200 })
    )

    const result = await sendSMS('+15551234567', 'Door code: 1234')

    expect(result).toEqual({ sent: true })
    expect(fetchSpy).toHaveBeenCalledWith(
      'https://api.telnyx.com/v2/messages',
      expect.objectContaining({
        method:  'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-api-key',
        }),
      })
    )
    const [, options] = fetchSpy.mock.calls[0]
    const sentBody = JSON.parse(options?.body as string)
    expect(sentBody).toEqual({
      from:                 '+15550001111',
      to:                   '+15551234567',
      text:                 'Door code: 1234',
      messaging_profile_id: 'test-profile-id',
    })
  })

  it('throws when enabled but required Telnyx env vars are missing', async () => {
    process.env.SMS_ENABLED = 'true'
    delete process.env.TELNYX_API_KEY
    delete process.env.TELNYX_MESSAGING_PROFILE_ID
    delete process.env.TELNYX_FROM_NUMBER
    const fetchSpy = vi.spyOn(global, 'fetch')

    await expect(sendSMS('+15551234567', 'Door code: 1234')).rejects.toThrow(
      'Telnyx SMS env vars are not configured'
    )
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('throws with the Telnyx status and body when the API call fails', async () => {
    process.env.SMS_ENABLED               = 'true'
    process.env.TELNYX_API_KEY            = 'test-api-key'
    process.env.TELNYX_MESSAGING_PROFILE_ID = 'test-profile-id'
    process.env.TELNYX_FROM_NUMBER        = '+15550001111'

    vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response('{"errors":[{"detail":"Invalid \\"to\\" number"}]}', { status: 422 })
    )

    await expect(sendSMS('+15551234567', 'Door code: 1234')).rejects.toThrow(
      /Telnyx send failed: 422/
    )
  })
})

describe('sendSMS — daily nudge budget', () => {
  const ORIGINAL_ENV = { ...process.env }

  beforeEach(() => {
    vi.restoreAllMocks()
    mockIncr.mockReset().mockResolvedValue(1)
    mockExpire.mockReset().mockResolvedValue(undefined)
    process.env.SMS_ENABLED                 = 'true'
    process.env.TELNYX_API_KEY              = 'test-api-key'
    process.env.TELNYX_MESSAGING_PROFILE_ID = 'test-profile-id'
    process.env.TELNYX_FROM_NUMBER          = '+15550001111'
    delete process.env.SMS_DAILY_NUDGE_BUDGET
  })

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV }
  })

  it('sends a nudge while the daily budget has headroom', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 'msg_1' } }), { status: 200 })
    )
    mockIncr.mockResolvedValue(42)

    const result = await sendSMS('+15551234567', 'Good morning!', { category: 'nudge' })

    expect(result).toEqual({ sent: true })
    expect(mockIncr).toHaveBeenCalledTimes(1)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('refuses a nudge once the daily budget is exhausted — no Telnyx call', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    const warnSpy  = vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.SMS_DAILY_NUDGE_BUDGET = '100'
    mockIncr.mockResolvedValue(101)

    const result = await sendSMS('+15551234567', 'Good morning!', { category: 'nudge' })

    expect(result).toEqual({ sent: false, reason: 'daily nudge budget exhausted' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('fails CLOSED when Redis is unreachable — a cache outage must not disable the spend ceiling', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch')
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockIncr.mockRejectedValue(new Error('redis down'))

    const result = await sendSMS('+15551234567', 'Good morning!', { category: 'nudge' })

    expect(result).toEqual({ sent: false, reason: 'nudge budget check unavailable' })
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('transactional sends never consult the budget — door codes go out even if Redis is down', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { id: 'msg_1' } }), { status: 200 })
    )
    mockIncr.mockRejectedValue(new Error('redis down'))

    const result = await sendSMS('+15551234567', 'Door code: 1234')

    expect(result).toEqual({ sent: true })
    expect(mockIncr).not.toHaveBeenCalled()
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('does not consume budget while SMS_ENABLED is off — the gate runs first', async () => {
    process.env.SMS_ENABLED = 'false'

    const result = await sendSMS('+15551234567', 'Good morning!', { category: 'nudge' })

    expect(result).toEqual({ sent: false, reason: 'SMS_ENABLED is not true' })
    expect(mockIncr).not.toHaveBeenCalled()
  })
})
