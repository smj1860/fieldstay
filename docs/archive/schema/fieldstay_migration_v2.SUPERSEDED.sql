-- ============================================================
-- ⚠️  SUPERSEDED — DO NOT RUN
-- ============================================================
-- This file represents an early incremental patch on top of v1.
-- The live Supabase project (vpmznjktllhmmbfnxuvk) has since
-- advanced through 64 tracked migrations; all changes below are
-- already present in the live schema (and have evolved further).
--
-- For the current live schema, see:
--   supabase/schema_reference.sql
--
-- Do not apply this file to any database. It is kept for
-- historical reference only.
-- ============================================================

-- FieldStay Migration v2
-- Safe to re-run — all statements are idempotent

-- avg_nightly_rate on properties
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS avg_nightly_rate numeric(10,2) DEFAULT NULL;

-- booking_id on owner_transactions
ALTER TABLE owner_transactions
  ADD COLUMN IF NOT EXISTS booking_id uuid REFERENCES bookings(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_owner_txn_booking_id
  ON owner_transactions(booking_id);

-- Crew invite fields
ALTER TABLE crew_members
  ADD COLUMN IF NOT EXISTS invite_token       uuid UNIQUE DEFAULT gen_random_uuid(),
  ADD COLUMN IF NOT EXISTS invite_sent_at     timestamptz,
  ADD COLUMN IF NOT EXISTS invite_accepted_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_crew_members_invite_token
  ON crew_members(invite_token);

-- Milestones table (review prompt framework — phase 2 feature)
CREATE TABLE IF NOT EXISTS org_milestones (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  milestone      text NOT NULL,
  achieved_at    timestamptz NOT NULL DEFAULT NOW(),
  prompted_at    timestamptz,
  review_clicked boolean NOT NULL DEFAULT false,
  dismissed      boolean NOT NULL DEFAULT false,
  UNIQUE(org_id, milestone)
);

CREATE INDEX IF NOT EXISTS idx_org_milestones_org_id
  ON org_milestones(org_id);
