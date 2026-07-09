import Link from 'next/link'
import { Receipt } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { formatDate } from '@/lib/utils'
import type { InvoiceStatus } from '@/types/database'

export interface InvoiceHistoryRow {
  id:            string
  workOrderId:   string
  woTitle:       string
  woNumber:      string | null
  invoiceNumber: string
  status:        InvoiceStatus
  total:         number
  submittedAt:   string
  paidAt:        string | null
  // Vendor name (shown on the property page) or property name (shown on
  // the vendor page) — whichever context the parent page doesn't already
  // make obvious from the page header.
  contextLabel:  string | null
}

const STATUS_TONE: Record<InvoiceStatus, 'green' | 'amber' | 'slate'> = {
  paid:            'green',
  pending_payment: 'amber',
  cancelled:       'slate',
}

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  paid:            'Paid',
  pending_payment: 'Pending',
  cancelled:       'Cancelled',
}

export function VendorInvoiceHistory({
  invoices,
  title = 'Invoices',
}: Readonly<{
  invoices: InvoiceHistoryRow[]
  title?:   string
}>) {
  const paidInvoices = invoices.filter((inv) => inv.status === 'paid')
  const totalPaid    = paidInvoices.reduce((sum, inv) => sum + inv.total, 0)

  return (
    <Card className="mb-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-primary-themed flex items-center gap-2">
          <Receipt className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
          {title}
        </h3>
      </div>

      {invoices.length === 0 ? (
        <p className="text-sm text-muted-themed text-center py-6">
          No invoices yet. Invoices are generated once a vendor submits line items through their portal.
        </p>
      ) : (
        <>
          <div className="flex gap-6 mb-4 pb-4 border-b border-themed text-sm">
            <div>
              <p className="text-xs text-muted-themed uppercase tracking-wide">Total Paid</p>
              <p className="text-2xl font-bold" style={{ color: 'var(--accent-gold)' }}>
                ${totalPaid.toFixed(0)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-themed uppercase tracking-wide">Invoices</p>
              <p className="text-2xl font-bold text-primary-themed">{invoices.length}</p>
            </div>
          </div>

          <div className="divide-y divide-themed">
            {invoices.map((inv) => (
              <Link
                key={inv.id}
                href={`/maintenance/${inv.workOrderId}`}
                className="flex items-center justify-between py-3 hover:bg-raised-themed rounded-lg px-2 -mx-2 transition-colors"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-primary-themed truncate">{inv.woTitle}</span>
                    <Badge tone={STATUS_TONE[inv.status]} className="text-xs">{STATUS_LABEL[inv.status]}</Badge>
                  </div>
                  <p className="text-xs text-muted-themed mt-0.5">
                    Invoice #{inv.invoiceNumber}
                    {inv.contextLabel && ` · ${inv.contextLabel}`}
                    {inv.woNumber && ` · WO ${inv.woNumber}`}
                  </p>
                </div>
                <div className="flex flex-col items-end flex-shrink-0 ml-3 text-xs text-muted-themed">
                  <span className="text-sm font-semibold text-secondary-themed">${inv.total.toFixed(2)}</span>
                  <span>{inv.paidAt ? `Paid ${formatDate(inv.paidAt)}` : `Submitted ${formatDate(inv.submittedAt)}`}</span>
                </div>
              </Link>
            ))}
          </div>
        </>
      )}
    </Card>
  )
}
