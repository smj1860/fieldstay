-- A named asset question repeats once per unit of its asset_type.
--
-- "Refrigeration — clean, holding < 40°F" rendered ONCE on a property with two
-- refrigerators. One of them was inspected, the other was not, and nothing on
-- screen said which. Same for two HVAC units, two water heaters, two decks.
--
-- Only the GENERIC SWEEP (`repeat_per_asset`) was ever per-unit, and it
-- deliberately skips every asset type a named question already covers — so the
-- moment a type got a named question, its units stopped being enumerated at all.
--
-- WHY A SECOND COLUMN RATHER THAN REUSING repeat_per_asset
--
-- They are different rules, not degrees of one, and overloading the flag made
-- two existing guardrails unstateable — which is how this was caught:
--
--   repeat_per_asset  every ACTIVE asset of ANY type no named item claims.
--                     No asset_type (the subject is whatever the ledger holds)
--                     and no concern_key (a static key would merge a dead
--                     refrigerator with a dead generator). Zero assets to
--                     sweep => NO rows.
--   per_unit          every ACTIVE asset of ONE named type. concern_key is
--                     safe because the subject is bounded. Zero matching
--                     assets => ONE unattributed row, so a property that has
--                     not catalogued its appliances still gets asked. Gating
--                     on the ledger would silently delete most of the Indoor
--                     form from the 8-of-29 properties with no assets on file.

ALTER TABLE inspection_form_items
  ADD COLUMN IF NOT EXISTS per_unit boolean NOT NULL DEFAULT false;

-- per_unit is meaningless without a type to match on: the resolver would have
-- nothing to filter the asset ledger by and would silently render one row.
ALTER TABLE inspection_form_items
  DROP CONSTRAINT IF EXISTS inspection_form_items_per_unit_needs_type;
ALTER TABLE inspection_form_items
  ADD CONSTRAINT inspection_form_items_per_unit_needs_type
    CHECK (NOT per_unit OR asset_type IS NOT NULL);

ALTER TABLE inspection_form_items
  DROP CONSTRAINT IF EXISTS inspection_form_items_one_repeat_mode;
ALTER TABLE inspection_form_items
  ADD CONSTRAINT inspection_form_items_one_repeat_mode
    CHECK (NOT (per_unit AND repeat_per_asset));

COMMENT ON COLUMN inspection_form_items.per_unit IS
  'Render one row per ACTIVE property_assets row matching this item''s asset_type. Distinct from repeat_per_asset, which sweeps every asset no named item covers.';

-- ── The answer key the DB enforces must match the one the app uses ──────────
--
-- answerKey() in lib/inspections/resolve-form.ts is
-- (form_item_id, repeat_index, asset_id). The constraint omitted asset_id and
-- relied on NULLs colliding — and in Postgres NULLs are DISTINCT by default.
--
-- Measured on 17.6 rather than assumed: a plain item's answer inserted twice
-- was ACCEPTED, while a repeat_index=1 duplicate was correctly rejected. The
-- constraint protected repeat-group members and nothing else, which is a small
-- minority of rows.
--
-- Adding asset_id is also what makes per_unit answers work at all: two
-- refrigerators produce two rows against one form item, distinguished only by
-- asset_id. Verified against all four cases before applying — two HVAC units
-- ALLOWED, the same unit twice REJECTED, a plain item twice REJECTED, three
-- extinguishers ALLOWED.
ALTER TABLE inspection_items
  DROP CONSTRAINT IF EXISTS inspection_items_unique_answer;
ALTER TABLE inspection_items
  ADD CONSTRAINT inspection_items_unique_answer
    UNIQUE NULLS NOT DISTINCT (inspection_id, form_item_id, repeat_index, asset_id);
