
-- ================================================================
-- 1. Vendor geocoding
-- ================================================================
ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS lat           NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS lng           NUMERIC(9,6),
  ADD COLUMN IF NOT EXISTS service_zip   TEXT,
  ADD COLUMN IF NOT EXISTS service_radius_miles SMALLINT DEFAULT 25;

COMMENT ON COLUMN vendors.lat IS
  'Geocoded latitude from service_zip. Populated via Mapbox on vendor
   create/update. Used for proximity routing in WO assignment and
   emergency dispatch. Same pattern as properties.lat.';
COMMENT ON COLUMN vendors.service_radius_miles IS
  'How far this vendor is willing to travel. Default 25 miles.
   Used to filter vendor suggestions on the WO assignment form.';

-- ================================================================
-- 2. Compliance gate — grace period tracking
--    The 30-day grace window is computed from expiry_date in
--    application code (no column needed). But we do need a timestamp
--    for when the PM was first warned, to create an accurate audit
--    trail and to support the Inngest escalation reminder schedule.
-- ================================================================
ALTER TABLE vendor_compliance_documents
  ADD COLUMN IF NOT EXISTS first_warned_at  TIMESTAMPTZ DEFAULT NULL,
  ADD COLUMN IF NOT EXISTS hard_blocked_at  TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN vendor_compliance_documents.first_warned_at IS
  'Timestamp when the system first surfaced the 30-day soft warning
   to the PM. Used to verify the grace window start date and to
   trigger the Inngest 7-day escalation reminder.';
COMMENT ON COLUMN vendor_compliance_documents.hard_blocked_at IS
  'Timestamp when the document passed day 31 post-expiry and the
   hard block was enforced. Stored for audit trail purposes.';

-- ================================================================
-- 3. Update vendor_compliance_status view to expose grace period state
-- ================================================================
DROP VIEW IF EXISTS vendor_compliance_status;

CREATE OR REPLACE VIEW vendor_compliance_status AS
SELECT
  v.id                                                AS vendor_id,
  v.org_id,
  v.name                                              AS vendor_name,
  v.lat,
  v.lng,
  v.service_zip,
  v.service_radius_miles,
  COUNT(d.id) FILTER (
    WHERE d.expiry_date >= CURRENT_DATE
      AND d.is_active = true
  )                                                   AS active_doc_count,
  COUNT(d.id) FILTER (
    WHERE d.expiry_date < CURRENT_DATE
      AND d.is_active = true
  )                                                   AS expired_doc_count,
  COUNT(d.id) FILTER (
    WHERE d.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30
      AND d.is_active = true
  )                                                   AS expiring_soon_count,
  -- Oldest expired document (worst case)
  MIN(d.expiry_date) FILTER (
    WHERE d.expiry_date < CURRENT_DATE
      AND d.is_active = true
  )                                                   AS earliest_expired_date,
  -- Days since oldest expiry (drives grace vs hard block)
  CASE
    WHEN MIN(d.expiry_date) FILTER (
      WHERE d.expiry_date < CURRENT_DATE AND d.is_active = true
    ) IS NOT NULL
    THEN CURRENT_DATE - MIN(d.expiry_date) FILTER (
      WHERE d.expiry_date < CURRENT_DATE AND d.is_active = true
    )
    ELSE NULL
  END                                                 AS days_past_expiry,
  -- Compliance status with grace period logic
  CASE
    WHEN COUNT(d.id) = 0
      THEN 'no_documents'
    WHEN COUNT(d.id) FILTER (
      WHERE d.expiry_date < CURRENT_DATE - 30   -- past grace window
        AND d.is_active = true
    ) > 0
      THEN 'hard_blocked'                         -- day 31+: no WOs
    WHEN COUNT(d.id) FILTER (
      WHERE d.expiry_date < CURRENT_DATE          -- expired but within grace
        AND d.is_active = true
    ) > 0
      THEN 'grace_period'                         -- days 1-30: soft warn + ack
    WHEN COUNT(d.id) FILTER (
      WHERE d.expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30
        AND d.is_active = true
    ) > 0
      THEN 'expiring_soon'                        -- pre-expiry warning
    ELSE 'compliant'
  END                                               AS compliance_status
FROM vendors v
LEFT JOIN vendor_compliance_documents d ON d.vendor_id = v.id
GROUP BY v.id, v.org_id, v.name, v.lat, v.lng, v.service_zip, v.service_radius_miles;
