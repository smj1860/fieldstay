-- CLAUDE_57_0: Capital planning owner sharing + asset replacement status
--
-- property_owners.share_capital_plan
--   PM-controlled flag. When true, the owner's portal shows their
--   property's projected CapEx alongside the financial summary.
--   Defaults false — opt-in, never opt-out-by-surprise.
--
-- property_assets.replacement_status
--   Tracks PM disposition on projected replacements.
--   'projected'  — default, system-generated estimate
--   'budgeted'   — PM has allocated funds
--   'approved'   — owner has approved the spend
--   'deferred'   — PM has decided to push this out
--   Check constraint prevents arbitrary values.

ALTER TABLE property_owners
  ADD COLUMN IF NOT EXISTS share_capital_plan boolean NOT NULL DEFAULT false;

ALTER TABLE property_assets
  ADD COLUMN IF NOT EXISTS replacement_status text NOT NULL DEFAULT 'projected'
    CONSTRAINT property_assets_replacement_status_check
      CHECK (replacement_status IN ('projected', 'budgeted', 'approved', 'deferred'));

-- Index: capital planning page filters by status and by property when
-- rendering the per-property breakdown. Partial index omits the
-- default 'projected' value — they are the majority and don't benefit
-- from indexing in filtered views.
CREATE INDEX IF NOT EXISTS idx_property_assets_replacement_status
  ON property_assets (org_id, replacement_status)
  WHERE replacement_status != 'projected';
