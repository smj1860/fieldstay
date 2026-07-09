-- Closes the TOCTOU race across ensureVendorConnectInvited()'s three
-- callers (nightly cron, work-order dispatch) and resendVendorConnectInvite
-- (the PM "Resend" button) — all three do a read-then-act on the same
-- vendor row with no lock between the read and the stripe.accounts.create()
-- + email send + write, so two firing close together could create two
-- Stripe Express accounts and send two invite emails, with one account
-- silently orphaned.
--
-- This column is a short-lived application-level claim marker, not a
-- permanent status field like stripe_connect_invite_sent_at — set
-- atomically via a conditional UPDATE at the start of the critical
-- section in lib/stripe/vendor-connect-invite.ts, cleared in a finally
-- block once the attempt completes (success or failure). A claim older
-- than 2 minutes is treated as stale (a crashed process) and can be
-- reclaimed rather than blocking that vendor forever.
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS stripe_connect_invite_claimed_at timestamptz;

COMMENT ON COLUMN vendors.stripe_connect_invite_claimed_at IS
  'Short-lived claim marker preventing concurrent Stripe Connect account
   creation/invite sends for the same vendor from racing across the cron,
   work order dispatch, and PM "Resend" trigger paths. Set on claim,
   cleared after the attempt completes. A claim older than 2 minutes is
   treated as stale and reclaimable.';
