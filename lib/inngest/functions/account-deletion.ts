// lib/inngest/functions/account-deletion.ts
// ============================================================
// Triggered by: account/deletion.requested
// Fired by:     DELETE /api/account/delete, after every stage that can still
//               refuse has passed.
//
// This is the DESTRUCTIVE half of account deletion. It used to run inline on
// the request thread, which is the whole reason it moved:
//
//   * `DELETE FROM organizations WHERE id = $1` is ONE statement. Everything
//     it erases — 60 direct child tables and their descendants, verified
//     against the live FK graph — happens inside a single all-or-nothing
//     transaction. It cannot make partial progress, so retrying it costs
//     exactly as much as the first attempt.
//   * /api/account/delete has no `maxDuration` entry in vercel.json, so it
//     inherits the platform default — an order of magnitude less than the 300s
//     the Inngest route is given there.
//
//     Together those two facts mean a tenant whose cascade outruns the request
//     budget can NEVER delete their account: every attempt dies at the same
//     statement, rolls back, and returns a 500 the user is invited to retry
//     forever. For a deletion request that is a compliance problem, not just a
//     bad afternoon.
//
// Moving it here buys three things a request thread cannot: a 20x execution
// budget, automatic retries, and step-level checkpointing so a run that dies
// on table 7 resumes at table 7 instead of starting over. It is also in
// CRITICAL_FUNCTION_IDS (lib/inngest/functions/on-failure.ts), so a
// retry-exhausted purge emails the founder rather than vanishing — the
// orphaned-tenant outcome that this flow's own comments record finding in
// production on 2026-07-30.
//
// ── What this deliberately does NOT do ──────────────────────────────────────
//
// The audit paired this with an `organizations.status = 'pending_deletion'`
// flag that "blocks access via RLS immediately, before the batched purge
// finishes". Skipped, because the window it guards is already empty: the route
// refuses to proceed unless the caller is the org's SOLE member
// (assertSoleMember), so the only human with authenticated access to an org
// being purged is the one who just asked for it to be purged. Buying that with
// a new state every RLS policy in the schema has to learn is a large blast
// radius for no gain — and a mistake in it locks out live tenants.
//
// It also proposed chunking each table into `id IN (SELECT … LIMIT 5000)`
// batches. That is not expressible through PostgREST (no subqueries), and more
// to the point it would not touch the statement that actually matters: the
// cascade is triggered by deleting the organizations row, so bounding the
// explicit deletes leaves the one all-or-nothing statement exactly as large.
// Step-per-table checkpointing gets the resumability without pretending to
// solve that. If an org ever genuinely outruns 300s, the fix is a
// SECURITY DEFINER batched purge RPC, not smaller PostgREST calls.
// ============================================================

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { reportError }         from '@/lib/observability/report-error'

/**
 * Tables that must be cleared BEFORE the organizations row, because they hold
 * a non-cascading FK to another table that IS in the cascade tree. Postgres
 * does not order cascade actions, so leaving these to the cascade can abort
 * the whole DELETE with a foreign-key violation. Verified 2026-07-30:
 *   work_order_invoices.property_id -> properties   ON DELETE RESTRICT
 *   work_order_invoices.vendor_id   -> vendors      ON DELETE RESTRICT
 *   work_orders.reported_by_crew_member_id -> crew_members  ON DELETE NO ACTION
 * Deleting invoices then work orders clears all three edges; every other FK
 * inside the organizations cascade tree is CASCADE or SET NULL.
 */
export const ORG_TABLES_BLOCKING_CASCADE = [
  'work_order_invoices',
  'work_orders',
] as const

/**
 * Org-scoped tables that do NOT (yet) have a FOREIGN KEY to organizations, so
 * deleting the organizations row does not cascade to them.
 *
 * A safety net, not a duplicate of the cascade: as the FK backfill lands, an
 * entry here simply becomes a no-op that removes rows the cascade would have
 * removed anyway, so it stays correct in both worlds. Re-checked against the
 * live FK graph on 2026-08-09 — all but `maintenance_schedule_templates` now
 * DO carry `ON DELETE CASCADE`, and they are kept precisely because "the
 * cascade covers it" is a claim that has to be re-verified per environment,
 * not assumed from production.
 *
 * Order is FK-safe: none of these reference each other, and all of their own
 * child tables (e.g. inventory_template_items, inventory_count_items) cascade
 * from the parent rows removed here.
 */
export const ORG_TABLES_WITHOUT_CASCADE = [
  'asset_depreciation_entries',
  'assignment_outcomes',
  'vendor_assignment_outcomes',
  'crew_availability',
  'inventory_templates',
  'maintenance_schedule_templates',
  'messages',
] as const

/**
 * Organizations purged in a single run. See the bound check in the handler for
 * why this is a hard stop rather than a truncation.
 */
const MAX_ORGS_PER_DELETION = 25

export const ORG_PURGE_TABLES = [
  ...ORG_TABLES_BLOCKING_CASCADE,
  ...ORG_TABLES_WITHOUT_CASCADE,
] as const

