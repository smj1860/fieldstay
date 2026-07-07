
-- Annotate three server-side-only tables where RLS enabled + zero policies
-- is intentional design, not an oversight.
--
-- Zero policies + RLS enabled = anon/authenticated roles are denied by default
-- (PostgreSQL denies all access when no policy matches).
-- service_role bypasses RLS entirely — that is the only access path for these tables.
-- The Supabase Security Advisor flags these as warnings; they are false positives.

COMMENT ON TABLE public.oauth_states IS
  'Short-lived PKCE state tokens for OAuth flows. '
  'RLS enabled, no policies by design — service_role only. '
  'All reads/writes go through createServiceClient() in Route Handlers. '
  'Security Advisor warning on this table is a known false positive.';

COMMENT ON TABLE public.stripe_processed_events IS
  'Idempotency log for Stripe webhook event IDs. '
  'RLS enabled, no policies by design — service_role only. '
  'Written and read exclusively in the Stripe webhook Route Handler. '
  'Security Advisor warning on this table is a known false positive.';

COMMENT ON TABLE public.wo_number_counters IS
  'Per-org sequential counter for human-readable WO numbers (e.g. WO-0042). '
  'RLS enabled, no policies by design — service_role only. '
  'Updated exclusively via the next_wo_number() SECURITY DEFINER function. '
  'Security Advisor warning on this table is a known false positive.';
