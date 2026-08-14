-- Default annual inflation assumption for the Capital Planning "What-If"
-- scenario panel (lib/assets/scenario-modeling.ts) — lets a PM project
-- future replacement costs (and the effect of deferring them) in real
-- dollars instead of assuming a $1,200 water heater costs $1,200 in five
-- years too. 4.0% sits in the range commonly cited for durable-goods/
-- equipment inflation; bounded to keep a fat-fingered entry from producing
-- a nonsense 10-year projection.
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS capex_inflation_rate_pct numeric NOT NULL DEFAULT 4.0
    CHECK (capex_inflation_rate_pct BETWEEN 0 AND 25);
