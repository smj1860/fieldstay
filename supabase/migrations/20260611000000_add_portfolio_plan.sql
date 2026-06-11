-- Add 'portfolio' tier to org_plan enum (51-100 properties), sitting between
-- 'growth' and 'enterprise' in the new pricing structure.
ALTER TYPE org_plan ADD VALUE IF NOT EXISTS 'portfolio';
