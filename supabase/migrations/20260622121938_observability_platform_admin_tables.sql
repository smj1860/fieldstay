
-- Platform-wide observability: tables for Inngest job-run tracking and a
-- platform-admin allowlist. These hold CROSS-TENANT operational data (job
-- runs and DB/health visibility span every org), so access is gated by
-- platform_admins, NOT by organization_members.role like every other table
-- in this app. Never extend org-role RLS patterns to these two tables.

-- ── platform_admins ──────────────────────────────────────────────────────
-- Explicit allowlist of users who may see cross-tenant operational data.
-- No app UI manages this table — rows are inserted manually via SQL by
-- Stephen. This is intentional: granting platform-admin visibility is a
-- sensitive, infrequent action that should never be exposed as a clickable
-- app feature.
CREATE TABLE public.platform_admins (
  user_id    uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;

-- A logged-in user may check ONLY their own admin status (returns 0 or 1
-- rows) — this lets the app gate nav items client-side without ever
-- exposing the full admin list to any authenticated user.
CREATE POLICY "users_can_check_own_platform_admin_status"
  ON public.platform_admins FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

GRANT SELECT ON public.platform_admins TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.platform_admins TO service_role;

-- ── system_job_runs ──────────────────────────────────────────────────────
-- Self-reported Inngest function execution tracking, written by the app
-- itself (lib/inngest/observability.ts) rather than pulled from Inngest's
-- own API — keeps this fully in-house with no extra vendor credentials,
-- consistent with the existing integration_connections.metadata.last_sync_*
-- self-reported-health pattern already used for OwnerRez/Kroger.
CREATE TABLE public.system_job_runs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  function_id   text NOT NULL,
  function_name text NOT NULL,
  run_id        text NOT NULL,
  org_id        uuid REFERENCES public.organizations(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'started'
                  CHECK (status IN ('started', 'succeeded', 'failed')),
  attempt       integer NOT NULL DEFAULT 1,
  started_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz,
  duration_ms   integer,
  error_message text,
  error_stack   text,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),

  -- Authoritative idempotency backstop (per this project's established
  -- pattern): one row per (run_id, function_id). Retries UPDATE the existing
  -- row's attempt counter rather than racing to insert a duplicate.
  CONSTRAINT system_job_runs_run_function_unique UNIQUE (run_id, function_id)
);

CREATE INDEX idx_system_job_runs_function_started
  ON public.system_job_runs (function_id, started_at DESC);

CREATE INDEX idx_system_job_runs_org
  ON public.system_job_runs (org_id)
  WHERE org_id IS NOT NULL;

CREATE INDEX idx_system_job_runs_status
  ON public.system_job_runs (status);

-- Catches hung jobs (crashed before reaching the wrapper's catch block —
-- OOM, timeout, infra interruption) rather than just JS-catchable errors.
CREATE INDEX idx_system_job_runs_stuck
  ON public.system_job_runs (started_at)
  WHERE status = 'started';

ALTER TABLE public.system_job_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "platform_admins_can_view_job_runs"
  ON public.system_job_runs FOR SELECT
  TO authenticated
  USING (auth.uid() IN (SELECT user_id FROM public.platform_admins));

-- No INSERT/UPDATE/DELETE policy for authenticated/anon — every write comes
-- exclusively from the service-role tracking helper, which bypasses RLS.
GRANT SELECT ON public.system_job_runs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.system_job_runs TO service_role;
-- service_role grant is explicit and required — this codebase has already
-- hit 403s from missing service_role grants on tables that "looked" fine
-- (see 20260612170000_grant_integration_connections_service_role.sql).

-- ── Realtime (NOT PowerSync) ─────────────────────────────────────────────
-- This makes job-run changes streamable to an authenticated platform-admin
-- browser session via Supabase Realtime websockets (RLS-filtered, so only
-- rows the connected user's policy allows are delivered). This is a
-- DIFFERENT publication from `powersync` — do not confuse the two.
ALTER PUBLICATION supabase_realtime ADD TABLE public.system_job_runs;

-- ── Explicit PowerSync exclusion ─────────────────────────────────────────
-- platform_admins and system_job_runs must NEVER be added to the `powersync`
-- publication. They are platform-operator data, not tenant data, and have
-- no RLS path that would make per-device sync safe or meaningful.
