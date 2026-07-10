-- guidebook-client.tsx subscribes to postgres_changes on guidebook_sponsors
-- and guidebook_configurations with an org_id filter (to reflect sponsor
-- activation/payment and grace-period state live), but neither table was
-- ever added to the supabase_realtime publication when it was created —
-- confirmed live in Postgres logs 2026-07-10 ("invalid column for filter
-- org_id"): Realtime can't validate a filter column against a table it
-- has no published schema for, regardless of whether the column actually
-- exists on the table itself. turnovers/checklist_instances/
-- checklist_instance_items/property_assets/messages (the other tables
-- this app subscribes to) are all already correctly published — these two
-- were simply missed.
ALTER PUBLICATION supabase_realtime ADD TABLE guidebook_sponsors;
ALTER PUBLICATION supabase_realtime ADD TABLE guidebook_configurations;
