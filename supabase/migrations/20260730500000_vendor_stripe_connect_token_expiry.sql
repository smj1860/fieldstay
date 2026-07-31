-- Pre-launch audit 2026-07-30, M-5: vendors.stripe_connect_token was the only
-- unbounded token surface in the codebase.
--
-- 20260626145302_vendor_stripe_connect.sql created it as
--   stripe_connect_token uuid NOT NULL DEFAULT gen_random_uuid()
-- described as a "stable UUID used in onboarding email links", with no
-- expiry, no revocation column, and no rotation on completion.
-- app/api/vendor-connect/[token]/onboard/route.ts looked it up with only
-- .eq('is_active', true). A forwarded onboarding email was therefore a
-- PERMANENT capability to open a Stripe Connect onboarding session for that
-- vendor. Every other token surface in the app is bounded:
--   owner_portal_tokens          — 90 days + revoked_at
--   work_orders.completion_token — 30 days (completion_token_expires_at)
--   quote_requests.quote_token   — quote_token_expires_at
--   org_invites                  — expires_at
--
-- This migration gives it the same treatment.

-- ── 1. The column ───────────────────────────────────────────────────────────

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS stripe_connect_token_expires_at timestamptz;

COMMENT ON COLUMN vendors.stripe_connect_token_expires_at IS
  'Expiry for stripe_connect_token. Set/refreshed automatically whenever '
  'stripe_connect_invite_sent_at changes (see trg_vendors_stripe_connect_token_expiry). '
  'NULL means the current token has never been emailed and is not usable; '
  'app/api/vendor-connect/[token]/onboard/route.ts treats NULL and past as expired.';

-- ── 2. Backfill ─────────────────────────────────────────────────────────────
-- Anchored on when the invite was actually sent (falling back to row creation
-- for rows that predate that column being populated). Deliberately NOT
-- anchored on now(): an invite emailed eight months ago is exactly the stale
-- permanent capability this migration exists to close, so it backfills to an
-- already-past timestamp and the PM re-sends. A vendor who has already
-- completed onboarding needs no live link at all.

UPDATE vendors
   SET stripe_connect_token_expires_at =
         COALESCE(stripe_connect_invite_sent_at, created_at) + interval '30 days'
 WHERE stripe_connect_token_expires_at IS NULL;

-- ── 3. Auto-refresh on (re-)send ────────────────────────────────────────────
-- Enforced in the DB rather than at each call site so a future send path
-- cannot forget it — there are already three (nightly cron, work-order
-- dispatch, PM "Resend" button) and they all funnel through the same
-- stripe_connect_invite_sent_at write.

CREATE OR REPLACE FUNCTION public.set_vendor_stripe_connect_token_expiry()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- A brand-new token (insert, or an explicit rotation) starts UNUSABLE:
  -- it only becomes live once an invite carrying it is actually sent.
  IF TG_OP = 'INSERT' THEN
    NEW.stripe_connect_token_expires_at := NULL;
    RETURN NEW;
  END IF;

  IF NEW.stripe_connect_token IS DISTINCT FROM OLD.stripe_connect_token THEN
    NEW.stripe_connect_token_expires_at := NULL;
  END IF;

  IF NEW.stripe_connect_invite_sent_at IS DISTINCT FROM OLD.stripe_connect_invite_sent_at
     AND NEW.stripe_connect_invite_sent_at IS NOT NULL THEN
    NEW.stripe_connect_token_expires_at := NEW.stripe_connect_invite_sent_at + interval '30 days';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vendors_stripe_connect_token_expiry ON vendors;

CREATE TRIGGER trg_vendors_stripe_connect_token_expiry
  BEFORE INSERT OR UPDATE ON vendors
  FOR EACH ROW
  EXECUTE FUNCTION public.set_vendor_stripe_connect_token_expiry();
