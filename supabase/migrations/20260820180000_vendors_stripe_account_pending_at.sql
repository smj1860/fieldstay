-- vendors.stripe_connect_account_pending_at — the "we are about to call
-- Stripe" marker that makes Express account creation reconcilable.
--
-- GitHub #573. lib/stripe/vendor-connect-invite.ts calls
-- stripe.accounts.create() and THEN persists the returned id to
-- vendors.stripe_connect_account_id. If the persist fails, the account exists
-- in Stripe and nothing in our database knows about it — and the retry, seeing
-- a null account id, creates a SECOND Express account for the same vendor.
--
-- A Stripe idempotency key alone does not close this. Stripe retains
-- idempotency keys for 24 HOURS: a retry inside that window replays the
-- original response (good), a retry after it creates a duplicate (the bug,
-- just rarer). Any real "the DB was down for a day" or "a PM clicked resend
-- next week" lands outside the window.
--
-- Reconciliation cannot be done by querying Stripe either. Stripe's Search API
-- does not cover Connect accounts, and accounts.list has no metadata filter, so
-- finding an orphan means listing accounts and filtering on
-- metadata.vendor_id client-side. That is far too expensive to do on every
-- first invite — but perfectly affordable when we KNOW a previous attempt got
-- as far as Stripe. This column is that knowledge.
--
-- Written before the Stripe call and cleared after the id is safely persisted,
-- so:
--   account_id set                     → use it, no Stripe call
--   account_id null, pending_at set    → a previous attempt reached Stripe.
--                                        Reconcile before creating.
--   account_id null, pending_at null   → nothing has ever been attempted.
--
-- Verified before applying: production has 11 vendors, 4 with an account and 4
-- with an invite sent. Account count equals invite count, so there are no
-- pre-existing orphans for this marker to miss.
ALTER TABLE public.vendors
  ADD COLUMN IF NOT EXISTS stripe_connect_account_pending_at timestamptz;

COMMENT ON COLUMN public.vendors.stripe_connect_account_pending_at IS
  'Set immediately before stripe.accounts.create(), cleared once the account id is persisted. Non-null with a null stripe_connect_account_id means a previous attempt may have orphaned an Express account — reconcile rather than create. See GitHub #573.';

-- Partial: the column is null for every vendor in the steady state, so the
-- index only ever holds the handful mid-attempt or genuinely stranded. This is
-- what makes "find the stranded vendors" a cheap operational query rather than
-- a table scan.
CREATE INDEX IF NOT EXISTS idx_vendors_stripe_account_pending
  ON public.vendors (org_id, stripe_connect_account_pending_at)
  WHERE stripe_connect_account_pending_at IS NOT NULL;
