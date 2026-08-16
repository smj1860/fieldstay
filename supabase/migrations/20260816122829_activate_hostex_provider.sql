-- Hostex is now a fully-synced PMS provider: OAuth connect, property import,
-- reservation import, automatic owner-ledger revenue posting, and a daily
-- reconcile. is_active = true makes it selectable in Settings -> Integrations
-- and Setup -> PMS, which both filter on this flag.
--
-- Held at false since 20260816092239 precisely so it could be flipped in its
-- own commit once the sync existed, per the Guesty convention in
-- CLAUDE_INTEGRATIONS.md.
UPDATE public.integration_providers
SET    is_active = true
WHERE  id = 'hostex';
