DROP TRIGGER IF EXISTS trg_sync_crew_assignment ON turnover_assignments;
DROP TRIGGER IF EXISTS trg_sync_crew_instance ON checklist_instances;
DROP FUNCTION IF EXISTS sync_powersync_crew_on_assignment();
DROP FUNCTION IF EXISTS sync_powersync_crew_on_instance();
