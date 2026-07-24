-- Backfill 4 enum types that exist on production but were never captured in
-- any migration file: comm_recipient_type, comm_channel, comm_source
-- (communication_logs) and quote_request_status (quote_requests). They were
-- created directly on production via dashboard DDL, so
-- 20260618000002_baseline_schema_snapshot.sql — which declares columns of
-- these types — passed its BEGIN/ROLLBACK dry-run against production but
-- fails on a genuinely fresh project ("type ... does not exist"). Discovered
-- 2026-07-22 while bootstrapping the dedicated E2E project
-- (syhthijeqlnltufdawyb); values below were introspected read-only from
-- production pg_enum, and the E2E project received exactly this DDL.
--
-- No-op on production (all four types already exist). Ordering note: any
-- future fresh replay runs this AFTER the snapshot in filename order, which
-- is too late for the snapshot itself — fresh bootstraps should follow
-- docs/E2E_SETUP.md, and if another fresh project is ever stood up by raw
-- in-order replay, apply this file (or the snapshot's enum prerequisites)
-- first. Kept as a dated migration anyway so the types exist SOMEWHERE in
-- tracked history rather than only on live databases.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'comm_recipient_type') THEN
    CREATE TYPE comm_recipient_type AS ENUM ('vendor', 'crew');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'comm_channel') THEN
    CREATE TYPE comm_channel AS ENUM ('email', 'sms', 'phone', 'in_person', 'note');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'comm_source') THEN
    CREATE TYPE comm_source AS ENUM ('manual', 'system');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'quote_request_status') THEN
    CREATE TYPE quote_request_status AS ENUM ('pending', 'submitted', 'approved', 'declined', 'expired');
  END IF;
END $$;
