-- Manager instructions, second pass.
--
--   manager_instructions.unmet   the parts of a reply that no catalog action
--                                covers, in the person's own terms. Shown on the
--                                card, and the evidence for which action to build
--                                next. Text only, written by the manager.
--   manager_playbook kinds       two new instruction types (redraft_rejected,
--                                enrich_ownerrez), so the CHECK must admit them
--                                or a person could never let the manager take
--                                them over.
--
-- Idempotent throughout, per the migration rules in CLAUDE.md.

ALTER TABLE public.manager_instructions
  ADD COLUMN IF NOT EXISTS unmet text[] NOT NULL DEFAULT '{}'::text[];

ALTER TABLE public.manager_playbook DROP CONSTRAINT IF EXISTS manager_playbook_kind_check;
ALTER TABLE public.manager_playbook
  ADD CONSTRAINT manager_playbook_kind_check CHECK (action_kind IN (
    'requeue_failed', 'run_funnel_report', 'propose_queue_candidates',
    'redraft_rejected', 'enrich_ownerrez'
  ));
