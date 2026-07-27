-- Fix: prevent_non_deletable_checklist_mutation() (20260628195657) was built
-- to stop a PM or a raw API call from deleting one mandatory asset-discovery
-- checklist_instance_item while its checklist/turnover stays alive ("the
-- existing UI-only guard... now enforced at the data layer"). It works for
-- that case, but Postgres fires the same BEFORE DELETE trigger for a
-- CASCADE-originated delete (deleting the item's own checklist_instance,
-- turnover, property, or organization) as for a direct delete on this
-- table — so once any non_deletable row exists anywhere in an org, that
-- org's properties/turnovers/org record can never be hard-deleted again via
-- any path, "regardless of the calling role."
--
-- No shipped feature hits this today (property deletion is archiveProperty()
-- — is_active = false; account deletion never touches organizations/
-- properties; GDPR erasure anonymizes booking rows, never deletes) — this
-- was discovered via lib/demo/seed.ts's org-reset wipe, the first code path
-- in the repo to ever attempt this cascade. Left unfixed, it would silently
-- block the next feature that needs a real hard delete (self-service org
-- deletion, an admin cleanup tool, etc.).
--
-- pg_trigger_depth() distinguishes the two cases: a direct DELETE issued
-- against checklist_instance_items fires this trigger at depth 1; a CASCADE
-- delete originating from an ancestor's FK fires it at depth 2, regardless
-- of how many FK levels separate the deleted ancestor from this table
-- (verified empirically against a 4-level cascade chain in a throwaway
-- sandbox — Postgres's RI enforcement doesn't nest one trigger level per FK
-- hop). Blocking only depth = 1 preserves the original guard's intent
-- (stop a direct, isolated delete of this specific row) while letting a
-- legitimate whole-record removal go through.
--
-- The UPDATE trigger (prevent_non_deletable_checklist_update) is untouched:
-- none of checklist_instance_items' ancestor FKs are ON UPDATE CASCADE, so
-- it never fires as a cascade side-effect, and its narrower original
-- purpose (block editing task/section_name/non_deletable directly) is
-- unaffected by this bug.

CREATE OR REPLACE FUNCTION prevent_non_deletable_checklist_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.non_deletable = true AND pg_trigger_depth() = 1 THEN
    RAISE EXCEPTION
      'checklist_instance_item % is marked non_deletable and cannot be deleted directly — delete its parent checklist_instance/turnover/property/org instead if the whole record is being removed.',
      OLD.id
    USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;
