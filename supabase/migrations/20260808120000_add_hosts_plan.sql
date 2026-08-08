-- Adds the 'hosts' entry tier ($89/mo, $890/yr, 1–4 properties), which sits
-- below 'starter'. Starter's cap is unchanged at 15 properties; only its
-- floor moves (it is now described as 5–15 rather than "up to 15"), so no
-- existing org's max_properties changes and no backfill is needed.
--
-- Same one-line shape as 20260611141330_add_portfolio_plan.sql. ADD VALUE is
-- permitted inside a migration's transaction as long as the new label is not
-- USED in that same transaction, which it is not here.
--
-- Note that ADD VALUE appends to the enum's sort order, so org_plan's label
-- order is insertion order (starter, growth, pro, enterprise, portfolio,
-- hosts) and is NOT a price ladder. Nothing in the codebase orders by plan;
-- don't start.

ALTER TYPE org_plan ADD VALUE IF NOT EXISTS 'hosts';
