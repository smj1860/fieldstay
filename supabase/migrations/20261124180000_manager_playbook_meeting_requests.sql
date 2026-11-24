-- A sixth manager instruction type, draft_meeting_requests: the manager asks Sales
-- Ops for first emails that ask for a face-to-face meeting, to the accounts a
-- person supplied by list. The playbook CHECK must admit it or a person could
-- never let the manager repeat it. Same shape as 20261123220000.
--
-- Idempotent throughout, per the migration rules in CLAUDE.md.

ALTER TABLE public.manager_playbook DROP CONSTRAINT IF EXISTS manager_playbook_kind_check;
ALTER TABLE public.manager_playbook
  ADD CONSTRAINT manager_playbook_kind_check CHECK (action_kind IN (
    'requeue_failed', 'run_funnel_report', 'propose_queue_candidates',
    'redraft_rejected', 'enrich_ownerrez', 'draft_meeting_requests'
  ));
