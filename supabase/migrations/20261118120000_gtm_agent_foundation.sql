-- GTM agent foundation: the shared infrastructure the lead-gen, content & brand,
-- sales-ops and rev-ops agent teams and their manager all run on.
--
-- Teams never call each other. They hand work over through agent_tasks (the
-- queue), a status change on prospect_accounts is the signal a handoff is
-- due, and Inngest events wake the next team. The manager reads and routes;
-- it does not do team work. Everything here is PLATFORM-admin only: this is
-- FieldStay's own go-to-market tooling, not tenant data, so there is no org_id
-- anywhere and every policy is is_platform_staff_admin() (the same gate
-- prospect_accounts and prospect_touches use).
--
--   gtm_team_settings  one row per team plus a 'global' master switch. Every
--                      team ships DISABLED and propose-only: turning an agent
--                      on is a deliberate act by an admin, never a deploy side
--                      effect.
--   agent_tasks        the work queue and the approval inbox. depth is capped
--                      in the DATABASE (see agent_tasks_depth_check): agents
--                      that spawn work from each other's output are the classic
--                      runaway, and a cap that only exists in application code
--                      is a cap one buggy caller can skip.
--   agent_usage        append-only spend ledger, which is what makes a daily
--                      cost cap enforceable rather than aspirational.
--   manager_decisions  append-only: every plan, review and brief the manager
--                      wrote, with the metrics it read, so an odd decision can
--                      be explained afterwards.
--
-- Idempotent throughout (IF NOT EXISTS / DROP POLICY IF EXISTS), per the
-- migration rules in CLAUDE.md.

-- ── gtm_team_settings ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.gtm_team_settings (
  -- Single-column PK on purpose: the team name IS the identity. 'global' is the
  -- master switch; a team runs only when BOTH its own row and 'global' are on.
  team                text PRIMARY KEY,

  enabled             boolean NOT NULL DEFAULT false,

  -- propose_only: everything the team produces waits in the approval inbox, and
  --   for the manager it means observe-only (it writes briefs, creates no tasks).
  -- auto_low_risk: the team may finish tasks that are not flagged
  --   requires_approval without a human. Never covers an external send until
  --   a template has been promoted deliberately.
  autonomy            text NOT NULL DEFAULT 'propose_only',

  -- Ceilings the manager divides work under and can never raise. Only an admin
  -- edits these. Cost is in cents so a cap is a plain integer comparison.
  daily_task_cap      integer NOT NULL DEFAULT 50,
  daily_cost_cap_cents integer NOT NULL DEFAULT 500,

  updated_by          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT gtm_team_settings_team_check CHECK (team IN (
    'global', 'manager', 'lead_gen', 'content_brand', 'sales_ops', 'rev_ops'
  )),
  CONSTRAINT gtm_team_settings_autonomy_check CHECK (autonomy IN (
    'propose_only', 'auto_low_risk'
  )),
  CONSTRAINT gtm_team_settings_caps_check CHECK (
    daily_task_cap >= 0 AND daily_cost_cap_cents >= 0
  )
);

CREATE INDEX IF NOT EXISTS gtm_team_settings_updated_by_idx
  ON public.gtm_team_settings (updated_by);

INSERT INTO public.gtm_team_settings (team) VALUES
  ('global'), ('manager'), ('lead_gen'), ('content_brand'), ('sales_ops'), ('rev_ops')
ON CONFLICT (team) DO NOTHING;

DROP TRIGGER IF EXISTS trg_gtm_team_settings_updated_at ON public.gtm_team_settings;
CREATE TRIGGER trg_gtm_team_settings_updated_at
  BEFORE UPDATE ON public.gtm_team_settings
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.gtm_team_settings ENABLE ROW LEVEL SECURITY;

