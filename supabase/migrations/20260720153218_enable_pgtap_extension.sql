-- Enables pgTAP for database-level unit tests (RLS cross-org denial tests
-- under supabase/tests/database/, run via `supabase test db`).
CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions;
