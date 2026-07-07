-- One user_id per org across crew_members. Backstops the .is('user_id', null)
-- guard in the accept-invite route. NULL rows (pre-acceptance) are excluded.
CREATE UNIQUE INDEX IF NOT EXISTS crew_members_user_org_unique
  ON public.crew_members(org_id, user_id)
  WHERE user_id IS NOT NULL;
