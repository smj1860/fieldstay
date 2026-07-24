import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn() } },
  FROM:   'FieldStay <noreply@fieldstay.app>',
}))
vi.mock('@/lib/resend/emails/vendor-invoice-paid', () => ({
  renderVendorInvoicePaidEmail: vi.fn(async () => '<html></html>'),
}))

import { handleWorkOrderInvoicePaid } from '@/lib/inngest/functions/work-order-invoice-paid'
import { createServiceClient } from '@/lib/supabase/server'
import { resend } from '@/lib/resend/client'
import { renderVendorInvoicePaidEmail } from '@/lib/resend/emails/vendor-invoice-paid'
import { invokeHandler } from './test-helpers'

// This function's dedup key is the Resend `idempotencyKey` passed alongside
// the send call (`work-order-invoice-paid-${invoice_id}`), not a DB upsert —
// Resend itself de-duplicates a retried send against that key. It also has
// deliberate, commented-in-source logic distinguishing PGRST116 ("no row" —
// a genuine not-found, logged and skipped) from any other query error
// (a real failure that must throw and retry, not be silently treated as
// "not found").

interface WoRow { id: string; title: string; wo_number: string | null; vendors: unknown; properties: unknown }
interface InvoiceRow { id: string; invoice_number: string; total: number }

function makeSupabase(opts: {
  woResult?:      { data: WoRow | null; error: { code: string; message: string } | null }
  invoiceResult?: { data: InvoiceRow | null; error: { code: string; message: string } | null }
  orgName?:       string | null
}) {
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.eq     = vi.fn(() => chain)
    chain.single = vi.fn(() => {
      if (table === 'work_orders')          return Promise.resolve(opts.woResult ?? { data: null, error: null })
      if (table === 'work_order_invoices')  return Promise.resolve(opts.invoiceResult ?? { data: null, error: null })
      if (table === 'organizations')        return Promise.resolve({ data: { name: opts.orgName ?? 'FieldStay Co' }, error: null })
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
      property_id:   'prop_1',
      amount_paid:   475.5,
    },
  }
}

describe('handleWorkOrderInvoicePaid', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('notifies the vendor with the paid amount and a per-invoice idempotency key', async () => {
    const supabase = makeSupabase({
      woResult: {
        data: {
          id: 'wo_1', title: 'Fix water heater', wo_number: 'WO-42',
          vendors: { name: 'Acme Plumbing', email: 'billing@acme.test' },
          properties: { name: 'Lake House' },
        },
        error: null,
      },
      invoiceResult: { data: { id: 'inv_1', invoice_number: 'INV-100', total: 475.5 }, error: null },
      orgName: 'Lakefront Rentals',
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(handleWorkOrderInvoicePaid, {
      event:  baseEvent(),
      step:   makeStep(),
      logger: { info: vi.fn(), error: vi.fn() },
    })

    expect(renderVendorInvoicePaidEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        vendorName:    'Acme Plumbing',
        orgName:       'Lakefront Rentals',
        woTitle:       'Fix water heater',
        woNumber:      'WO-42',
        propertyName:  'Lake House',
        invoiceNumber: 'INV-100',
        amountPaid:    475.5,
      }),
    )
    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to:      'billing@acme.test',
        subject: expect.stringContaining('$475.50'),
      }),
      { idempotencyKey: 'work-order-invoice-paid-inv_1' },
    )
    expect(result).toEqual({ work_order_id: 'wo_1', invoice_id: 'inv_1', notified: true })
  })

  it('treats PGRST116 (no matching row) as a genuine not-found and skips silently', async () => {
    const supabase = makeSupabase({
      woResult:      { data: null, error: { code: 'PGRST116', message: 'no rows' } },
      invoiceResult: { data: { id: 'inv_1', invoice_number: 'INV-100', total: 475.5 }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const warn = vi.fn()
    const logger = { info: vi.fn(), warn, error: vi.fn() }
    const result = await invokeHandler(handleWorkOrderInvoicePaid, {
      event:  baseEvent(),
      step:   makeStep(),
      logger,
    })

    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalled()
    expect(result).toEqual({ work_order_id: 'wo_1', invoice_id: 'inv_1', notified: true })
  })

  it('throws on a genuine work_orders query failure instead of treating it as not-found', async () => {
    const supabase = makeSupabase({
      woResult:      { data: null, error: { code: '57014', message: 'statement timeout' } },
      invoiceResult: { data: { id: 'inv_1', invoice_number: 'INV-100', total: 475.5 }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(handleWorkOrderInvoicePaid, {
        event:  baseEvent(),
        step:   makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      }),
    ).rejects.toThrow(/statement timeout/)

    expect(resend.emails.send).not.toHaveBeenCalled()
  })

  it('throws on a genuine work_order_invoices query failure instead of treating it as not-found', async () => {
    const supabase = makeSupabase({
      woResult: {
        data: {
          id: 'wo_1', title: 'Fix water heater', wo_number: 'WO-42',
          vendors: { name: 'Acme Plumbing', email: 'billing@acme.test' },
          properties: { name: 'Lake House' },
        },
        error: null,
      },
      invoiceResult: { data: null, error: { code: '53300', message: 'too many connections' } },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(handleWorkOrderInvoicePaid, {
        event:  baseEvent(),
        step:   makeStep(),
        logger: { info: vi.fn(), error: vi.fn() },
      }),
    ).rejects.toThrow(/too many connections/)

    expect(resend.emails.send).not.toHaveBeenCalled()
  })

  it('does not send an email when the vendor has no email on file', async () => {
    const supabase = makeSupabase({
      woResult: {
        data: {
          id: 'wo_1', title: 'Fix water heater', wo_number: 'WO-42',
          vendors: { name: 'Acme Plumbing', email: null },
          properties: { name: 'Lake House' },
        },
        error: null,
      },
      invoiceResult: { data: { id: 'inv_1', invoice_number: 'INV-100', total: 475.5 }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const warn = vi.fn()
    const logger = { info: vi.fn(), warn, error: vi.fn() }
    await invokeHandler(handleWorkOrderInvoicePaid, {
      event:  baseEvent(),
      step:   makeStep(),
      logger,
    })

    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no vendor email'))
  })
})
