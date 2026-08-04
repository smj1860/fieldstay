-- Drop the crew inventory count DRAFT/approval path.
--
-- Why this is safe to drop rather than freeze:
--
--   1. It was never reachable. The only code that ever wrote
--      inventory_count_drafts was app/crew/inventory/[propertyId]/page.tsx,
--      and nothing in the crew app ever linked to that page — the crew
--      inventory surface is a view inside the turnover detail screen
--      (app/crew/turnovers/[id]/InventoryView.tsx), reached from the
--      Assignments list. There was no navigation path to the draft flow at
--      all, so no crew member could submit a count for review even in
--      principle.
--   2. Consequently both tables held ZERO rows in production (verified
--      2026-08-04 against this project). There is no history to preserve and
--      nothing to backfill.
--   3. Product decision (2026-08-04): a crew inventory count does not need PM
--      approval. The PM can override a count by editing the quantity; gating
--      the count behind a review step was never wanted. That removes the only
--      thing that distinguished these tables from inventory_counts /
--      inventory_count_items, which is the family the PM's own counts already
--      use and which the restock pipeline (inventory/count-submitted →
--      lib/inngest/functions/inventory-events.ts) reads.
--
-- Dropping them also retires the "two inventory tables with different column
-- names — do not mix" trap in CLAUDE.md and its guardrail test, because after
-- this there is only one count family.
--
-- approve_inventory_count_draft() goes with them: it exists solely to apply a
-- draft's quantities and mark it approved. apply_inventory_counts() — used by
-- the PM path and by the crew route — is unaffected and remains the single
-- way counted quantities reach inventory_items.

DROP FUNCTION IF EXISTS public.approve_inventory_count_draft(uuid, uuid, uuid);

-- Child first, though the FK cascade would handle it either way.
DROP TABLE IF EXISTS public.inventory_count_draft_items;
DROP TABLE IF EXISTS public.inventory_count_drafts;