-- ── agent_tasks ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.agent_tasks (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The team that OWNS the work. The manager is not here: it routes tasks, it
  -- does not own any.
  team             text NOT NULL,
  task_type        text NOT NULL,

  -- Most tasks concern one account; a Rev Ops rollup or a brand asset does not.
  -- CASCADE: a task about a deleted account has nothing left to act on.
  prospect_id      uuid REFERENCES public.prospect_accounts(id) ON DELETE CASCADE,

  status           text NOT NULL DEFAULT 'pending',
  priority         integer NOT NULL DEFAULT 50,

  input            jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- What the team produced (a draft, a research summary, a proposed status).
  -- This is exactly what the approval inbox shows.
  output           jsonb,

  -- A draft that goes to a person outside the company must be looked at.
  -- DEFAULT true: the safe answer is the default, opting out is the deliberate act.
  requires_approval boolean NOT NULL DEFAULT true,

  origin           text NOT NULL DEFAULT 'manager',
  parent_task_id   uuid REFERENCES public.agent_tasks(id) ON DELETE SET NULL,
  -- How many handoffs deep this task is from a manager or human origin. Capped
  -- at 4 below so a team can never create work from work it created, forever.
  depth            smallint NOT NULL DEFAULT 0,

  -- Optional replay guard. The unique index below is what actually stops a
  -- retried manager run or a replayed event from queueing the same job twice.
  dedupe_key       text,

  attempts         smallint NOT NULL DEFAULT 0,
  max_attempts     smallint NOT NULL DEFAULT 3,
  error            text,

  decided_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at       timestamptz,
  decision_note    text,

  claimed_at       timestamptz,
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agent_tasks_team_check CHECK (team IN (
    'lead_gen', 'content_brand', 'sales_ops', 'rev_ops'
  )),
  CONSTRAINT agent_tasks_status_check CHECK (status IN (
    'pending', 'in_progress', 'needs_approval', 'approved',
    'rejected', 'done', 'failed', 'cancelled'
  )),
  CONSTRAINT agent_tasks_origin_check CHECK (origin IN (
    'manager', 'human', 'lead_gen', 'content_brand', 'sales_ops', 'rev_ops'
  )),
  CONSTRAINT agent_tasks_depth_check    CHECK (depth BETWEEN 0 AND 4),
  CONSTRAINT agent_tasks_priority_check CHECK (priority BETWEEN 0 AND 100),
  CONSTRAINT agent_tasks_attempts_check CHECK (attempts >= 0 AND max_attempts >= 1),
  CONSTRAINT agent_tasks_type_len_check CHECK (char_length(task_type) BETWEEN 1 AND 80)
);

