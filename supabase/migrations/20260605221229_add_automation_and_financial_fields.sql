
-- ================================================================
-- AUTOMATION & FINANCIAL SCHEMA
-- Covers:
--   1. Properties: square_footage + cleaning cost fields
--   2. Organizations: auto-assignment mode toggle (suggest vs autopilot)
--   3. Turnovers: suggestion state for smart assignment workflow
--   4. Owner transactions: source tracking for automation
--   5. Crew availability (Phase 9 prerequisite)
-- ================================================================

-- ── 1. Properties: operational + financial fields ───────────────
ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS square_footage        INTEGER,
  ADD COLUMN IF NOT EXISTS cleaning_cost         NUMERIC(10,2),
  ADD COLUMN IF NOT EXISTS same_day_premium_pct  NUMERIC(5,2)  DEFAULT 25.00,
  ADD COLUMN IF NOT EXISTS cleaning_cost_visible_to_owner BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN properties.cleaning_cost IS
  'Base cost paid to crew per standard turnover for this property.
   Auto-populates an owner_transaction expense on turnover completion.';
COMMENT ON COLUMN properties.same_day_premium_pct IS
  'Percentage markup applied to cleaning_cost when same_day_turnover = true.
   Default 25%. Applied automatically by Inngest on turnover complete.';
COMMENT ON COLUMN properties.cleaning_cost_visible_to_owner IS
  'If false, the auto-created cleaning fee expense is hidden from the owner portal.';

-- ── 2. Organizations: automation settings ───────────────────────
ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS auto_assign_mode       TEXT    NOT NULL DEFAULT 'suggest'
    CHECK (auto_assign_mode IN ('suggest', 'autopilot', 'disabled')),
  ADD COLUMN IF NOT EXISTS auto_assign_enabled    BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN organizations.auto_assign_mode IS
  'suggest = Inngest recommends crew, PM confirms with one tap.
   autopilot = Inngest assigns automatically and notifies PM of result.
   disabled = no automation, fully manual.';

-- ── 3. Turnovers: smart assignment suggestion state ─────────────
ALTER TABLE turnovers
  ADD COLUMN IF NOT EXISTS suggested_crew_ids     UUID[]        DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS suggestion_reasoning   TEXT          DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS suggestion_status      TEXT          DEFAULT NULL
    CHECK (suggestion_status IN ('pending','accepted','overridden','dismissed') OR suggestion_status IS NULL),
  ADD COLUMN IF NOT EXISTS is_same_day_turnover   BOOLEAN       NOT NULL DEFAULT false;

COMMENT ON COLUMN turnovers.suggested_crew_ids IS
  'Crew UUIDs recommended by the auto-assignment Inngest function.
   Populated when auto_assign_mode = suggest or autopilot.';
COMMENT ON COLUMN turnovers.suggestion_status IS
  'pending = suggestion made, awaiting PM action.
   accepted = PM confirmed the suggestion.
   overridden = PM chose different crew.
   dismissed = PM dismissed the suggestion.';
COMMENT ON COLUMN turnovers.is_same_day_turnover IS
  'True when checkout and next checkin are on the same calendar date.
   Triggers +1 crew recommendation and same_day_premium_pct cost markup.';

-- ── 4. Owner transactions: source tracking for automations ──────
ALTER TABLE owner_transactions
  ADD COLUMN IF NOT EXISTS source              TEXT    DEFAULT 'manual'
    CHECK (source IN ('manual','wo_completion','booking_revenue','inventory_purchase','cleaning_fee')),
  ADD COLUMN IF NOT EXISTS source_reference_id UUID    DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS visible_to_owner    BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN owner_transactions.source IS
  'How this transaction was created:
   manual            = PM entered directly
   wo_completion     = auto-created when WO marked complete (actual_cost)
   booking_revenue   = auto-created from confirmed OwnerRez booking
   inventory_purchase = auto-created from approved purchase order
   cleaning_fee      = auto-created when turnover marked complete';
COMMENT ON COLUMN owner_transactions.source_reference_id IS
  'UUID of the source record (work_order.id, booking.id, purchase_order.id, turnover.id).
   Enables deduplication: never create two transactions for the same source_reference_id + source.';

-- ── 5. Crew availability table (Phase 9 prerequisite) ───────────
CREATE TABLE IF NOT EXISTS crew_availability (
  id             UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id         UUID    NOT NULL,
  crew_member_id UUID    NOT NULL REFERENCES crew_members(id) ON DELETE CASCADE,
  available_date DATE    NOT NULL,
  is_available   BOOLEAN NOT NULL DEFAULT true,
  notes          TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (crew_member_id, available_date)
);

CREATE INDEX IF NOT EXISTS idx_crew_availability_lookup
  ON crew_availability(crew_member_id, available_date);

ALTER TABLE crew_availability ENABLE ROW LEVEL SECURITY;

CREATE POLICY "crew_availability_select"
  ON crew_availability FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "crew_availability_manage"
  ON crew_availability FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- Allow crew members to manage their own availability
CREATE POLICY "crew_availability_self_manage"
  ON crew_availability FOR ALL
  USING (
    crew_member_id IN (
      SELECT id FROM crew_members WHERE user_id = auth.uid()
    )
  )
  WITH CHECK (
    crew_member_id IN (
      SELECT id FROM crew_members WHERE user_id = auth.uid()
    )
  );
