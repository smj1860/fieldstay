-- Drop `properties.hoa_name` and the section gate that existed only to read it.
--
-- Both were added for §12.3's HOA section, on the reasoning that a ledger-backed
-- skip beats an inspector-asserted one. That reasoning is right in general and
-- was wrong here: @smj1860 confirmed FieldStay does not hold HOA membership for
-- any property, will not be collecting it, and does not need the name. There is
-- no ledger to back the skip with.
--
-- A gate on a column nothing ever populates is not a conservative default — it
-- is a silent deletion. It would have rendered three real questions permanently
-- unreachable while reading, in review, as a considered condition. The HOA
-- section now asks the fact of the person standing at the property, as one root
-- question with the three items as conditional children.
--
-- VERIFIED BEFORE DROPPING: 29 properties in production, ZERO with a non-null
-- hoa_name. Nothing is being discarded.
--
-- `shown_when_property_field` goes with it. It was added the same day and its
-- CHECK admitted exactly one value — 'hoa_name' — so with that column gone it
-- could only ever name a thing that does not exist. `shown_when_asset` stays and
-- is still doing real work: it is what keeps the nine well questions off a
-- municipal-water property, with the skip backed by the asset register rather
-- than by whoever benefits from skipping them.

ALTER TABLE public.inspection_form_sections
  DROP CONSTRAINT IF EXISTS inspection_form_sections_property_field_known;

ALTER TABLE public.inspection_form_sections
  DROP CONSTRAINT IF EXISTS inspection_form_sections_single_gate;

ALTER TABLE public.inspection_form_sections
  DROP COLUMN IF EXISTS shown_when_property_field;

ALTER TABLE public.properties
  DROP COLUMN IF EXISTS hoa_name;