-- The dedupe key is the idempotency guard (db-invariants requires one on every
-- *dedupe_key column). Partial: NULL means "no protection needed".
CREATE UNIQUE INDEX IF NOT EXISTS agent_tasks_dedupe_key_uidx
  ON public.agent_tasks (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

-- A team's next claim: highest priority first, oldest first within it.
CREATE INDEX IF NOT EXISTS agent_tasks_queue_idx
  ON public.agent_tasks (team, status, priority DESC, created_at);

CREATE INDEX IF NOT EXISTS agent_tasks_prospect_idx    ON public.agent_tasks (prospect_id);
CREATE INDEX IF NOT EXISTS agent_tasks_parent_idx      ON public.agent_tasks (parent_task_id);
CREATE INDEX IF NOT EXISTS agent_tasks_decided_by_idx  ON public.agent_tasks (decided_by);

-- The stall sweep looks only at work that is stuck mid-flight or waiting on a
-- person, which is a tiny slice of a table that mostly holds finished rows.
CREATE INDEX IF NOT EXISTS agent_tasks_stall_idx
  ON public.agent_tasks (status, updated_at)
  WHERE status IN ('in_progress', 'needs_approval');

DROP TRIGGER IF EXISTS trg_agent_tasks_updated_at ON public.agent_tasks;
CREATE TRIGGER trg_agent_tasks_updated_at
  BEFORE UPDATE ON public.agent_tasks
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.agent_tasks ENABLE ROW LEVEL SECURITY;

-- ── agent_usage ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.agent_usage (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team           text NOT NULL,
  -- SET NULL: spend that already happened is still spend after its task is gone.
  task_id        uuid REFERENCES public.agent_tasks(id) ON DELETE SET NULL,
  model          text NOT NULL,
  input_tokens   integer NOT NULL DEFAULT 0,
  output_tokens  integer NOT NULL DEFAULT 0,
  -- Fractional cents: one Haiku call costs a small fraction of one, and
  -- rounding each call to a whole cent would make the ledger meaningless.
  cost_cents     numeric(12,4) NOT NULL DEFAULT 0,
  -- A retried Inngest step must not bill the same call twice. NULL means the
  -- caller has no replay to guard against.
  dedupe_key     text,
  occurred_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT agent_usage_team_check CHECK (team IN (
    'manager', 'lead_gen', 'content_brand', 'sales_ops', 'rev_ops'
  )),
  CONSTRAINT agent_usage_nonneg_check CHECK (
    input_tokens >= 0 AND output_tokens >= 0 AND cost_cents >= 0
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_usage_dedupe_key_uidx
  ON public.agent_usage (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS agent_usage_team_time_idx ON public.agent_usage (team, occurred_at DESC);
CREATE INDEX IF NOT EXISTS agent_usage_task_idx      ON public.agent_usage (task_id);

ALTER TABLE public.agent_usage ENABLE ROW LEVEL SECURITY;

-- ── manager_decisions ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.manager_decisions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind              text NOT NULL,
  -- The manager's autonomy WHEN it ran, so a record made in observe-only mode
  -- can never be misread later as something that acted.
  autonomy_at_run   text NOT NULL,
  brief             text NOT NULL,
  -- What it read (funnel counts, queue depth, spend) and what it did or
  -- proposed. Together these are the "why" for any decision it made.
  metrics           jsonb NOT NULL DEFAULT '{}'::jsonb,
  actions           jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- NULL when the brief was assembled deterministically with no model call.
  model             text,
  requested_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  dedupe_key        text,
  created_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT manager_decisions_kind_check CHECK (kind IN (
    'morning_plan', 'evening_review', 'stall_sweep', 'manual'
  ))
);

-- One scheduled brief per slot per day, so a retried cron step cannot write it twice.
CREATE UNIQUE INDEX IF NOT EXISTS manager_decisions_dedupe_key_uidx
  ON public.manager_decisions (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS manager_decisions_created_idx ON public.manager_decisions (created_at DESC);
CREATE INDEX IF NOT EXISTS manager_decisions_requested_by_idx ON public.manager_decisions (requested_by);

ALTER TABLE public.manager_decisions ENABLE ROW LEVEL SECURITY;

-- ── grants ──────────────────────────────────────────────────────────────────
-- Postgres checks the GRANT before RLS ever runs, so the grant is as much a
-- part of the policy as the policy is.
--
-- Supabase hands `authenticated` (and anon) full privileges on every new
-- public table by default, TRUNCATE included, and TRUNCATE is not subject to
-- RLS at all. So the first statement strips everything from every client role,
-- and the grants below add back only what the design calls for. Leaving that
-- to the defaults would have left the append-only ledgers truncatable by any
-- signed-in user.
--
--   settings   admin reads, and edits the five columns that are settings (never
--              the team key, which the CHECK and the seed rows depend on)
--   tasks      admin reads and DECIDES: the four decision columns only. What an
--              agent produced (output, requires_approval, depth, ...) is a
--              record, and a person approving it must not be able to rewrite it.
--              Creation is the manager's and the teams' job, through the service role.
--   usage, decisions   append-only. Admin reads, only the service role writes,
--              and nobody updates or deletes: the record of what the agents did
--              and spent should read the way it happened.
--
-- The two column-narrowed UPDATE grants are registered in
-- scripts/check-db-invariants.mjs (NARROWED_UPDATE_GRANTS), so a later
-- `GRANT UPDATE ON agent_tasks TO authenticated` fails CI instead of silently
-- widening this.

REVOKE ALL ON TABLE public.gtm_team_settings, public.agent_tasks,
                    public.agent_usage, public.manager_decisions
  FROM anon, authenticated, PUBLIC;

GRANT SELECT ON TABLE public.gtm_team_settings, public.agent_tasks,
                      public.agent_usage, public.manager_decisions
  TO authenticated;

GRANT UPDATE (enabled, autonomy, daily_task_cap, daily_cost_cap_cents, updated_by)
  ON TABLE public.gtm_team_settings TO authenticated;

GRANT UPDATE (status, decided_by, decided_at, decision_note)
  ON TABLE public.agent_tasks TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.gtm_team_settings, public.agent_tasks,
  public.agent_usage, public.manager_decisions
TO service_role;

-- ── policies ────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "gtm_team_settings_admin_select" ON public.gtm_team_settings;
CREATE POLICY "gtm_team_settings_admin_select"
  ON public.gtm_team_settings FOR SELECT
  USING (is_platform_staff_admin());

DROP POLICY IF EXISTS "gtm_team_settings_admin_update" ON public.gtm_team_settings;
CREATE POLICY "gtm_team_settings_admin_update"
  ON public.gtm_team_settings FOR UPDATE
  USING      (is_platform_staff_admin())
  WITH CHECK (is_platform_staff_admin());

DROP POLICY IF EXISTS "agent_tasks_admin_select" ON public.agent_tasks;
CREATE POLICY "agent_tasks_admin_select"
  ON public.agent_tasks FOR SELECT
  USING (is_platform_staff_admin());

DROP POLICY IF EXISTS "agent_tasks_admin_update" ON public.agent_tasks;
CREATE POLICY "agent_tasks_admin_update"
  ON public.agent_tasks FOR UPDATE
  USING      (is_platform_staff_admin())
  WITH CHECK (is_platform_staff_admin());

DROP POLICY IF EXISTS "agent_usage_admin_select" ON public.agent_usage;
CREATE POLICY "agent_usage_admin_select"
  ON public.agent_usage FOR SELECT
  USING (is_platform_staff_admin());

DROP POLICY IF EXISTS "manager_decisions_admin_select" ON public.manager_decisions;
CREATE POLICY "manager_decisions_admin_select"
  ON public.manager_decisions FOR SELECT
  USING (is_platform_staff_admin());

-- ── dashboard rollup ────────────────────────────────────────────────────────
-- One round trip for every number the Agents view shows, computed in the
-- database so no row ever crosses the wire (a few thousand accounts today,
-- and PostgREST would truncate a bare select at 1000 without saying so).
-- SECURITY INVOKER, deliberately: it runs as the caller, so the table policies
-- above decide what it can see and a non-admin gets zeros, not a bypass.

CREATE OR REPLACE FUNCTION public.gtm_dashboard_counts(
  p_touches_since timestamptz,
  p_spend_since   timestamptz
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'funnel', COALESCE((
      SELECT jsonb_object_agg(status, n)
      FROM (SELECT status, count(*) AS n FROM public.prospect_accounts GROUP BY status) f
    ), '{}'::jsonb),
    'touches', COALESCE((
      SELECT jsonb_object_agg(touch_type, n)
      FROM (
        SELECT touch_type, count(*) AS n
        FROM public.prospect_touches
        WHERE occurred_at >= p_touches_since
        GROUP BY touch_type
      ) t
    ), '{}'::jsonb),
    -- Live work plus the last 30 days of finished work: all-time counts would
    -- grow forever and say less each month.
    'tasks', COALESCE((
      SELECT jsonb_agg(jsonb_build_object('team', team, 'status', status, 'count', n))
      FROM (
        SELECT team, status, count(*) AS n
        FROM public.agent_tasks
        WHERE status IN ('pending', 'in_progress', 'needs_approval', 'approved')
           OR updated_at >= now() - interval '30 days'
        GROUP BY team, status
      ) a
    ), '[]'::jsonb),
    -- Drafts that have waited on a person past the warn threshold (48h; keep in
    -- step with APPROVAL_WAIT_WARN_HOURS in lib/gtm/constants.ts). The one
    -- number the manager cannot act on itself, so it is the one it must raise.
    'stale_approvals', (
      SELECT count(*)
      FROM public.agent_tasks
      WHERE status = 'needs_approval'
        AND updated_at < now() - interval '48 hours'
    ),
    'spend', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'team', team, 'cost_cents', cost_cents, 'calls', calls
      ))
      FROM (
        SELECT team, sum(cost_cents) AS cost_cents, count(*) AS calls
        FROM public.agent_usage
        WHERE occurred_at >= p_spend_since
        GROUP BY team
      ) u
    ), '[]'::jsonb)
  )
