-- Register Hostex as an OAuth2 integration provider so it uses the existing
-- /api/integrations/[provider]/connect|callback routes and Vault-backed token
-- storage. Same pattern as OwnerRez/Kroger/Hospitable.
--
-- is_active = false deliberately: the adapter only supports the OAuth connect
-- flow at this point (Phase 1). No webhook handling, no sync functions yet.
-- Flip to true in its own commit once Phase 2 (webhooks) and Phase 3 (sync)
-- are live — mirrors the existing Guesty convention (see CLAUDE_INTEGRATIONS.md,
-- "Integration Registry" section).
--
-- is_active = false is sufficient to keep Hostex out of BOTH PM-facing
-- surfaces, verified against the queries themselves:
--   - Settings -> Integrations (app/(dashboard)/settings/integrations/page.tsx)
--     filters .eq('is_active', true), so the row never reaches the client.
--     HIDDEN_PROVIDER_IDS is not needed.
--   - Setup -> PMS (app/(dashboard)/setup/pms/page.tsx) additionally filters
--     .in('id', PMS_PROVIDER_IDS), which does not list 'hostex'.
-- The connect/callback ROUTES do not consult is_active at all — they resolve
-- the provider from lib/integrations/registry.ts — so the flow stays testable
-- by direct URL while the UI stays clean.
INSERT INTO public.integration_providers (id, display_name, auth_type, is_active)
VALUES ('hostex', 'Hostex', 'oauth2', false)
ON CONFLICT (id) DO NOTHING;
