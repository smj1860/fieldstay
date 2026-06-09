-- ─────────────────────────────────────────────────────────────────────────────
-- GRANT authenticated access to tables that are missing role-level privileges.
--
-- Supabase requires two layers before a row is accessible:
--   1. GRANT — the role must have the privilege on the table
--   2. RLS policy — the row-level security policy must allow access
--
-- These tables were created with RLS policies but without granting privileges
-- to the `authenticated` role, causing "permission denied" errors before RLS
-- is even evaluated — regardless of role, including the 'owner' role.
-- ─────────────────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.communication_logs
  TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.maintenance_schedule_templates
  TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.maintenance_schedule_template_items
  TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.messages
  TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.crew_availability
  TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.property_assets
  TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.asset_depreciation_entries
  TO authenticated;

-- asset_type_standards is a read-only seed catalog — SELECT only for authenticated
GRANT SELECT ON TABLE public.asset_type_standards
  TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.assignment_outcomes
  TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vendor_compliance_documents
  TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.quote_requests
  TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.push_subscriptions
  TO authenticated;

-- wo_number_counters is updated only via a SECURITY DEFINER function —
-- authenticated users do not need direct table access
-- stripe_processed_events is service_role only (webhook dedup) — intentionally excluded
-- powersync_crew_* tables are managed by the PowerSync sync engine — skip

-- ─────────────────────────────────────────────────────────────────────────────
-- Vendor address columns
--
-- Adds address, city, and state to the vendors table for:
--   • More precise geocoding (full address vs zip-only)
--   • Display in vendor card / compliance views
--   • GDPR data export completeness (business contact data)
--
-- All three columns are nullable TEXT so they are backwards-compatible.
-- Existing rows remain unchanged. RLS on vendors table already restricts
-- reads to org members only — no additional policies needed.
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS address text,
  ADD COLUMN IF NOT EXISTS city    text,
  ADD COLUMN IF NOT EXISTS state   text;