$$;

REVOKE ALL ON FUNCTION public.gtm_dashboard_counts(timestamptz, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.gtm_dashboard_counts(timestamptz, timestamptz)
  TO authenticated, service_role;

-- ── stalled-task sweep ──────────────────────────────────────────────────────
-- A task claimed by a worker that then died (deploy, timeout, crash) sits in
-- 'in_progress' forever and nothing else will ever touch it. This puts it back
-- in the queue, or marks it failed once it has used its attempts. One atomic
-- UPDATE rather than read-then-write per row: a second concurrent sweep finds
-- nothing left to move, so running it twice is the same as running it once.
-- Service role only. It rewrites task state, which is no admin's job.

CREATE OR REPLACE FUNCTION public.gtm_sweep_stalled_tasks(p_claimed_before timestamptz)
RETURNS jsonb
LANGUAGE sql
VOLATILE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH moved AS (
    UPDATE public.agent_tasks
    SET attempts     = attempts + 1,
        claimed_at   = NULL,
        error        = 'Stalled: claimed but never finished',
        status       = CASE WHEN attempts + 1 >= max_attempts THEN 'failed' ELSE 'pending' END,
        completed_at = CASE WHEN attempts + 1 >= max_attempts THEN now() ELSE NULL END
    WHERE status = 'in_progress'
      AND claimed_at IS NOT NULL
      AND claimed_at < p_claimed_before
    RETURNING status
  )
  SELECT jsonb_build_object(
    'requeued', count(*) FILTER (WHERE status = 'pending'),
    'failed',   count(*) FILTER (WHERE status = 'failed')
  )
  FROM moved
$$;

REVOKE ALL ON FUNCTION public.gtm_sweep_stalled_tasks(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gtm_sweep_stalled_tasks(timestamptz) TO service_role;

COMMENT ON TABLE public.gtm_team_settings IS
  'Per-team on/off, autonomy and daily caps for the GTM agents, plus a global master switch. Every team ships disabled and propose-only.';
COMMENT ON TABLE public.agent_tasks IS
  'GTM agent work queue and approval inbox. Teams hand work over through rows here, never by calling each other. depth is capped at 4 in the schema.';
COMMENT ON TABLE public.agent_usage IS
  'Append-only model spend ledger for the GTM agents. What makes a daily cost cap enforceable.';
COMMENT ON TABLE public.manager_decisions IS
  'Append-only log of every plan, review and brief the GTM manager agent produced, with the metrics it read.';
