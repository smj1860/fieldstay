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
// ── Batched, resumable purges (2026-09-16 scalability pass) ─────────────────
//
// Each explicit per-table purge below used to be ONE indivisible
// `DELETE FROM t WHERE org_id = $1` PostgREST call. Past the Inngest step
// budget (~300s), Postgres rolls back the WHOLE statement, and a retry
// re-issues the identical statement against the UNREDUCED row count — a table
// that has ever grown past what one statement can clear in the budget could
// never finish purging, no matter how many retries Inngest gave it.
//
// purgeTableInBatches() (below) fixes this via the `purge_org_table_batch()`
// SECURITY DEFINER RPC (supabase/migrations/*_add_purge_org_table_batch.sql),
// which deletes at most PURGE_BATCH_SIZE rows per call and reports how many it
// removed. The loop calls it — one step.run per batch, each independently
// retryable — until a call reports fewer than a full batch. A run that dies on
// table 4's 30th batch resumes at batch 30, not at table 4's first row.
//
// This does NOT reach into the big one: `DELETE FROM organizations WHERE
// id = $1` still cascades to every table with a real FK to organizations
// (properties, bookings, turnovers, and dozens more — verified against the
// live FK graph 2026-09-16) in ONE statement, same as before. Explicitly
// batch-purging that entire cascade tree ahead of time was investigated and
// rejected for this pass: most of those tables are plan-capped or
// per-property-bounded (CLAUDE.md's semgrep `-org-scoped` tier already audits
// exactly this — which of them grow with an org's SIZE, which grow with TIME),
// so the tables actually at risk of outrunning the statement budget are
// small in number and are exactly the ones already purged explicitly below —
// which is also where the FK graph forced them to be pre-cleared anyway (see
// the NO ACTION note on ORG_TABLES_BLOCKING_CASCADE). If a genuinely
// time-growing table is ever added directly under `organizations` without its
// own explicit purge here, extend ORG_PURGE_TABLES and the RPC's allow-list
// together, in FK order — do not assume the cascade will always be small
// enough.
// ============================================================

import { inngest }             from '@/lib/inngest/client'
import { createServiceClient } from '@/lib/supabase/server'
import { reportError }         from '@/lib/observability/report-error'

/**
 * Tables that must be cleared BEFORE the organizations row, because they hold
 * a non-cascading FK to another table that IS in the cascade tree. Postgres
 * does not order cascade actions among independent direct children of the
 * SAME parent, so leaving these to the cascade can abort the whole DELETE
 * with a foreign-key violation. Re-verified against the live FK graph
 * 2026-09-16 (`pg_constraint.confdeltype`), which is what turned up two
 * entries the 2026-07-30 note missed:
 *   work_order_invoices.property_id -> properties   ON DELETE NO ACTION
 *   work_order_invoices.vendor_id   -> vendors      ON DELETE NO ACTION
 *   work_order_invoices.work_order_id -> work_orders ON DELETE NO ACTION
 *   owner_transactions.property_id -> properties    ON DELETE NO ACTION
 *   purchase_orders.property_id    -> properties    ON DELETE NO ACTION
 * owner_transactions and purchase_orders are BOTH, like work_order_invoices,
 * direct children of organizations (their own org_id FK is CASCADE) that also
 * hold a NO ACTION edge into properties — the identical hazard shape, just
 * never added here. It had not caused a visible failure only because
 * Postgres's cascade ordering among organizations' many direct children
 * happened not to hit it for any org purged so far, not because the edge
 * doesn't exist.
 *
 * ORDER WITHIN THIS ARRAY MATTERS: work_order_invoices must precede
 * work_orders (the NO ACTION edge above). owner_transactions and
 * purchase_orders reference neither each other nor work_orders with anything
 * stronger than SET NULL, so they may sit anywhere before it.
 */
