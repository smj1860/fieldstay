
-- ─────────────────────────────────────────────────────────────
-- Archive completed turnovers
-- ─────────────────────────────────────────────────────────────
ALTER TABLE turnovers
  ADD COLUMN IF NOT EXISTS is_archived BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS idx_turnovers_active
  ON turnovers(org_id, is_archived, status)
  WHERE is_archived = false;

-- ─────────────────────────────────────────────────────────────
-- Crew feedback
-- Submitted via API route → service client.
-- Org members can read feedback from their crews.
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS crew_feedback (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  crew_member_id  UUID        NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
  property_id     UUID        REFERENCES properties(id) ON DELETE SET NULL,
  feedback_text   TEXT        NOT NULL,
  submitted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE crew_feedback ENABLE ROW LEVEL SECURITY;

CREATE POLICY "cf_org_members_select" ON crew_feedback
  FOR SELECT USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "cf_restrict_insert" ON crew_feedback
  FOR INSERT WITH CHECK (false);  -- service client only via /api/crew/feedback

CREATE INDEX IF NOT EXISTS idx_crew_feedback_org_id
  ON crew_feedback(org_id);

CREATE INDEX IF NOT EXISTS idx_crew_feedback_crew_member_id
  ON crew_feedback(crew_member_id);

-- ─────────────────────────────────────────────────────────────
-- Stay extension / gap night messaging settings
-- Added to guidebook_configurations (one-per-org, already exists)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE guidebook_configurations
  ADD COLUMN IF NOT EXISTS extension_messaging_enabled   BOOLEAN  NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS extension_gap_threshold_days  INTEGER  NOT NULL DEFAULT 7,
  ADD COLUMN IF NOT EXISTS extension_discount_pct        INTEGER  CHECK (extension_discount_pct BETWEEN 0 AND 100),
  ADD COLUMN IF NOT EXISTS extension_contact_method      TEXT     CHECK (extension_contact_method IN ('ownerrez_url','email','sms')) DEFAULT 'email',
  ADD COLUMN IF NOT EXISTS extension_ownerrez_url        TEXT,
  ADD COLUMN IF NOT EXISTS extension_message_days_before INTEGER  NOT NULL DEFAULT 2;

-- ─────────────────────────────────────────────────────────────
-- Stay extension requests
-- One row per booking — tracks when offer was shown and guest status
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stay_extension_requests (
  id                      UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                  UUID        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  booking_id              UUID        NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  property_id             UUID        NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  gap_days                INTEGER     NOT NULL,
  discount_pct            INTEGER     CHECK (discount_pct BETWEEN 0 AND 100),
  next_booking_checkin    DATE,
  status                  TEXT        NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','accepted','declined')),
  sms_sent_at             TIMESTAMPTZ,
  pm_notified_at          TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(booking_id)
);

ALTER TABLE stay_extension_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "ser_org_members_select" ON stay_extension_requests
  FOR SELECT USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "ser_restrict_insert" ON stay_extension_requests
  FOR INSERT WITH CHECK (false);  -- service client only via Inngest cron

CREATE INDEX IF NOT EXISTS idx_stay_extension_requests_org
  ON stay_extension_requests(org_id);

CREATE INDEX IF NOT EXISTS idx_stay_extension_requests_booking
  ON stay_extension_requests(booking_id);

-- ─────────────────────────────────────────────────────────────
-- Crew members can read work orders assigned to them
-- ─────────────────────────────────────────────────────────────
DROP POLICY IF EXISTS "wo_crew_member_read" ON work_orders;

CREATE POLICY "wo_crew_member_read" ON work_orders
  FOR SELECT USING (
    assigned_crew_member_id IN (
      SELECT id FROM crew_members WHERE user_id = auth.uid()
    )
  );
