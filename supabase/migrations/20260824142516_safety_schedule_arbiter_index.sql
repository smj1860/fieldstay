-- Make the safety-schedule uniqueness usable as an ON CONFLICT arbiter.
--
-- 20260824091200 created it PARTIAL:
--
--   CREATE UNIQUE INDEX uq_maintenance_schedules_property_inspection_form
--     ON maintenance_schedules (property_id, inspection_form_id)
--     WHERE creates = 'inspection';
--
-- and applySafetyTemplate upserts against it with
-- `onConflict: 'property_id,inspection_form_id'`. That does not work, and it
-- does not work in the worst way: Postgres resolves the conflict arbiter at
-- PLAN time, so the statement raises
--
--   42P10  there is no unique or exclusion constraint matching the
--          ON CONFLICT specification
--
-- on EVERY execution — including the very first insert into an empty table,
-- where nothing could possibly conflict. The onboarding step's fan-out would
-- have failed on the first property of the first org to use it. A partial
-- unique index can only be named as an arbiter by repeating its predicate
-- (`ON CONFLICT (cols) WHERE creates = 'inspection'`), which supabase-js's
-- string `onConflict` cannot express at all.
--
-- Verified rather than assumed, in a rolled-back transaction against the E2E
-- project: the shipped statement returned `42P10 ...`; the same statement
-- against a PLAIN index inserted one row and then collided harmlessly on the
-- repeat, leaving one row.
--
-- This is the THIRD upsert in this codebase to name an index that cannot
-- arbitrate — after vendors (42P10 on an expression index) and
-- checklist_templates (no such unique index at all). All three passed their
-- unit tests, because a Supabase test double resolves no arbiters. The
-- `db-invariants` gate is what caught this one, on the live schema, which is
-- the only place the answer exists.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- WHY PLAIN IS SAFE HERE, AND WHY THE CHECK IS TIGHTENED IN THE SAME BREATH
--
-- The partial index means "at most one inspection schedule per (property,
-- form)". A plain index means "at most one schedule with a form per (property,
-- form)". Those coincide exactly when `creates = 'inspection'` and
-- `inspection_form_id IS NOT NULL` imply each other — and 20260823211930 only
-- enforced ONE direction (`creates <> 'inspection' OR form IS NOT NULL`).
--
-- So the CHECK becomes a biconditional. Without it the plain index's meaning
-- would rest on a convention nothing enforces, and the next writer to set a
-- form on a work-order schedule would get a collision the schema never
-- promised. Both sides of the equality are non-nullable expressions (`creates`
-- is NOT NULL; `IS NOT NULL` never yields NULL), so unlike the three-valued
-- trap in 20260824091200 this cannot pass by evaluating to UNKNOWN.
--
-- Confirmed zero violating rows before writing it: production 0 of 145,
-- E2E 0 of 0.
--
-- Rows with a NULL form — every work-order schedule, which is all 145 of them
-- in production — stay unconstrained: Postgres treats NULLs as distinct in a
-- unique index, so the plain index simply does not apply to them.

DROP INDEX IF EXISTS uq_maintenance_schedules_property_inspection_form;

CREATE UNIQUE INDEX IF NOT EXISTS uq_maintenance_schedules_property_inspection_form
  ON maintenance_schedules (property_id, inspection_form_id);

ALTER TABLE maintenance_schedules
  DROP CONSTRAINT IF EXISTS maintenance_schedules_inspection_needs_form;
ALTER TABLE maintenance_schedules
  ADD CONSTRAINT maintenance_schedules_inspection_needs_form
  CHECK ((creates = 'inspection') = (inspection_form_id IS NOT NULL));

COMMENT ON INDEX uq_maintenance_schedules_property_inspection_form IS
  'One inspection schedule per (property, form). PLAIN rather than partial so applySafetyTemplate can name it as an ON CONFLICT arbiter — a partial unique index raises 42P10 at plan time for a bare column-list arbiter. The biconditional CHECK on (creates, inspection_form_id) is what makes plain equivalent to the partial form.';
