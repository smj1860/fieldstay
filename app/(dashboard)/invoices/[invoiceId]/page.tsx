import { notFound }            from 'next/navigation'
import { requireOrgMember }    from '@/lib/auth'
import type { Metadata }       from 'next'
import { PayInvoiceButton }    from './pay-button'
import { processingSurchargeCents } from '@/lib/stripe/platform-fee'
import { Check } from 'lucide-react'
import { unwrapJoin }          from '@/lib/utils/supabase-joins'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'
import { SUPABASE_MAX_ROWS }   from '@/lib/inngest/paginate'

export const metadata: Metadata = { title: 'Invoice — FieldStay' }

const LINE_TYPE_LABELS: Record<string, string> = {
  labor:         'Labor',
  material:      'Material',
  equipment:     'Equipment',
  subcontractor: 'Subcontractor',
  other:         'Other',
}

const fmt = (n: number) =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

/**
 * The header pill's text/icon for the four states an invoice can be in.
 * Extracted rather than a chained ternary in JSX — a fifth state (refunded)
 * pushed that chain into sonarjs's nested-ternary flag.
 */
function statusBadgeContent(
  status: string,
  isPaid: boolean,
  isCancelled: boolean,
  isRefunded: boolean,
): React.ReactNode {
  if (isRefunded) return status === 'refunded' ? 'REFUNDED' : 'PARTIALLY REFUNDED'
  if (isPaid) return <><Check size={12} /> PAID</>
  if (isCancelled) return 'CANCELLED'
  return 'PENDING PAYMENT'
}

