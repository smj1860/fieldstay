-- Templates Hub — Pass 4: drop dead org_master_maintenance_schedules.
--
-- Written only by app/(dashboard)/setup/maintenance-template/page.tsx
-- (replaced with a pure explainer/pointer in this pass) via
-- saveMasterMaintenanceSchedules (app/(dashboard)/setup/maintenance-template/
-- actions.ts, deleted in this pass) — read by nothing. Confirmed via
-- full-repo grep before writing this migration, no FK dependents.

DROP TABLE IF EXISTS public.org_master_maintenance_schedules;
