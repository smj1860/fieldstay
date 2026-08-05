'use client'

import { useState, useTransition } from 'react'
import { Loader2, FileText, Check, X } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import { Dialog } from '@/components/ui/Dialog'
import { InlineAlert } from '@/components/ui/InlineAlert'
import { reportError } from '@/lib/observability/report-error'
import { Checkbox } from '@/components/ui/Checkbox'
import { approveQuoteRequest, declineQuoteRequest, sendQuoteRequests } from '@/app/(dashboard)/maintenance/actions'

export interface QuoteVendorOption {
  id:   string
  name: string
}

export interface QuoteLineItem {
  id:          string
  line_type:   string
  description: string
  quantity:    number
  unit:        string | null
  unit_cost:   number
  line_total:  number
  sort_order:  number
}

export interface QuoteSummary {
  id:                     string
  status:                 'pending' | 'submitted' | 'approved' | 'declined' | 'expired'
  vendorName:             string
  vendorSpecialty:        string | null
  quoted_amount:          number | null
  quote_notes:            string | null
  sent_at:                string
  submitted_at:           string | null
  quote_token_expires_at: string
  lineItems:              QuoteLineItem[]
}

const STATUS_TONE: Record<QuoteSummary['status'], 'green' | 'amber' | 'red' | 'blue' | 'slate'> = {
  pending:   'amber',
  submitted: 'blue',
  approved:  'green',
  declined:  'slate',
  expired:   'red',
}

const STATUS_LABEL: Record<QuoteSummary['status'], string> = {
  pending:   'Awaiting response',
  submitted: 'Quote received',
  approved:  'Approved',
  declined:  'Declined',
  expired:   'Link expired',
}

