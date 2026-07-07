
-- ═══════════════════════════════════════════════════════════════════════════
-- WORK ORDER PUBLIC DISPATCH — SCHEMA ADDITIONS
-- Adds token-gated public access, lockbox/parking fields, and sign-off tracking
-- ═══════════════════════════════════════════════════════════════════════════

-- ─── Add public dispatch columns to work_orders ──────────────────────────
-- public_token:          Cryptographically random 64-char hex — the magic link key
-- public_token_expires_at: Token TTL (default 30 days from dispatch)
-- public_viewed_at:      Timestamp when vendor first opened the link
-- public_signed_off_at:  Timestamp when vendor submitted sign-off
-- sign_off_notes:        Vendor's completion notes (submitted at sign-off)
-- vendor_dispatch_email: Email address the WO was dispatched to (audit denorm)
-- lockbox_code:          Displayed prominently as large monospace on the public page
-- parking_notes:         Separate from access_notes for structured display

ALTER TABLE work_orders
  ADD COLUMN IF NOT EXISTS public_token            TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS public_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS public_viewed_at        TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS public_signed_off_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sign_off_notes          TEXT,
  ADD COLUMN IF NOT EXISTS vendor_dispatch_email   TEXT,
  ADD COLUMN IF NOT EXISTS lockbox_code            TEXT,
  ADD COLUMN IF NOT EXISTS parking_notes           TEXT;

-- Index for fast token lookup (every public page load hits this)
CREATE UNIQUE INDEX IF NOT EXISTS idx_work_orders_public_token
  ON work_orders (public_token)
  WHERE public_token IS NOT NULL;

-- Index for finding dispatched-but-not-signed-off WOs (monitoring/reminders)
CREATE INDEX IF NOT EXISTS idx_work_orders_pending_signoff
  ON work_orders (public_token_expires_at)
  WHERE public_signed_off_at IS NULL
    AND public_token IS NOT NULL;

COMMENT ON COLUMN work_orders.public_token IS
  'Cryptographically random token for the vendor magic link. NULL until dispatched.';
COMMENT ON COLUMN work_orders.sign_off_notes IS
  'Vendor-submitted completion notes at sign-off. Stored on the work order for audit.';

COMMENT ON TABLE work_orders IS
  'Public vendor access: token-gated via Next.js server actions using service role.
   The public_token column is the sole authorization mechanism for unauthenticated vendors.
   Service role is used ONLY in app/actions/work-order-public.ts.';
