-- Adds the 'platform' org_plan value for the 2026-08-29 graduated-pricing
-- rebuild. Every self-serve customer now sits on ONE Stripe price per
-- interval (billing_scheme: 'tiered', tiers_mode: 'graduated' — see
-- lib/stripe/brackets.ts), billed by property-count quantity rather than a
-- discrete tier, so there is no longer a Hosts/Starter/Growth/Portfolio
-- distinction to assign. 'platform' is the label the webhook now writes for
-- any subscription on the graduated price; the four old values stay in the
-- enum (existing rows keep their historical label, ADD VALUE never removes
-- anything) but nothing new is ever written with them.
--
-- 'enterprise' is untouched and still means what it always meant: a
-- manually-negotiated contract outside Stripe self-serve.
--
-- Same one-line shape as 20260611141330_add_portfolio_plan.sql and
-- 20260808120000_add_hosts_plan.sql. ADD VALUE is permitted inside a
-- migration's transaction as long as the new label is not USED in that same
-- transaction, which it is not here.

ALTER TYPE org_plan ADD VALUE IF NOT EXISTS 'platform';