export default async function InvoicePage({
  params,
  searchParams,
}: {
  params:       Promise<{ invoiceId: string }>
  searchParams: Promise<{ paid?: string; cancelled?: string }>
}) {
  const { invoiceId }             = await params
  const { paid, cancelled }       = await searchParams
  const { supabase, membership }  = await requireOrgMember()

  // Fetch invoice — scoped to this org (RLS enforces, plus explicit eq)
  const { data: invoice, error: invoiceError } = await supabase
    .from('work_order_invoices')
    .select(`
      id,
      invoice_number,
      status,
      subtotal,
      total,
      platform_fee_amount,
      paid_at,
      amount_refunded,
      refunded_at,
      submitted_at,
      work_order_id,
      vendor_id,
      property_id,
      work_orders (
        id, title, wo_number, category, completed_date
      ),
      vendors (
        name, email, stripe_connect_charges_enabled
      ),
      properties ( name, address, city, state )
    `)
    .eq('id', invoiceId)
    .eq('org_id', membership.org_id)
    .single()


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
  throwIfAnyQueryFailed({ site: 'page.invoices.invoiceId', orgId: membership.org_id }, invoiceError)
  if (!invoice) notFound()

  // Fetch vendor-submitted line items
  const { data: lineItems, error: lineItemsError } = await supabase
    .from('work_order_line_items')
    .select('id, line_type, description, quantity, unit_cost, line_total, sort_order, created_at')
    .eq('work_order_id', invoice.work_order_id)
    // The org scope is defence in depth, not decoration: invoice.work_order_id
    // came from a row already filtered by org above, but work_order_line_items
    // carries its own org_id and nothing forces those two to agree. It also
    // bounds the read for semgrep's unbounded-select ladder.
    .eq('org_id', membership.org_id)
    .eq('vendor_submitted', true)
    // This is the document a vendor is paid against and that feeds the owner
    // statement, so its line order must be the same every time it is opened.
    // sort_order alone did not give that: it defaulted to a flat 0, and rows
    // tied on the sort key come back in whatever order Postgres likes.
    .order('sort_order',  { ascending: true })
    .order('created_at',  { ascending: true })
    .order('id',          { ascending: true })
    // Explicit bound. PostgREST caps every response at max_rows and returns a
    // 200 with no truncation signal, so an unbounded read here would silently
    // drop lines off the bottom of an invoice — the one document where a
    // missing row means someone is underpaid. One work order's vendor lines
    // will never approach this; naming the cap is what makes that a checked
    // assumption instead of an unstated one.
    .limit(SUPABASE_MAX_ROWS)


  // Logs + reports, then throws so the segment's error.tsx renders a real
  // error state — a failed read must not render as an empty page.
  throwIfAnyQueryFailed({ site: 'page.invoices.invoiceId', orgId: membership.org_id }, lineItemsError)
  const wo       = unwrapJoin(invoice.work_orders)
  const vendor   = unwrapJoin(invoice.vendors)
  const property = unwrapJoin(invoice.properties)

  // Shown, and added to Total Due, because the PM is the one who pays it —
  // see lib/stripe/platform-fee.ts. Computed from the SAME helper the checkout
  // route uses rather than re-derived here: a page that quotes one total and a
  // Stripe page that charges another is the single most disputable thing a
  // billing screen can do, and two copies of this arithmetic would drift the
  // first time the rate changed.
  const surcharge = processingSurchargeCents(Math.round(invoice.total * 100)) / 100
  const totalDue  = invoice.total + surcharge

  const isPaid      = invoice.status === 'paid'   || paid === 'true'
  const isCancelled = invoice.status === 'cancelled' || cancelled === 'true'
  // A refunded invoice was 'paid' — isPaid alone would leave the Pay button
  // hidden by luck rather than by a check that actually names this state, and
  // isRefunded is what the summary line below reads to say so honestly rather
  // than showing a stale "Paid" badge. The checkout route has its own,
  // independent refusal for the same state — this is the display half, not
  // the enforcement.
  const isRefunded  = invoice.status === 'refunded' || invoice.status === 'partially_refunded'

  const addressParts = [property?.address, property?.city, property?.state].filter(Boolean)
  const address      = addressParts.join(', ')

  return (
    <div style={{
      minHeight:       '100vh',
      backgroundColor: '#f1f5f9',
      fontFamily:      '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif',
    }}>

      {/* TradeSuite Header */}
      <div style={{
        backgroundColor: '#1A1A1A',
        backgroundImage: 'repeating-linear-gradient(45deg,transparent,transparent 4px,rgba(255,255,255,0.015) 4px,rgba(255,255,255,0.015) 8px)',
        borderBottom:    '3px solid #FF6B00',
        padding:         '16px 24px',
        display:         'flex',
        alignItems:      'center',
        justifyContent:  'space-between',
      }}>
        <div>
          <p style={{ color: '#FF6B00', fontSize: 18, fontWeight: 800, letterSpacing: '-0.3px', margin: 0 }}>TradeSuite</p>
          <p style={{ color: '#C0C0C0', fontSize: 10, margin: '2px 0 0', letterSpacing: '0.1em' }}>POWERED BY FIELDSTAY</p>
        </div>
        <div style={{ textAlign: 'right' }}>
          <p style={{ color: '#ffffff', fontSize: 13, fontWeight: 700, margin: 0 }}>{invoice.invoice_number}</p>
          <p style={{ color: '#94a3b8', fontSize: 11, margin: '2px 0 0', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
            {statusBadgeContent(invoice.status, isPaid, isCancelled, isRefunded)}
          </p>
        </div>
      </div>

      <div style={{ maxWidth: 640, margin: '0 auto', padding: '24px 16px' }}>

        {/* Status banner */}
        {isPaid && !isRefunded && (
          <div style={{ backgroundColor: '#dcfce7', border: '1px solid #86efac', borderRadius: 10, padding: '12px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10 }}>
            <Check size={20} color="#166534" />
            <div>
              <p style={{ fontSize: 14, fontWeight: 700, color: '#166534', margin: 0 }}>Invoice Paid</p>
              {invoice.paid_at && (
                <p style={{ fontSize: 12, color: '#16a34a', margin: '2px 0 0' }}>
                  Paid {new Date(invoice.paid_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                </p>
              )}
            </div>
          </div>
        )}

        {isRefunded && (
          <div style={{ backgroundColor: '#fef3c7', border: '1px solid #fcd34d', borderRadius: 10, padding: '12px 16px', marginBottom: 20, display: 'flex', alignItems: 'center', gap: 10 }}>
            <div>
              <p style={{ fontSize: 14, fontWeight: 700, color: '#92400e', margin: 0 }}>
                {invoice.status === 'refunded' ? 'Invoice Refunded' : 'Invoice Partially Refunded'}
              </p>
              {invoice.refunded_at && (
                <p style={{ fontSize: 12, color: '#b45309', margin: '2px 0 0' }}>
                  {fmt(invoice.amount_refunded)} refunded {new Date(invoice.refunded_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                </p>
              )}
            </div>
          </div>
        )}

        {/* Invoice card */}
        <div style={{ backgroundColor: '#ffffff', borderRadius: 12, border: '1px solid #e2e8f0', overflow: 'hidden', marginBottom: 20 }}>

          {/* Vendor + property info */}
          <div style={{ padding: '20px 24px', borderBottom: '1px solid #f1f5f9' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
              <div>
                <p style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 4px' }}>From</p>
                <p style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', margin: 0 }}>{vendor?.name ?? '—'}</p>
              </div>
              <div>
                <p style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.08em', margin: '0 0 4px' }}>Property</p>
                <p style={{ fontSize: 14, fontWeight: 700, color: '#0f172a', margin: 0 }}>{property?.name ?? '—'}</p>
                {address && <p style={{ fontSize: 12, color: '#64748b', margin: '2px 0 0' }}>{address}</p>}
              </div>
            </div>

            {wo && (
              <div style={{ marginTop: 12, padding: '10px 12px', backgroundColor: '#f8fafc', borderRadius: 8 }}>
                <p style={{ fontSize: 12, fontWeight: 600, color: '#374151', margin: 0 }}>
                  WO-{wo.wo_number}: {wo.title}
                </p>
                {wo.completed_date && (
                  <p style={{ fontSize: 11, color: '#94a3b8', margin: '2px 0 0' }}>
                    Completed {new Date(wo.completed_date).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                  </p>
                )}
              </div>
            )}
          </div>

          {/* Line items */}
          <div style={{ padding: '0 24px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: '8px', padding: '12px 0 8px', borderBottom: '1px solid #f1f5f9' }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Description</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'right' }}>Qty</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'right', minWidth: 70 }}>Unit</span>
              <span style={{ fontSize: 10, fontWeight: 700, color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.06em', textAlign: 'right', minWidth: 80 }}>Total</span>
            </div>

            {(lineItems ?? []).map((item) => (
              <div key={item.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: '8px', padding: '10px 0', borderBottom: '1px solid #f8fafc', alignItems: 'center' }}>
                <div>
                  <p style={{ fontSize: 13, fontWeight: 500, color: '#0f172a', margin: 0 }}>{item.description}</p>
                  <span style={{ fontSize: 10, color: '#94a3b8', backgroundColor: '#f1f5f9', borderRadius: 4, padding: '1px 6px', display: 'inline-block', marginTop: 2 }}>
                    {LINE_TYPE_LABELS[item.line_type] ?? item.line_type}
                  </span>
                </div>
                <span style={{ fontSize: 13, color: '#374151', textAlign: 'right' }}>{item.quantity}</span>
                <span style={{ fontSize: 13, color: '#374151', textAlign: 'right', minWidth: 70 }}>{fmt(item.unit_cost)}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: '#0f172a', textAlign: 'right', minWidth: 80 }}>{fmt(item.line_total ?? item.unit_cost * item.quantity)}</span>
              </div>
            ))}

            {/* Totals */}
            <div style={{ padding: '16px 0' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 13, color: '#64748b' }}>Subtotal</span>
                <span style={{ fontSize: 13, color: '#374151' }}>{fmt(invoice.subtotal)}</span>
              </div>
              {surcharge > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 13, color: '#64748b' }}>Card processing fee</span>
                  <span style={{ fontSize: 13, color: '#374151' }}>{fmt(surcharge)}</span>
                </div>
              )}
              <div style={{ display: 'flex', justifyContent: 'space-between', paddingTop: 10, borderTop: '2px solid #0f172a' }}>
                <span style={{ fontSize: 16, fontWeight: 800, color: '#0f172a' }}>Total Due</span>
                <span style={{ fontSize: 20, fontWeight: 800, color: '#0f172a' }}>{fmt(totalDue)}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Pay button */}
        {!isPaid && !isCancelled && !isRefunded && (
          <PayInvoiceButton invoiceId={invoiceId} total={totalDue} />
        )}

        <p style={{ fontSize: 11, color: '#94a3b8', textAlign: 'center', marginTop: 16 }}>
          Payments processed by Stripe Connect · Powered by TradeSuite
        </p>
      </div>
    </div>
  )
}
