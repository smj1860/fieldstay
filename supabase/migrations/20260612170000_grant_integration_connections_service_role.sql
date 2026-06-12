-- service_role had no grants at all on integration_connections — only anon and
-- authenticated were granted when this table was created (unlike properties,
-- bookings, etc., which all grant service_role full CRUD). This caused
-- "permission denied for table integration_connections" (403) on every
-- service-role query/update against this table, silently breaking:
--   - org_id link-up in the OAuth callback route (worked only because a prior
--     migration backfilled org_id directly via superuser)
--   - ownerrez-initial-sync's update-last-synced step (403 -> throws -> the
--     whole function permanently fails after 3 retries)
--   - ownerrez-reviews-sync (403s on its very first query, every run)
--   - /settings and /ops connection-status lookups via the admin client

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.integration_connections
  TO service_role;
