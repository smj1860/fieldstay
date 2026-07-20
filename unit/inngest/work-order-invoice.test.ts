import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn() } },
  FROM:   'FieldStay <noreply@fieldstay.app>',
}))
vi.mock('@/lib/inngest/helpers', () => ({
  getPmEmails: vi.fn(),
}))
vi.mock('@/lib/resend/emails/pm-alert', () => ({
  renderPmAlert: vi.fn(async () => '<html></html>'),
}))

import { handleWorkOrderInvoiceSubmitted } from '@/lib/inngest/functions/work-order-invoice'
import { createServiceClient } from '@/lib/supabase/server'
import { resend } from '@/lib/resend/client'
import { getPmEmails } from '@/lib/inngest/helpers'
import { renderPmAlert } from '@/lib/resend/emails/pm-alert'
import { invokeHandler } from './test-helpers'

// This function has no ledger write and no dedup key of its own — it's a
// pure PM notification. The financial-risk surface here is "does the PM
// actually get told an invoice is waiting to be paid" and "does the amount
// shown match the invoice total", not idempotent record creation.

function makeSupabase(opts: {
  wo?:      { id: string; title: string; vendors: unknown; properties: unknown } | null
  invoice?: { id: string; invoice_number: string; subtotal: number; total: number; status: string } | null
}) {
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.eq     = vi.fn(() => chain)
    chain.single = vi.fn(() => {
      if (table === 'work_orders')          return Promise.resolve({ data: opts.wo ?? null, error: null })
      if (table === 'work_order_invoices')  return Promise.resolve({ data: opts.invoice ?? null, error: null })
      return Promise.resolve({ data: null, error: null })
    })
    return chain
  })
  return { from }
}

function makeStep() {
  return { run: vi.fn((_name: string, cb: () => unknown) => cb()) }
}

function baseEvent() {
  return {
    data: {
      work_order_id: 'wo_1',
      invoice_id:    'inv_1',
      org_id:        'org_1',
      vendor_id:     'vendor_1',
      property_id:   'prop_1',
      total:         475.5,
    },
  }
}

describe('handleWorkOrderInvoiceSubmitted', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emails the PM with the invoice number, property, and formatted amount due', async () => {
    const supabase = makeSupabase({
      wo:      { id: 'wo_1', title: 'Fix water heater', vendors: { name: 'Acme Plumbing' }, properties: { name: 'Lake House' } },
      invoice: { id: 'inv_1', invoice_number: 'INV-100', subtotal: 450, total: 475.5, status: 'submitted' },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getPmEmails as ReturnType<typeof vi.fn>).mockResolvedValue(['pm@fieldstay.app'])

    // Passed as a variable (not an inline object literal) so TS's excess-
    // property check doesn't reject `warn`, which the narrow HandlerContext
    // type omits even though the real Inngest logger — and this function —
    // both use it.
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
    const result = await invokeHandler(handleWorkOrderInvoiceSubmitted, {
      event:  baseEvent(),
      step:   makeStep(),
      logger,
    })

    expect(renderPmAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        heading: 'Invoice ready for payment',
        body:    expect.stringContaining('Acme Plumbing'),
        details: expect.arrayContaining([
          { label: 'Property',       value: 'Lake House' },
          { label: 'Invoice Number', value: 'INV-100' },
          { label: 'Amount Due',     value: '$475.50' },
        ]),
        ctaUrl: expect.stringContaining('inv_1'),
      }),
    )
    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to:      'pm@fieldstay.app',
        subject: expect.stringContaining('INV-100'),
      }),
    )
    expect(result).toEqual({ work_order_id: 'wo_1', invoice_id: 'inv_1', notified: true })
  })

  it('does not send an email when the work order or invoice cannot be found', async () => {
    const supabase = makeSupabase({ wo: null, invoice: null })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getPmEmails as ReturnType<typeof vi.fn>).mockResolvedValue(['pm@fieldstay.app'])

    const warn = vi.fn()
    const logger = { info: vi.fn(), warn, error: vi.fn() }
    await invokeHandler(handleWorkOrderInvoiceSubmitted, {
      event:  baseEvent(),
      step:   makeStep(),
      logger,
    })

    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
  })

  it('does not send an email when the org has no PM email on file', async () => {
    const supabase = makeSupabase({
      wo:      { id: 'wo_1', title: 'Fix water heater', vendors: { name: 'Acme Plumbing' }, properties: { name: 'Lake House' } },
      invoice: { id: 'inv_1', invoice_number: 'INV-100', subtotal: 450, total: 475.5, status: 'submitted' },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)
    ;(getPmEmails as ReturnType<typeof vi.fn>).mockResolvedValue([])

    const warn = vi.fn()
    const logger = { info: vi.fn(), warn, error: vi.fn() }
    await invokeHandler(handleWorkOrderInvoiceSubmitted, {
      event:  baseEvent(),
      step:   makeStep(),
      logger,
    })

    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no PM email'))
  })
})
