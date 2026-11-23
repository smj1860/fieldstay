-- Manager instructions: a person replies to the manager's brief, the manager
-- turns the reply into a proposal, a person approves it, and over time a person
-- can let the manager repeat an instruction type on its own cadence.
--
--   manager_instructions  one row per reply (source 'human') or per standing run
--                         (source 'standing'). The proposal, the person's
--                         decision and the outcome all live on the row, so
--                         "what did the manager do because of what I said" is
--                         one query. SELECT-only for admins; every write goes
--                         through a Server Action or an Inngest step on the
--                         service role, so there is no UPDATE grant to narrow.
--   manager_playbook      standing permission, one row per instruction type.
--                         A row means a person was asked and answered; the
--                         manager never writes `standing = true` itself.
--
-- Platform-admin tooling, not tenant data: no org_id, every policy is
-- is_platform_staff_admin(), same gate as the rest of the GTM tables.
--
-- Idempotent throughout (IF NOT EXISTS / DROP POLICY IF EXISTS).

-- ── manager_instructions ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.manager_instructions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source        text NOT NULL DEFAULT 'human',
  -- What the person wrote. For a standing run, a one-line description of what
  -- the manager did on its own, so the history reads the same either way.
  instruction   text NOT NULL,
  brief_id      uuid REFERENCES public.manager_decisions(id) ON DELETE SET NULL,
  requested_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  status        text NOT NULL DEFAULT 'interpreting',
  -- The manager's plain-language answer: what it understood, or why it could not.
  reply         text,
  -- The actions it proposes, each { kind, params, summary }. Validated against
  -- the code's catalog before it is stored, never trusted as the model wrote it.
  proposal      jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- The kinds in `proposal`, kept as a column so learning what a person approves
  -- is a plain query instead of a walk through JSON.
  action_kinds  text[] NOT NULL DEFAULT '{}'::text[],
  result        jsonb,
  -- NULL when no model was involved (a standing run, or an unreadable reply).
  model         text,
  decided_by    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  decided_at    timestamptz,
  applied_at    timestamptz,
  dedupe_key    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT manager_instructions_source_check CHECK (source IN ('human', 'standing')),
  CONSTRAINT manager_instructions_status_check CHECK (status IN (
    'interpreting', 'proposed', 'unclear', 'rejected', 'applying', 'applied', 'failed'
  )),
  CONSTRAINT manager_instructions_length_check CHECK (char_length(instruction) BETWEEN 1 AND 1000)
);

-- A standing run is keyed per kind per day, so a retried cron step records it once.
CREATE UNIQUE INDEX IF NOT EXISTS manager_instructions_dedupe_key_uidx
  ON public.manager_instructions (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS manager_instructions_created_idx      ON public.manager_instructions (created_at DESC);
CREATE INDEX IF NOT EXISTS manager_instructions_brief_id_idx     ON public.manager_instructions (brief_id);
CREATE INDEX IF NOT EXISTS manager_instructions_requested_by_idx ON public.manager_instructions (requested_by);
CREATE INDEX IF NOT EXISTS manager_instructions_decided_by_idx   ON public.manager_instructions (decided_by);

ALTER TABLE public.manager_instructions ENABLE ROW LEVEL SECURITY;

-- ── manager_playbook ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.manager_playbook (
  -- Single-column PK on purpose: the instruction type IS the identity.
  action_kind          text PRIMARY KEY,
  -- True only after a person said "yes, do this on your own". Default off.
  standing             boolean NOT NULL DEFAULT false,
  granted_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at           timestamptz,
  last_standing_run_at timestamptz,
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT manager_playbook_kind_check CHECK (action_kind IN (
    'requeue_failed', 'run_funnel_report', 'propose_queue_candidates'
  ))
);

CREATE INDEX IF NOT EXISTS manager_playbook_granted_by_idx ON public.manager_playbook (granted_by);

ALTER TABLE public.manager_playbook ENABLE ROW LEVEL SECURITY;

-- ── grants ──────────────────────────────────────────────────────────────────
-- Strip the defaults first (Supabase hands `authenticated` everything, TRUNCATE
-- included, and TRUNCATE ignores RLS), then add back only SELECT.

REVOKE ALL ON TABLE public.manager_instructions, public.manager_playbook
  FROM anon, authenticated, PUBLIC;

GRANT SELECT ON TABLE public.manager_instructions, public.manager_playbook
  TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  public.manager_instructions, public.manager_playbook
TO service_role;

-- ── policies ────────────────────────────────────────────────────────────────

DROP POLICY IF EXISTS "manager_instructions_admin_select" ON public.manager_instructions;
CREATE POLICY "manager_instructions_admin_select"
  ON public.manager_instructions FOR SELECT
  USING (is_platform_staff_admin());

DROP POLICY IF EXISTS "manager_playbook_admin_select" ON public.manager_playbook;
CREATE POLICY "manager_playbook_admin_select"
  ON public.manager_playbook FOR SELECT
  USING (is_platform_staff_admin());
