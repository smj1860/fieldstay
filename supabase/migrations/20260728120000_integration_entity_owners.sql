-- ============================================================================
-- integration_entity_owners
--
-- Maps a provider-side entity id to the FieldStay org that owns it.
--
-- Why this exists: Hospitable webhooks are configured GLOBALLY in the partner
-- portal. With more than one connected org, an incoming webhook is otherwise
-- unattributable — the previous fallback picked an arbitrary active
-- connection, which silently wrote customer B's reservations into customer A's
-- org. resolveHospitableOwner() (lib/integrations/providers/hospitable-owner.ts)
-- prefers the webhook payload's own data.user.id (matched against
-- integration_connections.external_user_id) when present, and otherwise
-- probes each connection's token once per new entity — memoizing the answer
-- here so neither path ever repeats.
--
-- NOT org-scoped read data: this is internal routing metadata written and read
-- exclusively by service-role background jobs. RLS is enabled with NO
-- permissive policies, which is a deliberate deny-all for `authenticated` and
-- `anon`; service_role bypasses RLS. Do not add a SELECT policy without a
-- concrete product reason.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.integration_entity_owners (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id  text        NOT NULL,
  entity_kind  text        NOT NULL CHECK (entity_kind IN ('reservation', 'property', 'review')),
  external_id  text        NOT NULL,
  org_id       uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  resolved_via text        NOT NULL CHECK (resolved_via IN ('webhook_user_id', 'local', 'probe')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS integration_entity_owners_lookup_uniq
  ON public.integration_entity_owners (provider_id, entity_kind, external_id);

CREATE INDEX IF NOT EXISTS idx_integration_entity_owners_org_id
  ON public.integration_entity_owners (org_id);

ALTER TABLE public.integration_entity_owners ENABLE ROW LEVEL SECURITY;

-- Deny-all for anon/authenticated is intentional (see header). Explicitly
-- revoke rather than relying on the schema default, matching
-- 20260724130000_revoke_stale_anon_table_grants.sql.
REVOKE ALL ON public.integration_entity_owners FROM anon, authenticated;
