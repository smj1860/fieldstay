-- Widens the vendor compliance grace period from 30 to 45 days past expiry
-- before a vendor is hard_blocked from work order assignment (auto or
-- manual). Recreates vendor_compliance_status exactly as defined in
-- 20260606051120_add_geocoding_to_vendors_and_grace_period_logic.sql, only
-- changing the 30 -> 45 day cutoff in the compliance_status CASE.
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
      WHERE d.expiry_date < CURRENT_DATE - 45   -- past grace window
        AND d.is_active = true
    ) > 0
      THEN 'hard_blocked'                         -- day 46+: no WOs
    WHEN COUNT(d.id) FILTER (
      WHERE d.expiry_date < CURRENT_DATE          -- expired but within grace
        AND d.is_active = true
    ) > 0
      THEN 'grace_period'                         -- days 1-45: soft warn + ack
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
