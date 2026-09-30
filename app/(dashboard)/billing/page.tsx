import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { requireOrgMember } from '@/lib/auth'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'
import { unwrapJoin } from '@/lib/utils/supabase-joins'
import { BillingOverview, type BillingInvoiceRow } from '@/components/billing/billing-overview'
import type { InvoiceStatus, MemberRole } from '@/types/database'

export const metadata: Metadata = { title: 'Billing' }

/**
 * /billing — the subscription, its itemized cost, and the org's vendor
 * invoices.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE BILLING TAB IN /settings. The 'finance'
 * member role (migration 20260930120000) is a bookkeeper who needs the bill
 * and the invoices and nothing else. /settings is gated to 'admin' because it
 * also holds team management, integration credentials and account deletion,
 * so the only way to show a bookkeeper an invoice used to be to make them an
 * admin. Admins keep the tab in /settings; both surfaces compute every figure
 * from lib/stripe/brackets.ts, which is the one place the rate schedule is
 * allowed to live.
 */
const VIEW_ROLES: ReadonlySet<MemberRole> = new Set(['owner', 'admin', 'finance'])

/**
 * Most recent vendor invoices, bounded.
 *
 * An org-scoped read that grows with TIME rather than with portfolio size,
 * which is the distinction CLAUDE.md's `-org-scoped` tier turns on: one
 * invoice per completed vendor work order, forever. So this is a deliberate
 * ceiling on a page whose job is "the last while", not a portfolio report,
 * and the subtitle says so rather than letting a short list read as the whole
 * history. A real ledger export belongs behind an Inngest job that writes to
 * Storage, the same shape the CPA export uses.
 */
const RECENT_INVOICE_LIMIT = 25

interface InvoiceQueryRow {
  id:             string
  invoice_number: string
  status:         InvoiceStatus
  total:          number
  submitted_at:   string
  paid_at:        string | null
  properties:     { name: string } | { name: string }[] | null
  vendors:        { name: string } | { name: string }[] | null
}

export default async function BillingPage() {
  const { supabase, membership } = await requireOrgMember()

  // A nav item that does not render is not an access control: /settings has
  // no page-level role gate today and a viewer who types the URL reaches it.
  // This page does gate, because it is the one a new role was added for.
  if (!VIEW_ROLES.has(membership.role)) redirect('/ops')

  const [
    { data: org, error: orgError },
    { count: activeProperties, error: propertyCountError },
    { data: invoices, error: invoicesError },
  ] = await Promise.all([
    supabase
      .from('organizations')
      .select('id, name, plan, plan_status, trial_ends_at, stripe_customer_id, max_properties')
      .eq('id', membership.org_id)
      .single(),

    // is_active: true matches createCheckoutSession's own count, so this page
    // and the checkout guard never disagree about what a property is.
    supabase
      .from('properties')
      .select('id', { count: 'exact', head: true })
      .eq('org_id', membership.org_id)
      .eq('is_active', true),

    supabase
      .from('work_order_invoices')
      .select(`
        id, invoice_number, status, total, submitted_at, paid_at,
        properties ( name ),
        vendors ( name )
      `)
      .eq('org_id', membership.org_id)
      .order('submitted_at', { ascending: false })
      .limit(RECENT_INVOICE_LIMIT),
  ])

  throwIfAnyQueryFailed(
    { site: 'page.billing', orgId: membership.org_id },
    orgError, propertyCountError, invoicesError,
  )

  const invoiceRows: BillingInvoiceRow[] = ((invoices ?? []) as InvoiceQueryRow[]).map((row) => ({
    id:            row.id,
    invoiceNumber: row.invoice_number,
    status:        row.status,
    total:         row.total,
    submittedAt:   row.submitted_at,
    paidAt:        row.paid_at,
    propertyName:  unwrapJoin(row.properties)?.name ?? null,
    vendorName:    unwrapJoin(row.vendors)?.name ?? null,
  }))

  return (
    <div>
      <div className="mb-8">
        <h1 className="page-title">Billing</h1>
        <p className="page-subtitle">
          Your subscription, what it costs and why, and your vendor invoices
        </p>
      </div>

      <BillingOverview
        planStatus={org!.plan_status}
        trialEndsAt={org!.trial_ends_at}
        isSubscribed={org!.stripe_customer_id !== null}
        activePropertyCount={activeProperties ?? 0}
        invoices={invoiceRows}
        invoiceLimit={RECENT_INVOICE_LIMIT}
        canManageSubscription={membership.role === 'owner' || membership.role === 'admin'}
      />
    </div>
  )
}
