
-- Drop the helper views — they can't be added to the powersync publication
-- (Postgres logical replication does not support views).
-- The sync rules use published tables directly via bucket chaining instead.
DROP VIEW IF EXISTS public.powersync_crew_turnovers;
DROP VIEW IF EXISTS public.powersync_crew_instances;
DROP VIEW IF EXISTS public.powersync_crew_properties;
DROP VIEW IF EXISTS public.powersync_crew_orgs;
