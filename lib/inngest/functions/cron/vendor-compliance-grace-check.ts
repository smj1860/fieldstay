import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvent, logAuditEvents } from '@/lib/audit'

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
      const supabase    = createServiceClient()
      const yesterday    = new Date(Date.now() - 86_400_000).toISOString().split('T')[0]

      const { data } = await supabase
        .from('vendor_compliance_documents')
        .select('id, org_id, vendor_id, document_type, expiry_date')
        .eq('is_active', true)
        .eq('expiry_date', yesterday)

      return data ?? []
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
      const supabase  = createServiceClient()
      const cutoff    = new Date(Date.now() - 46 * 86_400_000).toISOString().split('T')[0]

      const { data } = await supabase
        .from('vendor_compliance_documents')
        .select('id, org_id, vendor_id, document_type, expiry_date')
        .eq('is_active', true)
        .is('hard_blocked_at', null)
        .lte('expiry_date', cutoff)

      return data ?? []
    })

    logger.info(`Found ${hardBlockCandidates.length} compliance document(s) crossing into hard-block`)

    for (const doc of hardBlockCandidates) {
      await step.run(`mark-hard-blocked-${doc.id}`, async () => {
        const supabase = createServiceClient()

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
