-- Three additive columns supporting two follow-ups to the asset-health /
-- repair-vs-replace work (20260814065050):
--
-- 1. property_assets.replaced_at — the ground truth the RUL curve has never
--    had. replaced_by_asset_id already existed but nothing in the app ever
--    set it, and without a captured date there is no way to compute
--    "how old was this asset when it actually died" even once a replace
--    workflow exists. Nullable; set once, by replace_property_asset() only.
--
-- 2. asset_type_standards.weibull_shape / weibull_shape_updated_at — the
--    learned Weibull shape parameter (see WEIBULL_SHAPE in
--    lib/assets/health-score.ts), fit per asset type from real
--    age-at-replacement data once enough of it exists. NULL until a fit
--    job has enough samples for that type — calculateHealthScoreBreakdown
--    falls back to the shared constant until then. Mirrors the
--    age_weight/condition_weight pattern from
--    20260622085356_asset_type_standards_learned_weights.sql, including its
--    bounded CHECK range for the same reason: a bad fit off a tiny or noisy
--    sample must not be able to push the curve somewhere pathological.
--
-- 3. property_assets.warranty_warned_at — "warn once" gate for the warranty
--    expiry cron, mirroring vendor_compliance_documents.first_warned_at
--    exactly (see 20260606043358_create_asset_health_schema.sql).
ALTER TABLE property_assets
  ADD COLUMN IF NOT EXISTS replaced_at        timestamptz,
  ADD COLUMN IF NOT EXISTS warranty_warned_at  timestamptz;

CREATE INDEX IF NOT EXISTS idx_property_assets_replaced_at
  ON property_assets (asset_type, replaced_at)
  WHERE replaced_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_property_assets_warranty_expiry_unwarned
  ON property_assets (warranty_expiry_date)
  WHERE warranty_expiry_date IS NOT NULL
    AND warranty_warned_at IS NULL
    AND is_active = true;

ALTER TABLE asset_type_standards
  ADD COLUMN IF NOT EXISTS weibull_shape            numeric CHECK (weibull_shape BETWEEN 1.0 AND 8.0),
  ADD COLUMN IF NOT EXISTS weibull_shape_updated_at  timestamptz;
