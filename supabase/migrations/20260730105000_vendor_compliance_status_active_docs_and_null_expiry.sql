-- Data-layer H (pre-launch audit 2026-07-30) — vendor_compliance_status
-- reports uninsured vendors as `compliant`.
--
-- Two independent holes in the definition from
-- 20260720170645_widen_vendor_compliance_grace_period_to_45_days.sql:43-61:
--
--   1. the `no_documents` guard is `COUNT(d.id) = 0` — UNFILTERED — while
--      every later branch filters `d.is_active = true`. A vendor whose only
--      COI has been deactivated therefore has COUNT(d.id) > 0 (not
--      no_documents) and zero active docs (no hard_blocked / grace_period /
--      expiring_soon branch fires either), so it falls through to
--      ELSE 'compliant'.
--   2. vendor_compliance_documents.expiry_date is NULLABLE, and every branch
--      compares it with < / BETWEEN, which is NULL (never true). An active
--      document with no expiry recorded lands in the same ELSE 'compliant'.
--
-- This view is the enforcement boundary for WO assignment
-- (lib/vendors/compliance.ts:16-23, lib/inngest/functions/auto-assign-vendor.ts,
-- app/(dashboard)/maintenance/CreateWorkOrderModal.tsx), so "compliant" here
-- means a real uninsured vendor can be dispatched to a customer's property.
-- Zero vendors are affected today; it fires the first time a PM deactivates a
-- document or uploads one without an expiry date, both normal UI actions.
--
-- Fix, WITHOUT adding a new compliance_status value: a document only counts
-- as a document when it is BOTH is_active AND has an expiry_date. Everything
-- else collapses into the existing `no_documents` state, which every consumer
-- already handles (CreateWorkOrderModal.tsx:416 renders its own warning for
-- it). Introducing e.g. 'missing_expiry' would silently render as the
-- green/compliant fallback in the ternary chains at
-- app/(dashboard)/vendors/[id]/page.tsx:82-101 — strictly worse than
-- reporting the honest "no usable document on file".
--
-- Everything else about the view — column list, the 45-day grace window, the
-- counts, days_past_expiry — is unchanged.

CREATE OR REPLACE VIEW public.vendor_compliance_status AS
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
    -- Counts ONLY documents that are active AND carry an expiry date, so a
    -- deactivated-only or expiry-less vendor can never reach ELSE below.
    WHEN COUNT(d.id) FILTER (
      WHERE d.is_active = true
        AND d.expiry_date IS NOT NULL
    ) = 0
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

-- Re-assert invoker semantics from
-- 20260728184128_fix_vendor_compliance_status_security_invoker.sql — the view
-- has no org_id filter of its own and relies entirely on the underlying
-- tables' RLS. Idempotent and cheap; never let a REPLACE silently revert it.
ALTER VIEW public.vendor_compliance_status SET (security_invoker = true);
