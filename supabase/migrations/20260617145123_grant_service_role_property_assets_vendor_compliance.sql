
-- service_role was missing standard grants on these two tables, causing
-- "permission denied" errors when the asset-health cron (which runs daily
-- at 13:00 UTC via createServiceClient()) tried to read/update them.
-- Every other table has these grants by default; these two were likely
-- created via a migration that didn't include Supabase's standard
-- grant-bootstrapping step.

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE
  ON property_assets TO service_role;

GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES, TRIGGER, TRUNCATE
  ON vendor_compliance_documents TO service_role;
