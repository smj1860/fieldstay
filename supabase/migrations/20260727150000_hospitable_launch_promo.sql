-- Hospitable Launch Promo — two-tier price lock.
-- Every Hospitable-tagged org that converts trial -> paid gets a price lock:
--   Tier 1: the first 100 converters get a 2-year lock, numbered 1-100, no
--           time limit on this tier (it only ever closes by hitting 100).
--   Tier 2: the next 100 converters (101st-200th overall) get a 1-year lock,
--           but ONLY if they convert within 90 days of this promo's launch.
--           Whichever limit is hit first — the 100 count or the 90-day
--           window — closes tier 2. A late conversion that would have been
--           e.g. the 25th tier-2 slot gets nothing once the window closes,
--           even though tier 2's count cap wasn't reached.
-- Tagging happens at checkout start (createCheckoutSession); the award
-- happens on the existing billing/first-payment-confirmed event. See
-- lib/inngest/functions/promo-hospitable-tag-trial.ts and
-- promo-hospitable-award-lock.ts.

-- ============================================================================
-- Singleton counter — enforces both tier caps and the tier-2 time window
-- ============================================================================
CREATE TABLE promo_hospitable_launch_counter (
  id smallint PRIMARY KEY DEFAULT 1,

  first_tier_awarded_count  int NOT NULL DEFAULT 0,
  first_tier_max            int NOT NULL DEFAULT 100,

  second_tier_awarded_count int NOT NULL DEFAULT 0,
  second_tier_max           int NOT NULL DEFAULT 100,

  -- Promo launch time — the tier-2 90-day window is computed from this, not
  -- from migration-apply time re-read on every call, so it stays fixed once set.
  launch_at                 timestamptz NOT NULL DEFAULT now(),
  second_tier_window_days   int NOT NULL DEFAULT 90,

  CONSTRAINT single_row_only CHECK (id = 1),
  CONSTRAINT non_negative_counts CHECK (first_tier_awarded_count >= 0 AND second_tier_awarded_count >= 0),
  CONSTRAINT counts_within_max CHECK (
    first_tier_awarded_count <= first_tier_max
    AND second_tier_awarded_count <= second_tier_max
  )
);

