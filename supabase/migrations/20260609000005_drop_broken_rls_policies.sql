-- Drop two RLS policies that reference a non-existent column `submitted_by`.
--
-- The security_idempotency_hardening migration wrote these policies assuming a
-- `submitted_by uuid` column on inventory_count_drafts, but the table was
-- created (in schema_history_gaps) with `crew_member_id` instead.
--
-- PostgreSQL resolves RLS policy expressions at query-plan time, so ANY INSERT
-- on these tables fails with "column submitted_by does not exist" even though
-- correct sibling policies (drafts_insert / draft_items_insert) also exist.
--
-- Those correct policies already provide appropriate org-scoped INSERT access
-- for all org members including crew, so simply dropping the broken ones
-- restores full crew INSERT capability with no security regression.

DROP POLICY IF EXISTS "icd_crew_insert"  ON public.inventory_count_drafts;
DROP POLICY IF EXISTS "icdi_crew_insert" ON public.inventory_count_draft_items;
