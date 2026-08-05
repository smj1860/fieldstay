import Link from 'next/link'
import { ShieldCheck, Clock, ArrowLeft } from 'lucide-react'
import { requireOrgRole }      from '@/lib/auth'
import { createServiceClient } from '@/lib/supabase/server'
import { throwIfAnyQueryFailed } from '@/lib/supabase/unwrap'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import { ErasureForm } from './erasure-form'

export const metadata = { title: 'Privacy & Data Requests · FieldStay' }

const RECENT_LIMIT = 20

interface ErasureRow {
  id:         string
  created_at: string
  metadata:   Record<string, unknown> | null
}

function numberOf(metadata: Record<string, unknown> | null, key: string): number | null {
  const raw = metadata?.[key]
  return typeof raw === 'number' ? raw : null
}

/**
 * Records written before the erasure covered SMS opt-ins have neither key.
 * That is an em dash, not a misleading "0 deleted" — the difference between
 * "we checked and there were none" and "we did not check" is the whole point
 * of a compliance record.
 */
function optInSummary(metadata: Record<string, unknown> | null): string {
  const deleted  = numberOf(metadata, 'optins_deleted')
  const retained = numberOf(metadata, 'optins_retained')
  if (deleted === null && retained === null) return '—'
  const kept = retained ? `, ${retained} kept` : ''
  return `${deleted ?? 0} deleted${kept}`
}

export default async function PrivacyPage() {
  // ADMIN-ONLY, matching anonymizeGuestData's own gate. The action runs with
  // the service role, so nothing downstream re-checks the role — a page that
  // rendered the form for a manager would be handing them a button that the
  // action then refuses, and a page that rendered the erasure HISTORY for a
  // viewer would leak which guests have filed requests. `owner` passes
  // automatically (see is_org_member).
  const { membership } = await requireOrgRole(['admin'])

  const supabase = createServiceClient({ authorizedBy: membership })

  // audit_events RLS is owner-only, so this reads through the service role —
  // scoped to the caller's org, which is the only thing standing between this
  // page and every other tenant's erasure history.
  const [orgRes, erasuresRes] = await Promise.all([
    supabase
      .from('organizations')
      .select('guest_pii_retention_days, comms_log_retention_days')
      .eq('id', membership.org_id)
      .maybeSingle(),
    supabase
      .from('audit_events')
      .select('id, created_at, metadata')
      .eq('org_id', membership.org_id)
      .eq('action', 'gdpr.data_erasure.completed')
      .order('created_at', { ascending: false })
      .limit(RECENT_LIMIT),
  ])

  // A failed read must render a real error state, not an empty page that
  // implies no erasure has ever been performed.
  throwIfAnyQueryFailed(
    { site: 'page.settings.privacy', orgId: membership.org_id },
    orgRes.error,
    erasuresRes.error,
  )

  const retentionDays = orgRes.data?.guest_pii_retention_days ?? null
  const commsDays     = orgRes.data?.comms_log_retention_days ?? null
  const erasures      = (erasuresRes.data ?? []) as ErasureRow[]

  return (
    <div className="max-w-3xl">
      <div className="mb-6">
        <Link
          href="/settings"
          className="text-xs inline-flex items-center gap-1 mb-4 hover:opacity-80"
          style={{ color: 'var(--text-muted)' }}
        >
          <ArrowLeft className="w-3 h-3" />
          Back to Settings
        </Link>
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0"
            style={{ background: 'var(--accent-gold-dim)' }}
          >
            <ShieldCheck className="w-4 h-4" style={{ color: 'var(--accent-gold)' }} />
          </div>
          <div>
            <h1 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>
              Privacy &amp; Data Requests
            </h1>
            <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
              Handle guest deletion requests and review what is purged automatically
            </p>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <ErasureForm />

        {/* Automatic retention — the erasure form above is the manual path for
            the same data. Showing both together is what stops an operator
            treating a request as urgent when it is already scheduled, or
            assuming retention covers a request that it does not. */}
        <Card>
          <div className="flex items-start gap-3 mb-3">
            <Clock className="w-4 h-4 mt-0.5 flex-shrink-0" style={{ color: 'var(--text-muted)' }} />
            <div>
              <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
                Automatic retention
              </h2>
              <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
                Guest data is purged on a schedule even without a request. Change these
                windows under Settings → Organization.
              </p>
            </div>
          </div>
          <dl className="text-sm space-y-2">
            <div className="flex items-center justify-between gap-4">
              <dt style={{ color: 'var(--text-secondary)' }}>Guest PII after checkout</dt>
              <dd>
                {retentionDays === null
                  ? <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Not configured</span>
                  : <Badge tone="slate">{retentionDays} days</Badge>}
              </dd>
            </div>
            <div className="flex items-center justify-between gap-4">
              <dt style={{ color: 'var(--text-secondary)' }}>Communication logs</dt>
              <dd>
                {commsDays === null
                  ? <span className="text-xs" style={{ color: 'var(--text-muted)' }}>Not configured</span>
                  : <Badge tone="slate">{commsDays} days</Badge>}
              </dd>
            </div>
          </dl>
          <p className="text-xs mt-4 pt-3" style={{ color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)' }}>
            Guests who replied STOP to an SMS are never purged from the suppression list.
            That record is what keeps the number from being texted again, and it is
            retained for as long as the number exists.
          </p>
        </Card>

        {/* The compliance record. An erasure that leaves no trace is one you
            cannot evidence to a regulator, and the email is stored only as a
            SHA-256 hash so this table is not a second copy of the PII. */}
        <Card className="p-0 overflow-hidden">
          <div className="px-5 pt-5 pb-3">
            <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
              Erasure history
            </h2>
            <p className="text-xs mt-1" style={{ color: 'var(--text-muted)' }}>
              Last {RECENT_LIMIT} requests fulfilled. Guest emails are recorded as an
              irreversible hash — the full audit trail lives in{' '}
              <Link href="/settings/audit" className="underline underline-offset-2">the audit log</Link>.
            </p>
          </div>

          {erasures.length === 0 ? (
            <p className="px-5 pb-5 text-sm" style={{ color: 'var(--text-muted)' }}>
              No erasure requests have been fulfilled yet.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr style={{ borderTop: '1px solid var(--border)', borderBottom: '1px solid var(--border)' }}>
                    <th className="text-left px-5 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      Date
                    </th>
                    <th className="text-left px-5 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      Guest (hashed)
                    </th>
                    <th className="text-right px-5 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      Bookings
                    </th>
                    <th className="text-right px-5 py-2.5 text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
                      Opt-ins
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {erasures.map((row, i) => {
                    const hash = row.metadata?.email_hash
                    return (
                      <tr
                        key={row.id}
                        style={{ borderBottom: i < erasures.length - 1 ? '1px solid var(--border-subtle)' : 'none' }}
                      >
                        <td className="px-5 py-3 font-mono text-xs whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                          {new Date(row.created_at).toLocaleString('en-US', {
                            month: 'short', day: 'numeric', year: 'numeric',
                            hour: '2-digit', minute: '2-digit', hour12: false,
                          })}
                        </td>
                        <td className="px-5 py-3 font-mono text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {typeof hash === 'string' ? `${hash.slice(0, 16)}…` : '—'}
                        </td>
                        <td className="px-5 py-3 text-right text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {numberOf(row.metadata, 'bookings_anonymized') ?? '—'}
                        </td>
                        <td className="px-5 py-3 text-right text-xs" style={{ color: 'var(--text-secondary)' }}>
                          {optInSummary(row.metadata)}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  )
}
