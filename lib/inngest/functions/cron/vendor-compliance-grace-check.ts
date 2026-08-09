import { unwrap } from '@/lib/supabase/unwrap'
import { inngest }             from '@/lib/inngest/client'
import { fetchAllRows }        from '@/lib/inngest/paginate'
import { createServiceClient } from '@/lib/supabase/server'
import { logAuditEvents } from '@/lib/audit'

/**
 * Documents claimed per bulk UPDATE. Below max_rows so the RETURNING clause —
 * which is what the audit trail is built from — is never truncated.
 */
const HARD_BLOCK_CHUNK = 500

/**
 * Ceiling on documents transitioned per run.
 *
 * Batching the claim (below) removed the step explosion, but the READ was
 * still an uncapped fetchAllRows over a backlog whose own comment notes it
 * "only ever grows" — so a bulk COI import could put 200k candidates into one
 * invocation's memory and one run's write path. The sibling cron
 * (vendor-compliance-expiry-check.ts) already caps itself at
 * MAX_DOCS_PER_RUN = 200 for exactly this reason; this is the same pattern.
 *
 * Ordered oldest-expiry-first so the cap drains a backlog deterministically —
 * the most overdue documents, which are the ones a vendor is most wrongly
 * still assignable on, transition first. The remainder is picked up tomorrow.
 */
const MAX_HARD_BLOCK_PER_RUN = 2_000

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

      // Platform-wide, and this backlog only ever grows — `hard_blocked_at IS
      // NULL` plus `expiry_date <= today-46` accumulates every expired
      // document across every tenant until this cron clears it.
      //
      // EXPLICITLY capped rather than paginated (it used to drain every page
      // via fetchAllRows). An accidental truncation at PostgREST's 1000-row
      // limit would leave documents past the cap with hard_blocked_at NULL
      // FOREVER — the gate only ever looks at NULLs, so nothing revisits them —
      // and a vendor whose COI expired months ago stays assignable with no
      // audit trail. A DELIBERATE cap does not have that failure: the ordering
      // is oldest-expiry-first and deterministic, so tomorrow's run resumes
      // exactly where this one stopped, and the shortfall is logged.
      const res = await supabase
        .from('vendor_compliance_documents')
        .select('id, org_id, vendor_id, document_type, expiry_date')
        .eq('is_active', true)
        .is('hard_blocked_at', null)
        .lte('expiry_date', cutoff)
        .order('expiry_date', { ascending: true })
        .order('id',          { ascending: true })
        .limit(MAX_HARD_BLOCK_PER_RUN)

      return unwrap(res, { site: 'inngest.vendor-compliance-grace-check.hard-block-candidates' }) ?? []
    })

    logger.info(`Found ${hardBlockCandidates.length} compliance document(s) crossing into hard-block`)

    // Never silent about a truncation — CLAUDE.md's "no silent caps" rule. A
    // full page means there is more backlog than one run transitions, which is
    // an operational fact someone needs to see rather than infer.
    if (hardBlockCandidates.length === MAX_HARD_BLOCK_PER_RUN) {
      logger.warn(
        `Hard-block backlog hit the ${MAX_HARD_BLOCK_PER_RUN}/run ceiling — the remainder ` +
        'carries to the next run. Oldest expiry dates were transitioned first.'
      )
    }

    // ── Batched claim ────────────────────────────────────────────────────────
    //
    // One step and one round-trip per document, every day, over a backlog the
    // comment above notes "only ever grows". Now one bulk claim per
    // HARD_BLOCK_CHUNK documents.
    //
    // The idempotency guarantee is unchanged and is what makes a batch safe to
    // retry as a unit: `.is('hard_blocked_at', null).select('id')` is the same
    // optimistic lock, just applied to a set — a retry matches zero rows
    // because the first attempt already filled the column, so no document is
    // ever audited twice. Same shape as the aging/overdue escalations in
    // cron/work-order-ops.ts and cron/maintenance-schedules-helpers.ts.
    //
    // Chunked because RETURNING is a PostgREST response like any other and
    // truncates at max_rows: the UPDATE would claim every row correctly while
    // reporting only the first 1000, and the audit trail — the entire point of
    // this cron — would be short by the difference, silently.
    let hardBlocked = 0

    for (let i = 0; i < hardBlockCandidates.length; i += HARD_BLOCK_CHUNK) {
      const chunk = hardBlockCandidates.slice(i, i + HARD_BLOCK_CHUNK)
      hardBlocked += await step.run(`mark-hard-blocked-batch-${i}`, async () => {
        const supabase = createServiceClient({ system: 'inngest:vendor-compliance-grace-check' })

        // A failed claim used to be indistinguishable from "another run got
        // there first" — both returned null and skipped. But this claim IS the
        // hard-block, so a discarded error meant the vendor was never blocked
        // and nothing said so. Throw and let Inngest retry.
        const claimRes = await supabase
          .from('vendor_compliance_documents')
          .update({ hard_blocked_at: new Date().toISOString() })
          .in('id', chunk.map((doc) => doc.id))
          .is('hard_blocked_at', null)
          .select('id')

        const claimed = unwrap(claimRes, {
          site: 'inngest.vendor-compliance-grace-check.hard-block-claim',
        })

        const claimedIds = new Set((claimed ?? []).map((row: { id: string }) => row.id))
        const newlyBlocked = chunk.filter((doc) => claimedIds.has(doc.id))
        if (!newlyBlocked.length) return 0

        await logAuditEvents(
          newlyBlocked.map((doc) => ({
            orgId:      doc.org_id,
            action:     'vendor.compliance.hard_blocked' as const,
            targetType: 'vendor_compliance_document',
            targetId:   doc.id,
            metadata:   {
              vendor_id:     doc.vendor_id,
              document_type: doc.document_type,
              expiry_date:   doc.expiry_date,
            },
          }))
        )

        return newlyBlocked.length
      })
    }

    return {
      grace_period_entries:  graceDocs.length,
      hard_block_candidates: hardBlockCandidates.length,
      hard_blocked:          hardBlocked,
    }
  }
)
