-- Templates Hub — Pass 2: drop dead master-checklist code path.
--
-- app/(dashboard)/setup/checklist-template/page.tsx has already been
-- rebuilt onto RoomLibraryBuilder — master-checklist-builder.tsx and
-- saveMasterChecklistItems (the only caller of this RPC) are unreferenced
-- everywhere else in the app (verified via full-repo grep). Signature
-- confirmed against every CREATE OR REPLACE FUNCTION of this RPC in this
-- directory (20260609000002, 20260609103623, 20260704182808/182905) —
-- always (uuid, jsonb), never overloaded or changed.
--
-- org_master_maintenance_schedules (the Pass 4 equivalent) is untouched —
-- its onboarding page hasn't been rebuilt yet.

DROP FUNCTION IF EXISTS public.replace_master_checklist_items(uuid, jsonb);
DROP TABLE IF EXISTS public.org_master_checklist_items;