INSERT INTO promo_hospitable_launch_counter (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

ALTER TABLE promo_hospitable_launch_counter ENABLE ROW LEVEL SECURITY;
-- Intentionally no policies. Only service_role (bypasses RLS) can touch this
-- table, and only via the SECURITY DEFINER function below.

-- ============================================================================
-- Per-organization enrollment / award record
-- ============================================================================
CREATE TABLE hospitable_launch_promo (
  org_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,

  hospitable_tagged    boolean NOT NULL DEFAULT false,
  hospitable_tagged_at timestamptz,
  attribution_source   text, -- 'hospitable_marketplace_oneclick' | 'hospitable_landing_page' | 'manual_connect'

  converted_to_paid_at timestamptz,

  price_lock_awarded      boolean NOT NULL DEFAULT false,
  price_lock_active       boolean NOT NULL DEFAULT false,
  -- Numbered 1-100 for the tier-1 (2-year) lock only. NULL for the tier-2
  -- (1-year) lock — tier 2 is capped/time-boxed internally via the counter
  -- table above, but deliberately not surfaced as "#N of 100" in the UI/email
  -- (see components/settings/price-lock-badge.tsx and the congrats email).
  price_lock_sequence     int UNIQUE CHECK (price_lock_sequence BETWEEN 1 AND 100),
  price_lock_years        smallint CHECK (price_lock_years IN (1, 2)),
  price_lock_tier         text,
  price_lock_amount_cents int CHECK (price_lock_amount_cents IS NULL OR price_lock_amount_cents >= 0),
  awarded_at              timestamptz,
  price_lock_expires_at   timestamptz,

  congrats_email_sent_at timestamptz,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_hospitable_launch_promo_active_locks
  ON hospitable_launch_promo (price_lock_expires_at)
  WHERE price_lock_active = true;

ALTER TABLE hospitable_launch_promo
  ADD CONSTRAINT attribution_source_valid_values
  CHECK (
    attribution_source IS NULL
    OR attribution_source IN (
      'hospitable_marketplace_oneclick',
      'hospitable_landing_page',
      'manual_connect'
    )
  );

ALTER TABLE hospitable_launch_promo ENABLE ROW LEVEL SECURITY;

-- Org members can read their own org's promo status (for the settings badge).
CREATE POLICY "org_members_select_own_promo_status"
  ON hospitable_launch_promo
  FOR SELECT
  TO authenticated
  USING (
    org_id IN (
      SELECT get_user_org_ids()
    )
  );
-- No INSERT/UPDATE/DELETE policies for authenticated/anon — all writes go
-- through the SECURITY DEFINER functions below.

CREATE OR REPLACE FUNCTION set_hospitable_promo_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_hospitable_launch_promo_updated_at
  BEFORE UPDATE ON hospitable_launch_promo
  FOR EACH ROW
  EXECUTE FUNCTION set_hospitable_promo_updated_at();

-- ============================================================================
-- Tagging function — called once when checkout starts. Determines Hospitable
-- connection status AND attribution source in one atomic call. Idempotent —
-- only ever writes the tag once (WHERE hospitable_tagged_at IS NULL guard).
-- ============================================================================
CREATE OR REPLACE FUNCTION tag_hospitable_trial_signup(
  p_org_id uuid,
  p_landing_page_cookie_present boolean DEFAULT false
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_is_connected boolean;
  v_is_marketplace boolean;
  v_attribution text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM integration_connections
    WHERE org_id = p_org_id AND provider_id = 'hospitable' AND status = 'active'
  ) INTO v_is_connected;

  IF v_is_connected THEN
    SELECT EXISTS (
      SELECT 1 FROM audit_events
      WHERE org_id = p_org_id
        AND action = 'integration.connected'
        AND target_type = 'integration_provider'
        AND target_id = 'hospitable'
        AND metadata->>'trigger' = 'marketplace_install'
    ) INTO v_is_marketplace;

    v_attribution := CASE
      WHEN v_is_marketplace THEN 'hospitable_marketplace_oneclick'
      WHEN p_landing_page_cookie_present THEN 'hospitable_landing_page'
      ELSE 'manual_connect'
    END;
  ELSE
    v_attribution := NULL;
  END IF;

  INSERT INTO hospitable_launch_promo (org_id, hospitable_tagged, hospitable_tagged_at, attribution_source)
  VALUES (
    p_org_id,
    v_is_connected,
    CASE WHEN v_is_connected THEN now() ELSE NULL END,
    v_attribution
  )
  ON CONFLICT (org_id) DO UPDATE
  SET
    hospitable_tagged = EXCLUDED.hospitable_tagged,
    hospitable_tagged_at = COALESCE(hospitable_launch_promo.hospitable_tagged_at, EXCLUDED.hospitable_tagged_at),
    attribution_source = COALESCE(hospitable_launch_promo.attribution_source, EXCLUDED.attribution_source)
  WHERE hospitable_launch_promo.hospitable_tagged_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION tag_hospitable_trial_signup(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION tag_hospitable_trial_signup(uuid, boolean) TO service_role;

-- ============================================================================
-- Claim function — atomic slot claim + two-tier award, race-safe via the
-- counter table's conditional UPDATE ... WHERE ... RETURNING (row-locked by
-- Postgres for the statement's duration, same as a single-tier counter).
--
--   Tier 1 (2-year, numbered 1-100): tried first, no time limit.
--   Tier 2 (1-year, uncapped display but internally capped at 100 more, AND
--   only within second_tier_window_days of launch_at): tried only if tier 1
--   is full. Either limit closes tier 2 — a late conversion after the window
--   gets `window_closed = true` even if tier 2's count cap wasn't reached.
-- ============================================================================
CREATE OR REPLACE FUNCTION claim_hospitable_promo_slot(
  p_org_id uuid,
  p_tier text,
  p_price_cents int
)
RETURNS TABLE (
  sequence_number int,
  already_awarded boolean,
  not_eligible    boolean,
  window_closed   boolean,
  lock_years      int
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_existing        hospitable_launch_promo%ROWTYPE;
  v_launch_at       timestamptz;
  v_window_days     int;
  v_claimed_first   int;
  v_claimed_second  int;
  v_lock_years      int;
  v_sequence        int;
BEGIN
  SELECT * INTO v_existing
  FROM hospitable_launch_promo
  WHERE org_id = p_org_id
  FOR UPDATE;

  IF v_existing.price_lock_awarded THEN
    RETURN QUERY SELECT v_existing.price_lock_sequence, true, false, false, v_existing.price_lock_years;
    RETURN;
  END IF;

  IF v_existing.org_id IS NULL OR v_existing.hospitable_tagged = false THEN
    RETURN QUERY SELECT NULL::int, false, true, false, NULL::int; -- never tagged — not eligible at all
    RETURN;
  END IF;

  SELECT launch_at, second_tier_window_days
  INTO v_launch_at, v_window_days
  FROM promo_hospitable_launch_counter
  WHERE id = 1;

  -- Try tier 1 (first 100, 2-year, no time limit).
  UPDATE promo_hospitable_launch_counter
  SET first_tier_awarded_count = first_tier_awarded_count + 1
  WHERE id = 1 AND first_tier_awarded_count < first_tier_max
  RETURNING first_tier_awarded_count INTO v_claimed_first;

  IF v_claimed_first IS NOT NULL THEN
    v_lock_years := 2;
    v_sequence   := v_claimed_first;
  ELSE
    -- Missed tier 1 — tier 2 requires BOTH still being within the window
    -- AND a free slot in the second 100.
    IF now() > v_launch_at + (v_window_days::text || ' days')::interval THEN
      RETURN QUERY SELECT NULL::int, false, false, true, NULL::int; -- window closed
      RETURN;
    END IF;

    UPDATE promo_hospitable_launch_counter
    SET second_tier_awarded_count = second_tier_awarded_count + 1
    WHERE id = 1 AND second_tier_awarded_count < second_tier_max
    RETURNING second_tier_awarded_count INTO v_claimed_second;

    IF v_claimed_second IS NULL THEN
      RETURN QUERY SELECT NULL::int, false, false, true, NULL::int; -- tier 2 full
      RETURN;
    END IF;

    v_lock_years := 1;
    v_sequence   := NULL; -- tier 2 stays unnumbered in the UI/email by design
  END IF;

  UPDATE hospitable_launch_promo
  SET
    price_lock_awarded = true,
    price_lock_active = true,
    price_lock_sequence = v_sequence,
    price_lock_years = v_lock_years,
    price_lock_tier = p_tier,
    price_lock_amount_cents = p_price_cents,
    converted_to_paid_at = now(),
    awarded_at = now(),
    price_lock_expires_at = now() + (v_lock_years::text || ' years')::interval
  WHERE org_id = p_org_id;

  RETURN QUERY SELECT v_sequence, false, false, false, v_lock_years;
END;
$$;

REVOKE ALL ON FUNCTION claim_hospitable_promo_slot(uuid, text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION claim_hospitable_promo_slot(uuid, text, int) TO service_role;
