
-- maintenance_schedule_template_items doesn't exist yet (Phase 9 Task 4)
-- Apply only what's safe now

ALTER TABLE maintenance_schedules
  ALTER COLUMN auto_create_wo SET DEFAULT true;

COMMENT ON COLUMN maintenance_schedules.auto_create_wo IS
  'When true, Inngest auto-creates a WO draft when next_due_date is reached.
   Vendor resolved via: (1) assigned_vendor_id, (2) specialty-matched vendor,
   (3) unassigned draft. Default changed to true 2026-06-05.';

ALTER TABLE maintenance_schedules
  ADD COLUMN IF NOT EXISTS vendor_specialty_hint vendor_specialty DEFAULT NULL;

COMMENT ON COLUMN maintenance_schedules.vendor_specialty_hint IS
  'Specialty hint for auto-WO vendor matching when assigned_vendor_id is NULL.
   Matched against vendors.specialty for this org. Set automatically from
   seed template items when broadcast. PM can override.';
