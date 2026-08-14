-- Asset Health Index / RUL feature: two new tables.
--
-- asset_health_score_history — one row per asset per day the nightly
-- scoring cron runs. The score itself (property_assets.health_score) is a
-- rolling cache, overwritten in place — there was never a trend an RUL
-- curve could be validated or refit against. This starts that log today so
-- the degradation curve in lib/assets/health-score.ts can eventually be
-- checked (or refit) against what actually happened, and so
-- capital-planning can plot a real trend line instead of a single point.
--
-- asset_capex_recommendations — the repair-vs-replace decision the app has
-- never made: it already computed repair-cost history (thrown away after
-- scoring), a book value (asset_depreciation_entries.ending_adjusted_basis,
-- read only by the CPA export), and a replacement cost estimate
-- (capex-projection-core.ts) in three separate places. One row per asset,
-- upserted nightly by the same cron, is where those get joined.
CREATE TABLE IF NOT EXISTS asset_health_score_history (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id           uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  asset_id         uuid NOT NULL REFERENCES property_assets(id) ON DELETE CASCADE,
  recorded_date    date NOT NULL,
  health_score     smallint NOT NULL CHECK (health_score BETWEEN 0 AND 100),
  age_score        smallint NOT NULL CHECK (age_score BETWEEN 0 AND 100),
  condition_score  smallint NOT NULL CHECK (condition_score BETWEEN 0 AND 100),
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id, recorded_date)
);

CREATE INDEX IF NOT EXISTS idx_asset_health_score_history_org
  ON asset_health_score_history (org_id);

CREATE INDEX IF NOT EXISTS idx_asset_health_score_history_asset_date
  ON asset_health_score_history (asset_id, recorded_date DESC);

ALTER TABLE asset_health_score_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "asset_health_score_history_select"
  ON asset_health_score_history FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

-- No INSERT/UPDATE/DELETE policy for org members — written only by the
-- nightly asset-health cron via createServiceClient(), same as notifications.

GRANT SELECT ON TABLE asset_health_score_history TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE asset_health_score_history TO service_role;

-- ── Repair-vs-Replace ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS asset_capex_recommendations (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                     uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  asset_id                   uuid NOT NULL REFERENCES property_assets(id) ON DELETE CASCADE,
  -- Denormalized from property_assets, same reasoning as
  -- CapExProjectionItem.property_id in capex-projection-core.ts: lets the
  -- capital-planning page (and, eventually, an owner-portal view) filter and
  -- group by property without a join on every read.
  property_id                uuid NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  recommendation             text NOT NULL CHECK (recommendation IN ('monitor', 'repair', 'replace')),
  repair_cost_trailing_12mo  numeric NOT NULL DEFAULT 0,
  repair_cost_prior_12mo     numeric NOT NULL DEFAULT 0,
  -- NULL when repair_cost_prior_12mo is 0 — a percentage change off a zero
  -- base isn't a meaningful number, not "infinity". See repair-vs-replace.ts.
  repair_trend_pct           numeric,
  replacement_cost_estimate  numeric NOT NULL,
  -- Informational only — asset_depreciation_entries.ending_adjusted_basis for
  -- the asset's most recent tax year. Deliberately NOT netted into the
  -- recommendation itself: remaining depreciable basis is a tax-timing
  -- question, not an operating cost, and folding it into the same number as
  -- repair spend would misrepresent what's driving the recommendation.
  remaining_book_value       numeric,
  reasoning                  text[] NOT NULL DEFAULT '{}',
  -- Set the first time this asset reaches 'replace' and a notification is
  -- sent. Mirrors vendor_compliance_documents.first_warned_at — a "replace
  -- this HVAC" alert should fire once, not every night the condition holds;
  -- the weekly PM digest's worst-health-score section already provides the
  -- recurring reminder.
  notified_at                timestamptz,
  computed_at                timestamptz NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (asset_id)
);

CREATE INDEX IF NOT EXISTS idx_asset_capex_recommendations_org
  ON asset_capex_recommendations (org_id);

CREATE INDEX IF NOT EXISTS idx_asset_capex_recommendations_property
  ON asset_capex_recommendations (property_id);

CREATE TRIGGER asset_capex_recommendations_updated_at
  BEFORE UPDATE ON asset_capex_recommendations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE asset_capex_recommendations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "asset_capex_recommendations_select"
  ON asset_capex_recommendations FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

-- No INSERT/UPDATE/DELETE policy for org members — written only by the
-- nightly asset-health cron via createServiceClient().

GRANT SELECT ON TABLE asset_capex_recommendations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE asset_capex_recommendations TO service_role;
