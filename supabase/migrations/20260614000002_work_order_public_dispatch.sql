-- ─────────────────────────────────────────────────────────────────────────
-- NOT RECORDED IN LIVE MIGRATION HISTORY: verified via Supabase MCP
-- list_migrations against project vpmznjktllhmmbfnxuvk on 2026-07-08 that
-- this file's version is absent from supabase_migrations.schema_migrations.
-- Spot-checking the schema objects it defines (tables, columns, indexes,
-- functions, policies, enum values, dropped objects) against the live
-- database confirms they already exist — this SQL was applied previously,
-- most likely by hand or under a different, already-tracked migration
-- timestamp, and this file is a historical/duplicate copy rather than a
-- pending change. Do not assume `supabase db push` needs to run it, and
-- verify against the live schema before treating it as authoritative —
-- some statements here (UPDATEs, INSERTs, ALTER TYPE ... ADD VALUE) are
-- not safely re-runnable if actually executed again.
-- ─────────────────────────────────────────────────────────────────────────
-- ═══════════════════════════════════════════════════════════════════════════
-- WORK ORDER PUBLIC DISPATCH — SCHEMA ADDITIONS
-- Adds token-gated public access, lockbox/parking fields, and sign-off tracking
-- Applied to vpmznjktllhmmbfnxuvk on 2026-06-14.
-- All statements use IF NOT EXISTS so re-applying is safe.
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
