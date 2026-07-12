-- Progressive Asset Discovery: three new asset types requested for the
-- required-discovery list (generator was already a valid asset_type).
-- Enum additions are split into their own migration/transaction — Postgres
-- won't let a brand-new enum value be used (e.g. in an INSERT) within the
-- same transaction that added it.

ALTER TYPE asset_type ADD VALUE IF NOT EXISTS 'ice_maker';
ALTER TYPE asset_type ADD VALUE IF NOT EXISTS 'garbage_disposal';
ALTER TYPE asset_type ADD VALUE IF NOT EXISTS 'trash_compactor';
