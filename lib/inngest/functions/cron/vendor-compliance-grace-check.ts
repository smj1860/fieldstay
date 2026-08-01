import { inngest }             from '@/lib/inngest/client'
import { fetchAllRows }        from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent, logAuditEvents } from '@/lib/audit'

/** One row of the platform-wide compliance-document scans below. Nullability
 *  matches the live schema: only expiry_date is nullable. */
interface ComplianceDocRow {
  id:            string
  org_id:        string
  vendor_id:     string
  document_type: string
  expiry_date:   string | null
}

/**
 * SCHEDULED: runs every morning at 6:15am CT — 15 minutes after
 * cron-vendor-compliance-expiry-check so that day's first_warned_at
 * updates have already landed.
 *
 * The vendor_compliance_status view (migration 20260606051120, grace
 * period widened to 45 days by 20260720170645) computes grace_period /
 * hard_blocked purely from expiry_date, so those statuses
 * are always correct without a cron. But the *moments* a document enters
 * the grace period or crosses into hard-block were never recorded or
 * audited anywhere — this cron closes that gap:
 *
 *  a. Documents where expiry_date = CURRENT_DATE - 1 just entered the
 *     grace period today. Gated purely on the exact date match, so it
 *     only fires once per document (same idempotency principle as the
 *     first_warned_at gate, computed over a single day instead of a
 *     boolean column).
 *  b. Documents where expiry_date <= CURRENT_DATE - 46 and
 *     hard_blocked_at IS NULL just crossed into hard-block territory.
 *     hard_blocked_at is set atomically (idempotent update-then-check
 *     gate, mirroring first_warned_at in the expiry-check cron) so a
 *     retried step never re-logs the same document.
 */
export const vendorComplianceGraceCheck = inngest.createFunction(
  {
    id:      'cron-vendor-compliance-grace-check',
    name:    'Cron: Vendor Compliance Grace Period + Hard Block',
    retries: 2,
  },
  { cron: '15 11 * * *' },  // 6:15am CT (UTC-5) — 15 min after expiry-check
  async ({ step, logger }) => {

    // ── a. Grace period entry (expiry_date = yesterday) ─────────────────────

    const graceDocs = await step.run('find-grace-period-entries', async () => {
      const supabase    = createServiceClient({ system: 'inngest:vendor-compliance-grace-check' })
      const yesterday    = new Date(Date.now() - 86_400_000).toISOString().split('T')[0]

      // Paginated: every org's compliance documents, not one tenant's. This
      // is the only moment a document's grace-period entry is ever recorded —
      // the gate is `expiry_date = yesterday`, so a document dropped by a
      // max_rows truncation is never revisited on any later run and its
      // `vendor.compliance.grace_period_entered` audit row simply never
      // exists. fetchAllRows also throws on a query error, where the previous
      // bare `{ data }` destructure turned an outage into "0 documents".
      return await fetchAllRows<ComplianceDocRow>(
        (from, to) => supabase
          .from('vendor_compliance_documents')
          .select('id, org_id, vendor_id, document_type, expiry_date')
          .eq('is_active', true)
          .eq('expiry_date', yesterday)
          .order('id')
          .range(from, to),
        { label: 'vendor-compliance-grace-check.grace-entries' },
      )
    })

    if (graceDocs.length) {
      await logAuditEvents(
        graceDocs.map((doc) => ({
          orgId:      doc.org_id,
          action:     'vendor.compliance.grace_period_entered' as const,
          targetType: 'vendor_compliance_document',
          targetId:   doc.id,
          metadata:   {
            vendor_id:     doc.vendor_id,
            document_type: doc.document_type,
            expiry_date:   doc.expiry_date,
          },
        }))
      )
    }

    logger.info(`Found ${graceDocs.length} compliance document(s) entering the grace period`)

    // ── b. Hard block crossing (expiry_date <= today - 46, not yet recorded) ─

    const hardBlockCandidates = await step.run('find-hard-block-candidates', async () => {
      const supabase  = createServiceClient({ system: 'inngest:vendor-compliance-grace-check' })
      const cutoff    = new Date(Date.now() - 46 * 86_400_000).toISOString().split('T')[0]

      // Paginated: platform-wide, and this backlog only ever grows —
      // `hard_blocked_at IS NULL` plus `expiry_date <= today-46` accumulates
      // every expired document across every tenant until this cron clears it.
      // Truncated at 1000, the documents past the cap keep their
      // hard_blocked_at NULL forever, so a vendor whose COI expired months
      // ago stays assignable to work orders with no audit trail.
      return await fetchAllRows<ComplianceDocRow>(
        (from, to) => supabase
          .from('vendor_compliance_documents')
          .select('id, org_id, vendor_id, document_type, expiry_date')
          .eq('is_active', true)
          .is('hard_blocked_at', null)
          .lte('expiry_date', cutoff)
          .order('id')
          .range(from, to),
        { label: 'vendor-compliance-grace-check.hard-block-candidates' },
      )
    })

    logger.info(`Found ${hardBlockCandidates.length} compliance document(s) crossing into hard-block`)

    for (const doc of hardBlockCandidates) {
      await step.run(`mark-hard-blocked-${doc.id}`, async () => {
        const supabase = createServiceClient({ system: 'inngest:vendor-compliance-grace-check' })

        // Idempotency: only proceed if this run is the one that flips the
        // gate — guards against a retried step re-logging the same doc.
        const { data: updated } = await supabase
          .from('vendor_compliance_documents')
          .update({ hard_blocked_at: new Date().toISOString() })
          .eq('id', doc.id)
          .is('hard_blocked_at', null)
          .select('id')
          .maybeSingle()

        if (!updated) return null

        await logAuditEvent({
          orgId:      doc.org_id,
          action:     'vendor.compliance.hard_blocked',
          targetType: 'vendor_compliance_document',
          targetId:   doc.id,
          metadata:   {
            vendor_id:     doc.vendor_id,
            document_type: doc.document_type,
            expiry_date:   doc.expiry_date,
          },
        })

        return updated
      })
    }

    return {
      grace_period_entries: graceDocs.length,
      hard_block_candidates: hardBlockCandidates.length,
    }
  }
)