const money = (n: number) =>
  `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const lineCountLabel = (n: number) => `${n} line${n === 1 ? '' : 's'}`

const LINE_TYPE_LABEL: Record<string, string> = {
  labor:         'Labor',
  material:      'Material',
  equipment:     'Equipment',
  subcontractor: 'Sub',
  other:         'Other',
}

/**
 * `quoted_amount` is derived server-side (SUM over the GENERATED ALWAYS
 * line_total column), so it and the lines below it cannot disagree — but only
 * for quotes submitted through the itemized flow. Falling back to the summed
 * lines rather than rendering `$0.00` keeps a legacy lump-sum quote readable.
 */
function quoteTotal(q: QuoteSummary): number {
  if (q.quoted_amount !== null) return q.quoted_amount
  return q.lineItems.reduce((sum, li) => sum + li.line_total, 0)
}

/**
 * The PM's side of the RFQ flow: compare what each vendor quoted, line by
 * line, and accept one or reject it.
 *
 * There was no UI for this at all. Quotes came back, an email and a
 * notification fired, and the PM had nowhere to see them — approveQuoteRequest
 * and declineQuoteRequest had zero callers anywhere in app/, lib/ or
 * components/, which is why both sat in the dead-Server-Action baseline. The
 * approve path had also never executed once (see
 * 20260805191500_approve_quote_completion_token_cast.sql).
 */
export function QuoteComparison({
  workOrderId,
  quotes,
  workOrderStatus,
  vendors,
}: Readonly<{
  workOrderId:     string
  quotes:          QuoteSummary[]
  workOrderStatus: string
  vendors:         QuoteVendorOption[]
}>) {
  const [expanded, setExpanded] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<QuoteSummary | null>(null)
  const [askingMore, setAskingMore] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [pending, startAction] = useTransition()

  if (quotes.length === 0) return null

  const decided     = quotes.find((q) => q.status === 'approved')
  const submitted   = quotes.filter((q) => q.status === 'submitted')
  // Once a quote is approved the work order is assigned and the others are
  // already declined by the same transaction — there is nothing left to act
  // on, so the panel becomes a record rather than a decision.
  const actionable  = !decided && workOrderStatus !== 'completed' && workOrderStatus !== 'cancelled'

  function runApprove(quote: QuoteSummary) {
    setError(null)
    startAction(async () => {
      try {
        const result = await approveQuoteRequest(quote.id)
        setConfirming(null)
        if (result.error) setError(result.error)
      } catch (err) {
        reportError(err, { site: 'component.workOrders.QuoteComparison.approve' })
        setConfirming(null)
        setError('Could not approve the quote. Please try again.')
      }
    })
  }

  function runDecline(quote: QuoteSummary) {
    setError(null)
    startAction(async () => {
      try {
        const result = await declineQuoteRequest(quote.id)
        if (result.error) setError(result.error)
      } catch (err) {
        reportError(err, { site: 'component.workOrders.QuoteComparison.decline' })
        setError('Could not decline the quote. Please try again.')
      }
    })
  }

  function runSendMore() {
    setError(null)
    setNotice(null)
    const vendorIds = [...picked]
    startAction(async () => {
      try {
        const result = await sendQuoteRequests(workOrderId, vendorIds)
        setAskingMore(false)
        setPicked(new Set())
        if (result.error) { setError(result.error); return }
        setNotice(`Sent ${result.sent} quote request${result.sent === 1 ? '' : 's'}.`)
      } catch (err) {
        reportError(err, { site: 'component.workOrders.QuoteComparison.sendMore' })
        setAskingMore(false)
        setError('Could not send the quote requests. Please try again.')
      }
    })
  }

  function togglePicked(id: string) {
    setPicked((prev) => {
      const next = new Set(prev)
      // Set.delete returns a boolean; Set.add returns the SET, which is always
      // truthy — branching on add()'s return is a bug that reads fine.
      if (!next.delete(id)) next.add(id)
      return next
    })
  }

  return (
    <Card className="mt-4">
      <div className="flex items-center gap-2 mb-1">
        <FileText className="w-4 h-4" style={{ color: 'var(--accent-gold)' }} />
        <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
          Quotes
        </h2>
        <span className="text-xs ml-auto" style={{ color: 'var(--text-muted)' }}>
          {submitted.length} of {quotes.length} received
        </span>
      </div>
      <p className="text-xs mb-4" style={{ color: 'var(--text-muted)' }}>
        {decided
          ? 'This work order was assigned from the approved quote. Its line items were copied onto the work order.'
          : 'Approving a quote assigns that vendor and copies their line items onto this work order. Every other quote is declined at the same time.'}
      </p>

      {error  && <InlineAlert tone="error"   className="mb-4">{error}</InlineAlert>}
      {notice && <InlineAlert tone="success" className="mb-4">{notice}</InlineAlert>}

      <ul className="space-y-2">
        {quotes.map((q) => {
          const total   = quoteTotal(q)
          const isOpen  = expanded === q.id
          const canAct  = actionable && q.status === 'submitted'
          return (
            <li
              key={q.id}
              className="rounded-lg"
              style={{ border: '1px solid var(--border)', background: 'var(--bg-canvas)' }}
            >
              <div className="flex items-center gap-3 px-3 py-2.5 flex-wrap">
                <div className="min-w-0 flex-1">
                  <p className="text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                    {q.vendorName}
                  </p>
                  <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
                    {q.submitted_at
                      ? `Quoted ${new Date(q.submitted_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
                      : `Sent ${new Date(q.sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`}
                  </p>
                </div>

                <Badge tone={STATUS_TONE[q.status]}>{STATUS_LABEL[q.status]}</Badge>

                <span
                  className="text-sm font-semibold tabular-nums"
                  style={{ color: q.status === 'submitted' || q.status === 'approved' ? 'var(--text-primary)' : 'var(--text-muted)' }}
                >
                  {q.status === 'pending' ? '—' : money(total)}
                </span>

                {q.lineItems.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setExpanded(isOpen ? null : q.id)}
                    aria-expanded={isOpen}
                    className="text-xs underline underline-offset-2 focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)] rounded"
                    style={{ color: 'var(--text-muted)' }}
                  >
                    {isOpen ? 'Hide' : lineCountLabel(q.lineItems.length)}
                  </button>
                )}

                {canAct && (
                  <div className="flex gap-2">
                    <Button
                      variant="secondary"
                      className="text-xs px-2 py-1 flex items-center gap-1"
                      disabled={pending}
                      onClick={() => runDecline(q)}
                    >
                      <X className="w-3 h-3" /> Reject
                    </Button>
                    <Button
                      variant="primary"
                      className="text-xs px-2 py-1 flex items-center gap-1"
                      disabled={pending}
                      onClick={() => setConfirming(q)}
                    >
                      <Check className="w-3 h-3" /> Accept
                    </Button>
                  </div>
                )}
              </div>

              {isOpen && (
                <div className="px-3 pb-3">
                  <table className="w-full text-xs">
                    <thead>
                      <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <th className="text-left py-1.5 font-medium" style={{ color: 'var(--text-muted)' }}>Type</th>
                        <th className="text-left py-1.5 font-medium" style={{ color: 'var(--text-muted)' }}>Description</th>
                        <th className="text-right py-1.5 font-medium" style={{ color: 'var(--text-muted)' }}>Qty</th>
                        <th className="text-right py-1.5 font-medium" style={{ color: 'var(--text-muted)' }}>Unit</th>
                        <th className="text-right py-1.5 font-medium" style={{ color: 'var(--text-muted)' }}>Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {q.lineItems.map((li) => (
                        <tr key={li.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                          <td className="py-1.5" style={{ color: 'var(--text-muted)' }}>
                            {LINE_TYPE_LABEL[li.line_type] ?? li.line_type}
                          </td>
                          <td className="py-1.5" style={{ color: 'var(--text-secondary)' }}>{li.description}</td>
                          <td className="py-1.5 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                            {li.quantity}{li.unit ? ` ${li.unit}` : ''}
                          </td>
                          <td className="py-1.5 text-right tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                            {money(li.unit_cost)}
                          </td>
                          <td className="py-1.5 text-right tabular-nums font-medium" style={{ color: 'var(--text-primary)' }}>
                            {money(li.line_total)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {q.quote_notes && (
                    <p className="text-xs mt-2 italic" style={{ color: 'var(--text-muted)' }}>
                      “{q.quote_notes}”
                    </p>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {/* The recovery path for a partial send (createWorkOrder tells the PM to
          come here), and the way to add a bid when the ones that came back
          were all rejected. sendQuoteRequests skips any vendor that already
          holds a live RFQ, so re-picking one is safe rather than a duplicate
          email. */}
      {actionable && vendors.length > 0 && (
        <div className="mt-4 pt-3" style={{ borderTop: '1px solid var(--border-subtle)' }}>
          <Button
            variant="secondary"
            className="text-xs px-2 py-1"
            disabled={pending}
            onClick={() => setAskingMore(true)}
          >
            Request more quotes
          </Button>
        </div>
      )}

      <Dialog
        open={askingMore}
        onClose={() => { if (!pending) setAskingMore(false) }}
        title="Request more quotes"
        mobileSheet
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={() => setAskingMore(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={runSendMore}
              disabled={pending || picked.size === 0}
              className="flex items-center gap-1.5"
            >
              {pending && <Loader2 className="w-4 h-4 animate-spin" />}
              {pending ? 'Sending…' : `Send ${picked.size || ''}`.trim()}
            </Button>
          </div>
        }
      >
        <p className="text-sm mb-3" style={{ color: 'var(--text-secondary)' }}>
          Each vendor gets their own quote link, valid for 14 days. Vendors who
          already have an open request on this work order are skipped.
        </p>
        <ul className="space-y-1">
          {vendors.map((v) => (
            <li key={v.id}>
              <label
                htmlFor={`quote-vendor-${v.id}`}
                className="flex items-center gap-2 py-1.5 px-2 rounded cursor-pointer"
                style={{ color: 'var(--text-secondary)' }}
              >
                <Checkbox
                  id={`quote-vendor-${v.id}`}
                  checked={picked.has(v.id)}
                  onChange={() => togglePicked(v.id)}
                />
                <span className="text-sm">{v.name}</span>
              </label>
            </li>
          ))}
        </ul>
      </Dialog>

      <Dialog
        open={confirming !== null}
        onClose={() => { if (!pending) setConfirming(null) }}
        title="Approve this quote?"
        mobileSheet
        footer={
          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={() => setConfirming(null)} disabled={pending}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => confirming && runApprove(confirming)}
              disabled={pending}
              className="flex items-center gap-1.5"
            >
              {pending && <Loader2 className="w-4 h-4 animate-spin" />}
              {pending ? 'Approving…' : 'Approve and assign'}
            </Button>
          </div>
        }
      >
        {confirming && (
          <div className="space-y-2">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              <strong style={{ color: 'var(--text-primary)' }}>{confirming.vendorName}</strong> will be
              assigned to this work order at{' '}
              <strong style={{ color: 'var(--text-primary)' }}>{money(quoteTotal(confirming))}</strong>,
              and their {confirming.lineItems.length} line item
              {confirming.lineItems.length === 1 ? '' : 's'} will be copied onto it.
            </p>
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
              Every other quote on this work order will be declined. This cannot be undone.
            </p>
          </div>
        )}
      </Dialog>
    </Card>
  )
}
