-- One default checklist template per property, enforced.
--
-- applyMasterChecklistToProperty() decides whether to create a template by
-- reading `checklist_templates WHERE property_id = ? AND is_default` and
-- bailing out if it finds one. That read discarded its error (fixed in the
-- same change as this migration), so a transient failure made the lookup
-- return null, the guard evaluated false, and a SECOND default template was
-- created for a property that already had one.
--
-- It compounds rather than settling. With two rows the guard's .maybeSingle()
-- errors on every later run — and that error was discarded the same way — so
-- each run added another default template. The property ends up with a
-- non-deterministic checklist, and a PM's customised template can be shadowed
-- by a freshly seeded default.
--
-- The code fix stops this path. This index makes the class impossible from any
-- path, including a migration backfill or a dashboard edit that never goes
-- through that helper. It is the "guard the invariant in the database, not
-- only in application code" rule from CLAUDE.md's Standing Audit Checklist:
-- an application-level `if` does not catch rows written by another route.
--
-- Partial, because non-default templates are legitimately many-per-property
-- (a property can have several named checklists; only one is the default).
--
-- Verified before applying: zero properties currently hold more than one
-- default template, so this creates cleanly.

CREATE UNIQUE INDEX IF NOT EXISTS uniq_checklist_templates_one_default_per_property
  ON checklist_templates (property_id)
  WHERE is_default;

COMMENT ON INDEX uniq_checklist_templates_one_default_per_property IS
  'One is_default template per property. applyMasterChecklistToProperty relies on this; without it a failed guard read silently created duplicates that compounded on every subsequent run.';
