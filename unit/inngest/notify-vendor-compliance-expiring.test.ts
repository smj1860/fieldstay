import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(),
}))
vi.mock('@/lib/resend/client', () => ({
  resend: { emails: { send: vi.fn() } },
  FROM:   'FieldStay <noreply@fieldstay.app>',
}))
vi.mock('@/lib/resend/emails/vendor-compliance-nudge', () => ({
  renderVendorComplianceNudgeEmail: vi.fn(async () => '<html></html>'),
}))

import { notifyVendorComplianceExpiring } from '@/lib/inngest/functions/notify-vendor-compliance-expiring'
import { createServiceClient } from '@/lib/supabase/server'
import { resend } from '@/lib/resend/client'
import { renderVendorComplianceNudgeEmail } from '@/lib/resend/emails/vendor-compliance-nudge'
import { invokeHandler } from './test-helpers'

function makeSupabase(opts: {
  vendor?: { data: { email: string } | null; error: { code: string; message: string } | null }
  org?:    { data: { name: string } | null; error: { code: string; message: string } | null }
}) {
  const from = vi.fn((table: string) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const chain: any = {}
    chain.select = vi.fn(() => chain)
    chain.eq     = vi.fn(() => chain)
    chain.single = vi.fn(() => {
      if (table === 'vendors')       return Promise.resolve(opts.vendor ?? { data: null, error: null })
      if (table === 'organizations') return Promise.resolve(opts.org ?? { data: null, error: null })
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
      document_id:   'doc_1',
      vendor_id:     'v1',
      org_id:        'org_1',
      document_type: 'coi',
      vendor_name:   'Acme Plumbing',
      expiry_date:   '2026-08-01',
      days_until:    10,
    },
  }
}

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }

describe('notifyVendorComplianceExpiring', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('emails the vendor a compliance nudge using an idempotency key scoped to the document', async () => {
    const supabase = makeSupabase({
      vendor: { data: { email: 'vendor@acme.com' }, error: null },
      org:    { data: { name: 'Lake Martin PM' }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const result = await invokeHandler(notifyVendorComplianceExpiring, {
      event:  baseEvent(),
      step:   makeStep(),
      logger,
    })

    expect(renderVendorComplianceNudgeEmail).toHaveBeenCalledWith({
      vendorName: 'Acme Plumbing',
      orgName:    'Lake Martin PM',
      docLabel:   'Certificate of Insurance',
      expiryDate: '2026-08-01',
      daysUntil:  10,
    })

    expect(resend.emails.send).toHaveBeenCalledWith(
      expect.objectContaining({
        to:      'vendor@acme.com',
        subject: expect.stringContaining('Certificate of Insurance'),
      }),
      { idempotencyKey: 'compliance-expiry-vendor-doc_1' },
    )

    expect(result).toEqual({ document_id: 'doc_1', notified: true })
  })

  it('falls back to the raw document_type label and "Your property manager" org name when unmapped/missing', async () => {
    const supabase = makeSupabase({
      vendor: { data: { email: 'vendor@acme.com' }, error: null },
      org:    { data: null, error: { code: 'PGRST116', message: 'no rows' } },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await invokeHandler(notifyVendorComplianceExpiring, {
      event: { data: { ...baseEvent().data, document_type: 'some_unmapped_type' } },
      step:  makeStep(),
      logger,
    })

    expect(renderVendorComplianceNudgeEmail).toHaveBeenCalledWith(
      expect.objectContaining({ docLabel: 'some_unmapped_type', orgName: 'Your property manager' }),
    )
  })

  it('does not send an email (but does not error) when the vendor has no email on file', async () => {
    const supabase = makeSupabase({
      vendor: { data: null, error: { code: 'PGRST116', message: 'no rows' } },
      org:    { data: { name: 'Lake Martin PM' }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    const warn = vi.fn()
    // Passed as a variable (not an inline object literal) so TS's
    // excess-property check doesn't reject `warn`, which the narrow
    // HandlerContext type omits even though the real Inngest logger — and
    // this function — both use it (see work-order-invoice.test.ts).
    const scopedLogger = { info: vi.fn(), warn, error: vi.fn() }
    const result = await invokeHandler(notifyVendorComplianceExpiring, {
      event:  baseEvent(),
      step:   makeStep(),
      logger: scopedLogger,
    })

    expect(resend.emails.send).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('v1'))
    // The function's outer return is unconditional — it reports notified:true
    // even when the inner step short-circuited on a missing vendor email.
    // See final report: this looks like a metrics-accuracy quirk, not a
    // compliance-safety bug (nothing downstream reads this return value),
    // so it is documented here rather than "fixed" out from under the source.
    expect(result).toEqual({ document_id: 'doc_1', notified: true })
  })

  it('propagates a genuine vendors-query failure instead of swallowing it', async () => {
    const supabase = makeSupabase({
      vendor: { data: null, error: { code: '500', message: 'connection reset' } },
      org:    { data: { name: 'Lake Martin PM' }, error: null },
    })
    ;(createServiceClient as ReturnType<typeof vi.fn>).mockReturnValue(supabase)

    await expect(
      invokeHandler(notifyVendorComplianceExpiring, { event: baseEvent(), step: makeStep(), logger }),
    ).rejects.toThrow(/vendors query failed/)

    expect(resend.emails.send).not.toHaveBeenCalled()
  })
})
