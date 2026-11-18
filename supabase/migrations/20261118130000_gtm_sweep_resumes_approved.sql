-- The stall sweep must put an abandoned task back where it was, not at the start.
--
-- gtm_sweep_stalled_tasks() (20261118120000) returned every abandoned task to
-- 'pending'. That is right for a task that died while DOING its work, and wrong
-- for one that died while CARRYING OUT a proposal a person had already approved:
-- sent back to 'pending' it would redo the research and put a second approval in
-- front of the same person for the same thing.
--
-- The two are told apart by decided_at, which only a person's decision sets
-- (decideAgentTask) and which no worker ever writes. A claimed task that has one
-- was claimed from 'approved'. CREATE OR REPLACE keeps the existing owner and
-- grants; they are restated below so this file is correct on its own.

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
        status       = CASE
                         WHEN attempts + 1 >= max_attempts THEN 'failed'
                         WHEN decided_at IS NOT NULL       THEN 'approved'
                         ELSE 'pending'
                       END,
        completed_at = CASE WHEN attempts + 1 >= max_attempts THEN now() ELSE NULL END
    WHERE status = 'in_progress'
      AND claimed_at IS NOT NULL
      AND claimed_at < p_claimed_before
    RETURNING status
  )
  SELECT jsonb_build_object(
    'requeued', count(*) FILTER (WHERE status IN ('pending', 'approved')),
    'failed',   count(*) FILTER (WHERE status = 'failed')
  )
  FROM moved
$$;

REVOKE ALL ON FUNCTION public.gtm_sweep_stalled_tasks(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.gtm_sweep_stalled_tasks(timestamptz) TO service_role;
