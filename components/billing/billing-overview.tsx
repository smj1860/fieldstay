'use client'

import Link from 'next/link'
import { useState, useTransition } from 'react'

import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { Button } from '@/components/ui/Button'
import {
  bracketBreakdown,
  monthlyCostCents,
  annualCostCents,
  MAX_SELF_SERVE_PROPERTIES,
} from '@/lib/stripe/brackets'
import { createCheckoutSession, openBillingPortal } from '@/app/(dashboard)/settings/actions'
import type { InvoiceStatus, OrgPlanStatus } from '@/types/database'

export interface BillingInvoiceRow {
  id:            string
  invoiceNumber: string
  status:        InvoiceStatus
  /** Dollars, as stored. See WorkOrderInvoice in types/database.ts. */
  total:         number
  submittedAt:   string
  paidAt:        string | null
  propertyName:  string | null
  vendorName:    string | null
}

type BadgeTone = 'green' | 'amber' | 'red' | 'blue' | 'gold' | 'slate'

const PLAN_STATUS_TONE: Record<OrgPlanStatus, BadgeTone> = {
  trialing:  'blue',
  active:    'green',
  past_due:  'amber',
  cancelled: 'red',
  paused:    'slate',
}

const INVOICE_STATUS_TONE: Record<InvoiceStatus, BadgeTone> = {
  pending_payment:    'amber',
  paid:               'green',
  cancelled:          'slate',
  partially_refunded: 'blue',
  refunded:           'slate',
}

const INVOICE_STATUS_LABEL: Record<InvoiceStatus, string> = {
  pending_payment:    'Awaiting payment',
  paid:               'Paid',
  cancelled:          'Cancelled',
  partially_refunded: 'Partly refunded',
  refunded:           'Refunded',
}

