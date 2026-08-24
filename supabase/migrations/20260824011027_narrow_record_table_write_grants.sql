-- Narrow three table-wide write grants to what the app actually writes.
--
-- Found by a grant audit that asked, table by table, "which columns does an
-- authenticated code path ever put in an UPDATE payload?" — and compared that
-- to what the GRANT permits. Same instrument and same reasoning as the
-- notifications one (20260824001028): Postgres checks the GRANT before RLS
-- ever evaluates, so a column grant is the only layer that can say "this column
-- and no other". RLS scopes ROWS. It has nothing to say about columns.
--
-- None of this is a cross-tenant hole — every policy involved is correctly
-- org-scoped, and every role involved is admin|manager. It is about tables that
-- hold a RECORD of what happened rather than data a user maintains, where the
-- write surface being wider than the write path is how a record stops being one.
--
-- SERVICE ROLE IS UNAFFECTED throughout: it holds its own table-level grants
-- and bypasses RLS, so every Inngest step, cron and webhook handler that writes
-- these tables in full keeps doing so.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- owner_transactions
--
-- The owner P&L ledger. One authenticated writer exists in the whole codebase —
-- toggleTransactionVisibility's `.update({ visible_to_owner })`. Everything
-- else that writes it (turnover-events, work-order-events, booking-events,
-- inventory-events, the Stripe invoice handler) is service role.
--
-- The table-wide grant let an admin rewrite `source_reference_id`, which is the
-- idempotency key those upserts collide against — clear it and the same work
-- order completion posts a second expense. And `source`, which is provenance on
-- a document that gets sent to a property owner.
--
-- deleteOwnerTransaction already refuses to delete an auto-posted row
-- (`.or('source.eq.manual,source.is.null')`) for exactly this reason. UPDATE
-- had no equivalent, so the thing DELETE refuses could be reached by relabelling
-- the row `manual` and then deleting it, or simply by zeroing the amount.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- assignment_outcomes
--
-- The crew-scoring learning loop's training data: which suggestion the PM
-- accepted or overrode, the duration, the rating. Every writer in the codebase
-- is a service-role client — the five `service.from('assignment_outcomes')`
-- upserts in turnovers/actions.ts, plus auto-assign-turnover, turnover-events
-- and crew-score-recompute. There is no authenticated write path, so the
-- INSERT/UPDATE/DELETE grants were pure surface behind a permissive policy.
--
-- SELECT stays: nothing in the app reads it as `authenticated` today either, but
-- reading your own org's scoring history is a coherent thing to want, and
-- revoking it buys nothing the RLS policy does not already give.
--
-- Its three WRITE policies are dropped in the same breath, and the invariant
-- gate is what insisted: with the grant gone they can never be evaluated, and
-- check 6 of check-db-invariants.mjs reports exactly this shape — a policy that
-- looks like permission and is not. Leaving them would make the next reader
-- believe a PM can correct an outcome row. The SELECT policy stays, so the
-- table does not become policy-less and needs no SERVICE_ROLE_ONLY_TABLES
-- entry.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- reviews
--
-- A guest's words, imported from a channel. The only authenticated writer is
-- reviews-client.tsx, a BROWSER component — so the update payload is entirely
-- caller-controlled, not merely caller-triggered — and it writes exactly
-- `{ response_status, updated_at }` twice (marking a draft ready, and confirming
-- it posted). The RepuGuard generate route uses the service client for its own
-- status write.
--
-- Table-wide UPDATE meant a PM could rewrite `rating`, `review_text` or `guest_name`
-- from devtools. Managing a reputation is what this feature is for; editing the
-- review being managed is not.

REVOKE UPDATE ON owner_transactions FROM authenticated;
GRANT  UPDATE (visible_to_owner) ON owner_transactions TO authenticated;

REVOKE INSERT, UPDATE, DELETE ON assignment_outcomes FROM authenticated;
DROP POLICY IF EXISTS assignment_outcomes_insert ON assignment_outcomes;
DROP POLICY IF EXISTS assignment_outcomes_update ON assignment_outcomes;
DROP POLICY IF EXISTS assignment_outcomes_delete ON assignment_outcomes;

REVOKE UPDATE ON reviews FROM authenticated;
GRANT  UPDATE (response_status, updated_at) ON reviews TO authenticated;
