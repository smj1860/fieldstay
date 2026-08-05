-- Drops the two columns left over from the standalone RepuGuard subscription.
--
-- RepuGuard ships with every plan; 20260804210100 removed the last code path
-- that gated on organizations.repuguard_status and activated every org. These
-- two columns are what remained.
--
--   repuguard_status
--     Read only by lib/auth.ts, which selected it into OrgMembership. Nothing
--     branched on it after the gates came out.
--
--   repuguard_stripe_subscription_id
--     Read only by app/api/account/delete/route.ts, which cancelled the legacy
--     Stripe subscription on account deletion. That branch was worth keeping
--     while legacy subscriptions might still exist — cancelling one late is a
--     billing leak — so it was verified before dropping rather than assumed:
--     0 of 8 production orgs and 0 of 1 E2E orgs hold a value. The column has
--     never been populated by any surviving code path (nothing creates a
--     `feature: 'repuguard'` Stripe subscription any more), so the branch was
--     unreachable, not merely idle.
--
-- Dropping the column drops its CHECK constraint with it.
--
-- Deliberately IRREVERSIBLE and deliberately not deferred: a column that no
-- code reads is a column the next reader has to reason about, and the
-- "vestigial" comments added in 20260804210100 are themselves a maintenance
-- cost. If a standalone RepuGuard product ever returns it gets a fresh,
-- purpose-built column rather than one carrying dead 2026 state.

ALTER TABLE public.organizations
  DROP COLUMN IF EXISTS repuguard_status,
  DROP COLUMN IF EXISTS repuguard_stripe_subscription_id;