export const ORG_TABLES_BLOCKING_CASCADE = [
  'work_order_invoices',
  'owner_transactions',
  'purchase_orders',
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

/**
 * Rows removed per `purge_org_table_batch()` RPC call. Matches the RPC's own
 * default — kept explicit here rather than omitted so the two stay visibly in
 * sync if either changes. Exported for the guardrail/unit tests that pin the
 * batching contract (0 rows, exactly one batch, more than one batch).
 */
export const PURGE_BATCH_SIZE = 5000

/**
 * Circuit breaker, not a real ceiling: at PURGE_BATCH_SIZE=5000 this is 5
 * million rows for ONE table for ONE org — an order of magnitude past
 * anything a real tenant should ever reach. Its only job is to turn a bug
 * (an RPC that never reports a short batch, a table whose org_id filter
 * somehow never converges) into a thrown, dead-lettered error instead of a
 * loop that runs one step per batch forever.
 */
export const MAX_BATCHES_PER_TABLE = 1000

/**
 * Purges `table`'s rows for `orgId` in bounded batches via the
 * `purge_org_table_batch()` RPC (supabase/migrations/*_add_purge_org_table_batch.sql),
 * one `step.run` per batch — so a run that dies mid-table resumes at the
 * batch it was on, not at the table's first row.
 *
 * `stepLabel` distinguishes the main purge pass from the final sweep of
 * ORG_TABLES_WITHOUT_CASCADE below — the same table is purged under two
 * different labels in one run, and step ids must not collide or Inngest's
 * memoization would treat the second pass as already done.
 *
 * A batch that comes back at exactly PURGE_BATCH_SIZE means "maybe more" —
 * the loop takes one more batch to confirm. A batch under PURGE_BATCH_SIZE
 * (including 0) means the table is drained for this org.
 */
async function purgeTableInBatches(
  step:      { run: (name: string, cb: () => Promise<number>) => Promise<number> },
  stepLabel: string,
  table:     string,
  orgId:     string,
): Promise<void> {
  for (let batch = 0; batch < MAX_BATCHES_PER_TABLE; batch++) {
    const deleted: number = await step.run(`${stepLabel}-${table}-${orgId}-batch-${batch}`, async (): Promise<number> => {
      const admin = createServiceClient({ system: 'inngest:account-deletion' })

      const { data, error } = await admin.rpc('purge_org_table_batch', {
        p_table_name: table,
        p_org_id:     orgId,
        p_batch_size: PURGE_BATCH_SIZE,
      })

      // Throw. The route used to return a 500 here and leave the caller to
      // notice; now a failure retries on its own and, once retries are
      // exhausted, reaches the dead-letter handler and the founder inbox.
      // Swallowing it would leave a half-purged org with a live auth user
      // and no signal anywhere.
      if (error) {
        reportError(error, {
          site:  `inngest.account-deletion.${stepLabel}`,
          orgId,
          extra: { table, batch },
        })
        throw new Error(
          `account-deletion: ${stepLabel} failed for ${table}/${orgId} (batch ${batch}): ${error.message}`
        )
      }

      return data as number
    })

    if (!deleted || deleted < PURGE_BATCH_SIZE) return
  }

  // MAX_BATCHES_PER_TABLE exhausted without draining to zero — see that
  // constant's own comment. This should never fire for real data; if it
  // does, dead-lettering to the founder inbox is the right outcome, not an
  // infinite loop or a silent partial purge.
  const err = new Error(
    `account-deletion: ${table}/${orgId} did not drain after ${MAX_BATCHES_PER_TABLE} batches ` +
    `of ${PURGE_BATCH_SIZE} rows — refusing to loop further`
  )
  reportError(err, { site: `inngest.account-deletion.${stepLabel}`, orgId, extra: { table } })
  throw err
}

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
      // Re-verify the invariant the route promised, at EXECUTION time, not
      // just at request time. assertSoleMember checked this once,
      // synchronously, when the deletion was requested — but this function
      // runs asynchronously and can be delayed by retries, so the check can
      // go stale: the requester invites a second member (or one who was
      // already invited finally accepts) between the request and this run.
      // Without re-checking, the job wakes up trusting the stale event
      // payload and deletes every row in an org that is no longer sole-
      // member-owned — including data belonging to a different, still-active
      // person who never asked for anything to be deleted.
      await step.run(`verify-sole-member-${orgId}`, async () => {
        const admin = createServiceClient({ system: 'inngest:account-deletion' })

        // Bounded to one row: this only needs to know whether ANY other
        // accepted member exists, never the full membership list, so
        // .neq(user_id) + .limit(1) both answers the question and avoids an
        // unbounded .select() (PostgREST's max_rows=1000 cap has no
        // truncation signal — see CLAUDE.md).
        const { data: others, error } = await admin
          .from('organization_members')
          .select('user_id')
          .eq('org_id', orgId)
          .not('invite_accepted_at', 'is', null)
          .neq('user_id', user_id)
          .limit(1)

        if (error) {
          reportError(error, { site: 'inngest.account-deletion.sole-member-recheck', orgId })
          throw new Error(`account-deletion: sole-member re-check failed for org ${orgId}: ${error.message}`)
        }

        if ((others ?? []).length > 0) {
          // The invariant the route promised no longer holds. Do NOT purge —
          // report it and let a human decide, rather than deleting a live
          // org out from under someone who never asked for it.
          reportError(new Error(
            `account-deletion: org ${orgId} gained ${others.length} member(s) since the ` +
            `deletion was requested — refusing to purge`,
          ), { site: 'inngest.account-deletion.sole-member-race', orgId })
          throw new Error(`account-deletion: org ${orgId} is no longer sole-member-owned by ${user_id}`)
        }

        return { orgId, verified: true }
      })

      for (const table of ORG_PURGE_TABLES) {
        await purgeTableInBatches(step, 'purge_org', table, orgId)
      }

      // The non-cascading tables were cleared above, one step per table, but
      // nothing locks the org against new writes in the window between that
      // sweep and this delete — a crew member's own session is untouched by
      // this flow (the sole-member check is about organization_members, not
      // crew_members), so a write into e.g. crew_availability that lands
      // after that table's purge but before the org row goes is caught by
      // neither: the purge already ran, and these tables have no FK to
      // organizations (that is the entire reason they're in this list), so
      // the final cascade below doesn't touch them either. Re-sweep
      // immediately before the org row goes to close that window.
      for (const table of ORG_TABLES_WITHOUT_CASCADE) {
        await purgeTableInBatches(step, 'purge_org_final_sweep', table, orgId)
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
      // attempt got this far and died on the response. The real signal is the
      // HTTP status Supabase's admin client attaches (404) — not a regex
      // against `error.message`'s wording, which is third-party prose this
      // codebase does not control. If GoTrue ever rewords "User not found" to
      // something the old regex missed, a legitimately-idempotent retry would
      // throw, exhaust all 5 retries, and dead-letter a false alarm to the
      // founder inbox for an account that was, in fact, already deleted. The
      // regex stays as a fallback for the rare case status is undefined.
      const alreadyGone = error && (error.status === 404 || /not[_ ]found/i.test(error.message))
      if (error && !alreadyGone) {
        reportError(error, { site: 'inngest.account-deletion.delete_user' })
        throw new Error(`account-deletion: deleteUser failed: ${error.message}`)
      }

      return { deleted: true }
    })

    logger.info(`[account-deletion] completed for ${orgIds.length} organization(s)`)

    return { orgs_purged: orgIds.length }
  }
)