function formatCents(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatDollars(dollars: number): string {
  return dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
}

interface IntervalToggleProps {
  interval:    'monthly' | 'annual'
  onChange:    (next: 'monthly' | 'annual') => void
}

function IntervalToggle({ interval, onChange }: Readonly<IntervalToggleProps>) {
  // A native <fieldset> rather than a div with role="group": the ARIA role
  // is not reliably conveyed on every device, and SonarQube's S6819 flags it
  // for that reason. The legend carries the group's name for a screen reader
  // without taking visual space, and Tailwind's preflight already strips a
  // fieldset's default margin, padding and border, so it lays out as the div
  // did. The aria-pressed buttons and the inset focus ring stay: the toggle
  // in settings-tabs.tsx has neither, and this is the better of the two.
  return (
    <fieldset className="inline-flex rounded-lg border border-themed overflow-hidden">
      <legend className="sr-only">Billing interval</legend>
      {(['monthly', 'annual'] as const).map((option) => (
        <button
          key={option}
          type="button"
          onClick={() => onChange(option)}
          aria-pressed={interval === option}
          className="px-3 py-1.5 text-xs font-semibold transition-colors
                     focus:outline-none focus:ring-2 focus:ring-inset focus:ring-[var(--accent-gold)]"
          style={{
            background: interval === option ? 'var(--accent-gold)' : 'transparent',
            color:      interval === option ? 'var(--bg-base)'     : 'var(--text-muted)',
          }}
        >
          {option === 'monthly' ? 'Monthly' : 'Annual'}
        </button>
      ))}
    </fieldset>
  )
}

interface InvoiceListProps {
  invoices: BillingInvoiceRow[]
  limit:    number
}

function InvoiceList({ invoices, limit }: Readonly<InvoiceListProps>) {
  if (invoices.length === 0) {
    return (
      <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
        No vendor invoices yet. One is created when a vendor completes a work order and submits their bill.
      </p>
    )
  }

  return (
    <>
      <ul className="divide-y divide-[var(--border)]">
        {invoices.map((invoice) => (
          <li key={invoice.id} className="py-3">
            <Link
              href={`/invoices/${invoice.id}`}
              className="flex items-center justify-between gap-3 rounded-lg px-1
                         focus:outline-none focus:ring-2 focus:ring-[var(--accent-gold)]"
            >
              <span className="min-w-0">
                <span className="block text-sm font-medium truncate" style={{ color: 'var(--text-primary)' }}>
                  {invoice.invoiceNumber}
                  {invoice.vendorName !== null && ` · ${invoice.vendorName}`}
                </span>
                <span className="block text-xs truncate" style={{ color: 'var(--text-muted)' }}>
                  {invoice.propertyName ?? 'No property'} · submitted {formatDate(invoice.submittedAt)}
                  {invoice.paidAt !== null && ` · paid ${formatDate(invoice.paidAt)}`}
                </span>
              </span>
              <span className="flex items-center gap-2.5 flex-shrink-0">
                <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                  ${formatDollars(invoice.total)}
                </span>
                <Badge tone={INVOICE_STATUS_TONE[invoice.status]}>
                  {INVOICE_STATUS_LABEL[invoice.status]}
                </Badge>
              </span>
            </Link>
          </li>
        ))}
      </ul>

      {invoices.length === limit && (
        <p className="text-xs mt-3" style={{ color: 'var(--text-muted)' }}>
          Showing the {limit} most recent. Older invoices stay on their work orders.
        </p>
      )}
    </>
  )
}

interface BillingOverviewProps {
  planStatus:            OrgPlanStatus
  trialEndsAt:           string | null
  isSubscribed:          boolean
  activePropertyCount:   number
  invoices:              BillingInvoiceRow[]
  invoiceLimit:          number
  /**
   * Admin and owner only.
   *
   * The Stripe portal lets whoever opens it cancel the subscription, replace
   * the card, and read invoice history carrying billing-address PII, which is
   * why openBillingPortal() is `requireOrgRole(['admin'])` on the server. A
   * 'finance' member reads this page and the invoices below; they do not get
   * the portal. Handing them a narrower portal is possible (Stripe portal
   * CONFIGURATIONS can expose invoice history alone) and is the follow-up if
   * a bookkeeper needs FieldStay's own receipts without an admin fetching
   * them. This flag only hides the buttons — the server gate is the control.
   */
  canManageSubscription: boolean
}

export function BillingOverview({
  planStatus, trialEndsAt, isSubscribed, activePropertyCount,
  invoices, invoiceLimit, canManageSubscription,
}: Readonly<BillingOverviewProps>) {
  const [interval, setInterval]           = useState<'monthly' | 'annual'>('monthly')
  const [checkoutError, setCheckoutError] = useState<string | null>(null)
  const [checkoutPending, startCheckout]  = useTransition()
  const [portalPending, startPortal]      = useTransition()

  const quantity      = activePropertyCount
  const overCeiling   = quantity > MAX_SELF_SERVE_PROPERTIES
  const canPrice      = quantity >= 1 && !overCeiling
  const costForQuantity = interval === 'annual' ? annualCostCents(quantity) : monthlyCostCents(quantity)
  const totalCents    = canPrice ? costForQuantity : null
  const breakdown     = canPrice ? bracketBreakdown(quantity, interval) : []
  const perUnitSuffix = interval === 'annual' ? '/yr' : '/mo'

  function handleCheckout() {
    setCheckoutError(null)
    startCheckout(async () => {
      // createCheckoutSession redirects an org that already has a live
      // subscription to the billing portal instead, so this is safe to call
      // unconditionally: the server decides which one the click means.
      const result = await createCheckoutSession(interval)
      if (result?.redirectUrl) {
        globalThis.location.href = result.redirectUrl
      } else if (result?.error) {
        setCheckoutError(result.error)
      }
    })
  }

  return (
    <div className="max-w-2xl space-y-6">

      <Card>
        <h2 className="text-base font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
          Current plan
        </h2>
        <div className="flex items-center gap-3 flex-wrap">
          <Badge tone={PLAN_STATUS_TONE[planStatus]}>{planStatus.replace(/_/g, ' ')}</Badge>
          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {quantity} {quantity === 1 ? 'property' : 'properties'}
          </span>
        </div>

        {planStatus === 'trialing' && trialEndsAt !== null && (
          <p className="text-sm mt-3" style={{ color: 'var(--text-muted)' }}>
            Your trial ends {formatDate(trialEndsAt)}.
          </p>
        )}
      </Card>

      <Card>
        <div className="flex items-start justify-between gap-3 mb-4 flex-wrap">
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
            What you pay
          </h2>
          <IntervalToggle interval={interval} onChange={setInterval} />
        </div>

        {quantity < 1 && (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Add a property and this shows exactly what it costs, line by line.
          </p>
        )}

        {overCeiling && (
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Above {MAX_SELF_SERVE_PROPERTIES} properties, pricing is negotiated directly. Contact us and
            we will put a number in front of you.
          </p>
        )}

        {canPrice && (
          <>
            <ul className="space-y-2 mb-4">
              {breakdown.map((line) => (
                <li key={line.label} className="flex items-center justify-between gap-3 text-sm">
                  <span style={{ color: 'var(--text-secondary)' }}>
                    {line.label}
                    {line.units > 1 && (
                      <span style={{ color: 'var(--text-muted)' }}>
                        {' '}({line.units} x ${formatCents(line.amountCents)})
                      </span>
                    )}
                  </span>
                  <span style={{ color: 'var(--text-primary)' }}>
                    ${formatCents(line.lineTotalCents)}
                  </span>
                </li>
              ))}
            </ul>

            <div
              className="flex items-center justify-between gap-3 pt-3 text-sm font-semibold"
              style={{ borderTop: '1px solid var(--border)', color: 'var(--text-primary)' }}
            >
              <span>Total</span>
              <span>${formatCents(totalCents!)}{perUnitSuffix}</span>
            </div>
          </>
        )}

        {canManageSubscription && (
          <div className="flex items-center gap-2.5 flex-wrap mt-5">
            <Button
              variant="primary"
              onClick={handleCheckout}
              disabled={checkoutPending || !canPrice}
            >
              {isSubscribed ? 'Manage subscription' : 'Subscribe'}
            </Button>
            {isSubscribed && (
              <Button
                variant="secondary"
                onClick={() => startPortal(async () => { await openBillingPortal() })}
                disabled={portalPending}
              >
                Invoices and payment method
              </Button>
            )}
          </div>
        )}

        {checkoutError !== null && (
          <p className="text-sm mt-3" style={{ color: 'var(--accent-red)' }}>{checkoutError}</p>
        )}
      </Card>

      <Card>
        <h2 className="text-base font-semibold mb-4" style={{ color: 'var(--text-primary)' }}>
          Vendor invoices
        </h2>
        <InvoiceList invoices={invoices} limit={invoiceLimit} />
      </Card>
    </div>
  )
}
