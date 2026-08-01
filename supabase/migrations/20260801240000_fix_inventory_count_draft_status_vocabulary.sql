-- ============================================================================
-- BLOCKER: no crew inventory count could ever be submitted.
--
-- inventory_count_drafts.status carried the vocabulary from the table's
-- original 2026-06-04 design:
--
--   CHECK (status IN ('draft', 'submitted', 'approved', 'rejected'))
--   DEFAULT 'draft'
--
-- Every piece of shipped code uses a DIFFERENT vocabulary, and has since the
-- crew count flow was built:
--
--   app/api/crew/inventory-count/route.ts   inserts status = 'pending_review'
--   app/(dashboard)/inventory/page.tsx      lists  .eq('status','pending_review')
--   types/database.ts InventoryCountDraft   'pending_review' | 'approved' | 'rejected'
--
-- So the crew submission INSERT violated the check constraint (23514) on every
-- single attempt. The route logged it and returned 500, the Dexie outbox
-- retried it forever, and the count was never recorded — while the PM's review
-- queue filtered on a status the constraint made unreachable anyway, so it was
-- permanently empty and gave no hint that anything was being lost.
--
-- Confirmed: ZERO inventory_count_drafts rows exist on either project, which is
-- exactly what a constraint that rejects 100% of inserts produces. Nothing has
-- ever been written under the old vocabulary, so replacing it (rather than
-- widening it to hold both) leaves no rows behind and no dead status the UI
-- cannot render.
--
-- The code is the authority here, not the constraint: three separate call
-- sites plus the TypeScript row type all agree, and 'draft'/'submitted' are
-- written by nothing and read by nothing.
-- ============================================================================

ALTER TABLE public.inventory_count_drafts
  DROP CONSTRAINT IF EXISTS inventory_count_drafts_status_check;

ALTER TABLE public.inventory_count_drafts
  ALTER COLUMN status SET DEFAULT 'pending_review';

ALTER TABLE public.inventory_count_drafts
  ADD CONSTRAINT inventory_count_drafts_status_check
  CHECK (status IN ('pending_review', 'approved', 'rejected'));

NOTIFY pgrst, 'reload schema';
