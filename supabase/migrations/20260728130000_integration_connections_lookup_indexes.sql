-- Supporting indexes for two lookups that are not covered by the existing
-- single-column idx_integration_connections_{org_id,provider_id}:
--
--   (provider_id, external_user_id) — webhook revocation handling in
--     app/api/webhooks/[provider]/route.ts resolves the FieldStay connection
--     from the provider-side user id.
--
--   (provider_id, status) — resolveHospitableOwner() enumerates active
--     connections for the ownership probe on every uncached new entity.
--
-- Partial on external_user_id: rows without one are never a lookup target.

CREATE INDEX IF NOT EXISTS idx_integration_connections_provider_external_user
  ON public.integration_connections (provider_id, external_user_id)
  WHERE external_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_integration_connections_provider_status
  ON public.integration_connections (provider_id, status);
