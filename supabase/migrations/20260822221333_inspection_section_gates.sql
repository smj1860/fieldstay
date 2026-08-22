-- Inspections — the two SECTION GATES had nowhere to land.
--
-- docs/INSPECTIONS_SPEC.md §12.3 specifies two conditional sections on the
-- Outdoor form, and is emphatic about why the difference between them matters:
--
--   * Well & Water System — shown only where the property has an active
--     `well_pump` asset. "Ledger-backed, so the N/A is not inspector-asserted."
--     A municipal-water property never sees it and cannot be recorded as having
--     skipped it.
--   * HOA Rules & Standing — shown only where `properties.hoa_name` is set.
--
-- Both existed only on the REPO definition type (lib/inspections/forms/
-- types.ts). There was no column, so the seed script silently dropped them and
-- production's outdoor form carried nine sections with no gating information at
-- all. Left alone, the renderer would have asked every municipal-water property
-- nine well questions and every non-HOA property three HOA questions — and the
-- ledger-backed skip that §12.3 argues for would have become exactly the
-- inspector-asserted N/A it was written to avoid.
--
-- This is the same shape as the `default_actions` gap phase 2 found: a field
-- the spec treats as load-bearing, present in the repo, absent from the schema.
-- Both were invisible to the seed test, which asserts the repo definitions and
-- never looks at the projection. That blind spot is closed in the same change
-- by unit/guardrails/inspection-seed-projection.test.ts.

ALTER TABLE public.inspection_form_sections
  ADD COLUMN IF NOT EXISTS shown_when_asset asset_type;

-- A COLUMN NAME rather than a boolean, matching the repo type's
-- `'hoa_name'` literal. Constrained rather than free text: an unrecognised
-- value would fail open — the renderer cannot evaluate a gate it does not know,
-- so it would show the section to everybody, which is the failure this column
-- exists to prevent.
ALTER TABLE public.inspection_form_sections
  ADD COLUMN IF NOT EXISTS shown_when_property_field text;

ALTER TABLE public.inspection_form_sections
  DROP CONSTRAINT IF EXISTS inspection_form_sections_property_field_known;

ALTER TABLE public.inspection_form_sections
  ADD CONSTRAINT inspection_form_sections_property_field_known
  CHECK (shown_when_property_field IS NULL OR shown_when_property_field IN ('hoa_name'));

-- At most ONE gate per section. Two would need an AND/OR the renderer has no
-- way to express, and the resolver would have to guess.
ALTER TABLE public.inspection_form_sections
  DROP CONSTRAINT IF EXISTS inspection_form_sections_single_gate;

ALTER TABLE public.inspection_form_sections
  ADD CONSTRAINT inspection_form_sections_single_gate
  CHECK (shown_when_asset IS NULL OR shown_when_property_field IS NULL);

COMMENT ON COLUMN public.inspection_form_sections.shown_when_asset IS
  'Render this section only where the property has an ACTIVE property_assets '
  'row of this type. Ledger-backed, so the skip is not an inspector assertion.';

COMMENT ON COLUMN public.inspection_form_sections.shown_when_property_field IS
  'Render this section only where the named properties column is non-null. '
  'Currently hoa_name only, CHECK-constrained: an unknown gate would fail open.';
