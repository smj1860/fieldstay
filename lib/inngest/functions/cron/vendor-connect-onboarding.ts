/**
 * Nightly Vendor Connect Onboarding Cron (CLAUDE_58_0)
 *
 * Cron: 07:00 UTC daily (≈ 2:00 AM CT)
 *
 * Finds all vendors with:
 *   - email IS NOT NULL
 *   - stripe_connect_account_id IS NULL  (no Connect account yet)
 *   - stripe_connect_invite_sent_at IS NULL  (invite not yet sent)
 *   - created_at >= yesterday  (only recently added vendors)
 *
 * For each vendor:
 *   1. Creates a Stripe Express account under our platform
 *   2. Stores stripe_connect_account_id on the vendor row
 *   3. Sends a Connect invite email with their onboarding URL
 *   4. Sets stripe_connect_invite_sent_at = now() (dedup guard)
 *
 * Batched in groups of 25 with a 2s top-level step.sleep between
 * batches to avoid Resend rate limits and Stripe API bursts.
 *
 * The vendor portal gate (CLAUDE_58_1) handles same-day edge cases
 * where a vendor receives a work order before this cron runs.
 */

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { ensureVendorConnectInvited } from '@/lib/stripe/vendor-connect-invite'

const BATCH_SIZE = 25

export const vendorConnectOnboardingCron = inngest.createFunction(
  {
    id:      'cron-vendor-connect-onboarding',
    name:    'Cron: Nightly Vendor Connect Invite',
    retries: 2,
  },
  { cron: '0 7 * * *' },
  async ({ step, logger }) => {

    // ── Step 1: Fetch uninvited vendors with email ───────────────────────────
    const vendors = await step.run('fetch-uninvited-vendors', async () => {
      const supabase = createServiceClient()

      // Look back 2 days to catch any missed by a failed run
      const cutoff = new Date()
      cutoff.setDate(cutoff.getDate() - 2)

      const { data, error } = await supabase
        .from('vendors')
        .select(`
          id,
          org_id,
          name,
          email,
          stripe_connect_token,
          stripe_connect_account_id,
          stripe_connect_invite_sent_at,
          organizations ( name )
        `)
        .eq('is_active', true)
        .not('email', 'is', null)
        .is('stripe_connect_account_id', null)
        .is('stripe_connect_invite_sent_at', null)
        .gte('created_at', cutoff.toISOString())

      if (error) {
        logger.error('[vendor-connect-cron] fetch failed', { error: error.message })
        throw new Error(`Failed to fetch vendors: ${error.message}`)
      }

      return data ?? []
    })

    logger.info(`[vendor-connect-cron] ${vendors.length} vendors to onboard`)

    if (vendors.length === 0) return { invited: 0 }

    // ── Process in batches of 25 ─────────────────────────────────────────────
    // step.sleep is called at TOP LEVEL — never inside step.run.

    let invited = 0
    const batches = []
    for (let i = 0; i < vendors.length; i += BATCH_SIZE) {
      batches.push(vendors.slice(i, i + BATCH_SIZE))
    }

    for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
      const batch = batches[batchIdx]!

      const batchResult = await step.run(`process-batch-${batchIdx}`, async () => {
        let batchInvited = 0

        for (const vendor of batch) {
          try {
            const org = Array.isArray(vendor.organizations)
              ? vendor.organizations[0]
              : vendor.organizations
            const orgName = (org as { name?: string | null } | null)?.name ?? 'Your property manager'

            const { invited } = await ensureVendorConnectInvited({
              vendorId:           vendor.id,
              orgId:              vendor.org_id,
              vendorEmail:        vendor.email!,
              vendorName:         vendor.name,
              vendorConnectToken: vendor.stripe_connect_token!,
              orgName,
            })

            if (invited) batchInvited++
          } catch (_err) {
            // Log and continue — don't let one failed vendor abort the whole batch.
            // The next cron run will retry uninvited vendors.
            logger.error('[vendor-connect-cron] failed to onboard vendor', {
              vendorId: vendor.id,
              orgId:    vendor.org_id,
              // No email logged — PII rule
            })
          }
        }

        return batchInvited
      })

      invited += batchResult

      // Pace between batches — called at TOP LEVEL, never inside step.run
      if (batchIdx < batches.length - 1) {
        await step.sleep(`pace-batch-${batchIdx}`, '2s')
      }
    }

    logger.info(`[vendor-connect-cron] complete — invited ${invited} of ${vendors.length}`)
    return { invited, total: vendors.length }
  }
)