export const accountDeletion = inngest.createFunction(
  {
    id:   'account-deletion',
    name: 'Account: Purge Organizations and Delete Auth User',
    // Higher than the platform default. Every step here is idempotent (a
    // DELETE by org_id is a no-op the second time), the work is irreversible
    // and unrepeatable by the user — their session is gone by the time this
    // runs — and a terminal failure orphans a tenant nobody can reach. Cheap
    // retries are exactly the right trade.
    retries: 5,
    // One deletion at a time per user, so a double-submit that slipped past
    // the route's throttle cannot race two purges against the same orgs.
    concurrency: { limit: 1, key: 'event.data.user_id' },
  },
  { event: 'account/deletion.requested' as const },
  async ({ event, step, logger }) => {
    const { user_id, owned_org_ids } = event.data

    // Bound the fan-out before it becomes one. Every org here is an org the
    // caller OWNS and is the SOLE member of, which in practice means one — the
    // route walks their memberships and refuses any org with another member in
    // it. A payload with dozens is not a big customer, it is a malformed event
    // or a bug upstream, and the step count would grow with it.
    //
    // Truncating would be the wrong bound for a deletion: an org silently
    // dropped from the list is a tenant that is never purged and that nothing
    // ever revisits. So the slice is the visible cap and the mismatch is a hard
    // stop — it dead-letters to the founder inbox with the org ids intact,
    // which is recoverable. A quiet short purge is not.
    const orgIds = owned_org_ids.slice(0, MAX_ORGS_PER_DELETION)
    if (orgIds.length !== owned_org_ids.length) {
      throw new Error(
        `account-deletion: refusing to purge ${owned_org_ids.length} organizations in one run ` +
        `(cap ${MAX_ORGS_PER_DELETION}) — this is not a shape the sole-member check can produce`
      )
    }

    // Step PER TABLE PER ORG, not one step for the whole purge. Inngest
    // memoizes completed steps, so a run killed partway resumes at the first
    // unfinished table instead of replaying deletes that already succeeded.
    // That is the resumability the request thread never had, and it is why
    // this loop is a fan of step boundaries rather than a single step with a
    // loop inside it.
    for (const orgId of orgIds) {
      for (const table of ORG_PURGE_TABLES) {
        await step.run(`purge-${table}-${orgId}`, async () => {
          const admin = createServiceClient({ system: 'inngest:account-deletion' })

          const { error } = await admin.from(table).delete().eq('org_id', orgId)

          // Throw. The route used to return a 500 here and leave the caller to
          // notice; now a failure retries on its own and, once retries are
          // exhausted, reaches the dead-letter handler and the founder inbox.
          // Swallowing it would leave a half-purged org with a live auth user
          // and no signal anywhere.
          if (error) {
            reportError(error, {
              site:  'inngest.account-deletion.purge_org',
              orgId,
              extra: { table },
            })
            throw new Error(`account-deletion: failed to purge ${table} for org ${orgId}: ${error.message}`)
          }

          return { table, orgId }
        })
      }

      await step.run(`delete-organization-${orgId}`, async () => {
        const admin = createServiceClient({ system: 'inngest:account-deletion' })

        // The cascade. Deleting the organizations row is what actually erases
        // the tenant — properties, bookings (guest_name/guest_email),
        // owner_transactions, work_orders, guidebook_guest_sms_optins,
        // communication_logs and the rest. Deleting only the auth user leaves
        // ALL of it behind, unreachable by RLS and never purged; that is
        // exactly how the two orphaned orgs found in production on 2026-07-30
        // (10 properties, 20 bookings carrying guest PII) came to exist.
        const { error } = await admin.from('organizations').delete().eq('id', orgId)

        if (error) {
          reportError(error, { site: 'inngest.account-deletion.delete_org', orgId })
          throw new Error(`account-deletion: failed to delete organization ${orgId}: ${error.message}`)
        }

        return { orgId }
      })

      logger.info(`[account-deletion] purged organization ${orgId}`)
    }

    // LAST, and still last for the reason the synchronous version gave: while
    // the auth user exists the tenant is reachable and the purge is
    // re-drivable. Delete it first and a failed purge is an orphan nobody can
    // find. Cascades to profiles and to any remaining organization_members
    // rows for orgs the user did not own.
    await step.run('delete-auth-user', async () => {
      const admin = createServiceClient({ system: 'inngest:account-deletion' })

      const { error } = await admin.auth.admin.deleteUser(user_id)

      // A user already gone is the retry case, not a failure: the previous
      // attempt got this far and died on the response. Anything else throws.
      if (error && !/not[_ ]found/i.test(error.message)) {
        reportError(error, { site: 'inngest.account-deletion.delete_user' })
        throw new Error(`account-deletion: deleteUser failed: ${error.message}`)
      }

      return { deleted: true }
    })

    logger.info(`[account-deletion] completed for ${orgIds.length} organization(s)`)

    return { orgs_purged: orgIds.length }
  }
)
