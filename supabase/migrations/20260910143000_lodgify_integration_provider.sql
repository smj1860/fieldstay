-- Register Lodgify as an API-key integration provider, so it resolves through
-- lib/integrations/registry.ts and stores its credential in Vault the same way
-- Hostaway does. Same pattern as OwnerRez/Kroger/Hospitable/Hostex/Hostaway.
--
-- is_active = false DELIBERATELY. The adapter, the sync, the daily reconcile
-- and the webhook route are all complete — what is missing is a live Lodgify
-- account to verify them against. Every response shape in
-- lib/integrations/providers/lodgify.types.ts is built from Lodgify's published
-- documentation rather than from a payload anyone has seen, and Lodgify
-- documents no webhook signature at all. Flip this to true in its own commit
-- once docs/Integrations/lodgify/ENABLEMENT.md is worked through against a real
-- account — mirrors the Hostex convention (20260816092239 held it false,
-- 20260816122829 flipped it) and the Guesty note in CLAUDE_INTEGRATIONS.md.
--
-- is_active = false is sufficient to keep Lodgify out of BOTH PM-facing
-- surfaces, verified against the queries themselves:
--   - Settings -> Integrations (app/(dashboard)/settings/integrations/page.tsx)
--     filters .eq('is_active', true), so the row never reaches the client.
--   - Setup -> PMS (app/(dashboard)/setup/pms/page.tsx) filters on the same
--     flag in addition to .in('id', PMS_PROVIDER_IDS), which DOES now list
--     'lodgify' — that list exists so a Lodgify-connected org counts as
--     PMS-connected everywhere (trial emails, the ops revenue nudge), and it
--     is the flag, not the list, that gates visibility.
--
-- auth_type 'api_key': the PM generates the key themselves in Lodgify under
-- Settings -> Public API. There is no OAuth app, no partner approval and no
-- app-level credential of ours involved anywhere in this integration.
INSERT INTO public.integration_providers (id, display_name, auth_type, is_active)
VALUES ('lodgify', 'Lodgify', 'api_key', false)
ON CONFLICT (id) DO NOTHING;
