
-- Replace static powersync_crew_* tables with live views.
-- Static tables go stale — views always reflect current assignments.

DROP TABLE IF EXISTS public.powersync_crew_turnovers  CASCADE;
DROP TABLE IF EXISTS public.powersync_crew_instances  CASCADE;
DROP TABLE IF EXISTS public.powersync_crew_properties CASCADE;

-- ── View 1: user_id → turnover_id
CREATE VIEW public.powersync_crew_turnovers AS
SELECT
  cm.user_id,
  ta.turnover_id
FROM public.crew_members cm
JOIN public.turnover_assignments ta ON ta.crew_member_id = cm.id
WHERE cm.is_active = true;

-- ── View 2: user_id → instance_id
CREATE VIEW public.powersync_crew_instances AS
SELECT
  cm.user_id,
  ci.id AS instance_id
FROM public.crew_members cm
JOIN public.turnover_assignments ta ON ta.crew_member_id = cm.id
JOIN public.checklist_instances ci  ON ci.turnover_id    = ta.turnover_id
WHERE cm.is_active = true;

-- ── View 3: user_id → property_id
CREATE VIEW public.powersync_crew_properties AS
SELECT
  cm.user_id,
  t.property_id
FROM public.crew_members cm
JOIN public.turnover_assignments ta ON ta.crew_member_id = cm.id
JOIN public.turnovers t             ON t.id              = ta.turnover_id
WHERE cm.is_active = true;

-- ── View 4: user_id → org_id (new — needed for messages + crew_availability)
CREATE VIEW public.powersync_crew_orgs AS
SELECT
  user_id,
  org_id
FROM public.crew_members
WHERE is_active = true;

-- Grant SELECT to authenticated so PowerSync can query them
GRANT SELECT ON public.powersync_crew_turnovers  TO authenticated;
GRANT SELECT ON public.powersync_crew_instances  TO authenticated;
GRANT SELECT ON public.powersync_crew_properties TO authenticated;
GRANT SELECT ON public.powersync_crew_orgs       TO authenticated;

COMMENT ON VIEW public.powersync_crew_turnovers IS
  'PowerSync parameter helper — user_id → turnover_id. Read-only, do not write.';
COMMENT ON VIEW public.powersync_crew_instances IS
  'PowerSync parameter helper — user_id → instance_id. Read-only, do not write.';
COMMENT ON VIEW public.powersync_crew_properties IS
  'PowerSync parameter helper — user_id → property_id. Read-only, do not write.';
COMMENT ON VIEW public.powersync_crew_orgs IS
  'PowerSync parameter helper — user_id → org_id. Read-only, do not write.';
