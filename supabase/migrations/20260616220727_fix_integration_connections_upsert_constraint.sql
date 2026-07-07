
-- ================================================================
-- FIX 2: Add missing UNIQUE (org_id, provider_id) constraint
-- so the OAuth callback upsert ON CONFLICT resolves correctly.
-- The existing UNIQUE (user_id, provider_id) covers user-scoped
-- lookups; this covers org-scoped upserts used by storeIntegrationToken.
-- ================================================================

ALTER TABLE integration_connections
  ADD CONSTRAINT uq_integration_connections_org_provider
  UNIQUE (org_id, provider_id);
