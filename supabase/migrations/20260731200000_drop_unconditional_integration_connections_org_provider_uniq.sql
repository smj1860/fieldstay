-- ============================================================================
-- BLOCKER: an unconditional UNIQUE (org_id, provider_id) locks an entire org
-- out of a provider forever after the first member disconnects.
--
-- 20260616220727_fix_integration_connections_upsert_constraint.sql added
--   uq_integration_connections_org_provider  UNIQUE (org_id, provider_id)
-- with no WHERE clause. 20260707141456_integration_connections_org_ownership.sql
-- later added the INTENDED rule as a PARTIAL unique index
--   integration_connections_org_provider_active_uniq
--     UNIQUE (org_id, provider_id) WHERE status = 'active' AND org_id IS NOT NULL
-- ("at most ONE *active* connection per org/provider") but never dropped the
-- unconditional one.
--
-- revoke_integration_token() / disconnect_integration_token() keep the row and
-- keep org_id, only nulling the Vault secret ids and setting
-- status='revoked'/'disconnected'. So once ANY user in an org connects a
-- provider and later disconnects, store_integration_token()'s INSERT for a
-- DIFFERENT user in that same org violates the unconditional constraint, the
-- SECURITY DEFINER function raises, and the OAuth callback redirects with
-- `storage_failed`. Every non-active row in production is an org in exactly
-- that state today (3 error / 1 disconnected / 1 revoked, 0 active).
--
-- Verified before dropping:
--   * the partial index exists live and genuinely supersedes this constraint
--     for the intended invariant (one ACTIVE connection per org+provider);
--   * no code path does an `upsert(..., { onConflict: 'org_id,provider_id' })`
--     on integration_connections (there are no upserts on this table at all),
--     so nothing depends on this constraint being inferable for ON CONFLICT
--     — which a partial index could not serve anyway;
--   * idx_integration_connections_org_id still provides the FK covering index
--     for org_id after the unique index backing this constraint goes away, so
--     scripts/check-db-invariants.mjs stays green.
-- ============================================================================

ALTER TABLE public.integration_connections
  DROP CONSTRAINT IF EXISTS uq_integration_connections_org_provider;

-- Restated idempotently so this file is self-contained: the invariant we
-- actually want survives the drop above.
CREATE UNIQUE INDEX IF NOT EXISTS integration_connections_org_provider_active_uniq
  ON public.integration_connections (org_id, provider_id)
  WHERE status = 'active' AND org_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
