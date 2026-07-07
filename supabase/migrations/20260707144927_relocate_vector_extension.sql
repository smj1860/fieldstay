-- The `vector` extension was installed into the `public` schema (Supabase
-- security-advisor "Extension in Public" warning). Move it to `extensions`,
-- the conventional home for extensions in this project (pgcrypto, uuid-ossp,
-- pg_stat_statements, hypopg, index_advisor all already live there).
--
-- match_kb_chunks() already sets `search_path = public, extensions` in
-- anticipation of this move (see security_definer_hardening migration), so
-- no function changes are needed here — existing columns of type `vector`
-- keep working since ALTER EXTENSION ... SET SCHEMA relocates the extension's
-- objects (including the `vector` type) without touching dependent columns.

ALTER EXTENSION vector SET SCHEMA extensions;

NOTIFY pgrst, 'reload schema';
