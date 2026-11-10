import { describe, it, expect, vi, beforeEach } from 'vitest'

const getUserById = vi.fn()
let tables: Record<string, { data: unknown; error: unknown }> = {}

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(() => ({
    from: (table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const chain: any = {}
      for (const m of ['select', 'eq']) chain[m] = () => chain
      chain.maybeSingle = () => Promise.resolve(tables[table])
      return chain
    },
    auth: { admin: { getUserById: (...a: unknown[]) => getUserById(...a) } },
  })),
}))

const emailSend = vi.fn()
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: (...a: unknown[]) => emailSend(...a) } },
  FROM: 'FieldStay <noreply@example.test>',
  sendWithTimeout: (fn: () => Promise<unknown>) => fn(),
}))
const renderPmAlert = vi.fn(async (props: { body: string }) => `<html>${props.body}</html>`)
vi.mock('@/lib/resend/emails/pm-alert', () => ({ renderPmAlert: (p: { body: string }) => renderPmAlert(p) }))
const reportError = vi.fn()
vi.mock('@/lib/observability/report-error', () => ({ reportError: (...a: unknown[]) => reportError(...a) }))

import { notifySupportStaffReply } from '@/lib/inngest/functions/support-staff-reply-notify'
import { invokeHandler } from './test-helpers'

// ============================================================================
// A staff reply is saved and shown live in the customer's chat. A customer who
// is logged out never sees that push, so this email is the only way they learn
// a reply exists. It must send for a real staff reply, and must not send for
// anything else.
// ============================================================================

const step = { run: async (_n: string, cb: () => unknown) => cb() }
const event = { data: { conversationId: 'c1', messageId: 'msg-1' } }

function stage(opts: { role?: string; content?: string } = {}) {
  tables = {
    support_messages:      { data: { role: opts.role ?? 'human', content: opts.content ?? 'Welcome aboard!' }, error: null },
    support_conversations: { data: { user_id: 'user-1' }, error: null },
  }
}

describe('notifySupportStaffReply', () => {
  beforeEach(() => {
    getUserById.mockReset(); emailSend.mockReset(); reportError.mockReset(); renderPmAlert.mockClear()
    getUserById.mockResolvedValue({ data: { user: { email: 'customer@example.test' } }, error: null })
    stage()
  })

  it('emails the customer the reply, once per message', async () => {
    const result = await invokeHandler(notifySupportStaffReply, { event, step })
    expect(result).toEqual({ sent: true })
    expect(emailSend).toHaveBeenCalledTimes(1)
    const [payload, options] = emailSend.mock.calls[0] as [Record<string, string>, Record<string, string>]
    expect(payload.to).toBe('customer@example.test')
    expect(payload.subject).toBe('FieldStay Support replied to your message')
    expect(options.idempotencyKey).toBe('support-staff-reply-msg-1')
    expect(renderPmAlert).toHaveBeenCalledWith(expect.objectContaining({ body: 'Welcome aboard!' }))
  })

  it('writes customer-facing copy without an em dash', async () => {
    await invokeHandler(notifySupportStaffReply, { event, step })
    const props = renderPmAlert.mock.calls[0]![0] as Record<string, string>
    const copy = [props.heading, props.note, props.ctaLabel, (emailSend.mock.calls[0]![0] as Record<string, string>).subject].join(' ')
    expect(copy).not.toContain('—')
  })

  it('does not email for a message that is not a staff reply', async () => {
    stage({ role: 'assistant' })
    expect(await invokeHandler(notifySupportStaffReply, { event, step })).toEqual({ skipped: 'nothing_to_send' })
    expect(emailSend).not.toHaveBeenCalled()
  })

  it('skips quietly when the message or conversation was deleted after the event was sent', async () => {
    tables.support_messages = { data: null, error: null }
    expect(await invokeHandler(notifySupportStaffReply, { event, step })).toEqual({ skipped: 'nothing_to_send' })
    expect(emailSend).not.toHaveBeenCalled()
  })

  it('does not report sent when the customer has no email on file', async () => {
    getUserById.mockResolvedValue({ data: { user: { email: null } }, error: null })
    expect(await invokeHandler(notifySupportStaffReply, { event, step })).toEqual({ sent: false, reason: 'no_email' })
    expect(emailSend).not.toHaveBeenCalled()
  })

  it('throws when the customer lookup fails, so Inngest retries instead of reporting success', async () => {
    getUserById.mockResolvedValue({ data: null, error: new Error('auth down') })
    await expect(invokeHandler(notifySupportStaffReply, { event, step })).rejects.toThrow(/Could not look up/)
    expect(reportError).toHaveBeenCalled()
    expect(emailSend).not.toHaveBeenCalled()
  })

  it('throws on a failed read so a database outage is not mistaken for nothing to send', async () => {
    tables.support_conversations = { data: null, error: { message: 'down', code: '57P01' } }
    await expect(invokeHandler(notifySupportStaffReply, { event, step })).rejects.toThrow()
    expect(emailSend).not.toHaveBeenCalled()
  })

  it('cuts a very long reply down for the email', async () => {
    stage({ content: 'a'.repeat(5000) })
    await invokeHandler(notifySupportStaffReply, { event, step })
    const body = (renderPmAlert.mock.calls[0]![0] as { body: string }).body
    expect(body.length).toBeLessThan(1600)
    expect(body.endsWith('...')).toBe(true)
  })
})
