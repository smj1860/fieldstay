-- ============================================================================
-- A brand-new org must not be compliance-blocked before it has had a chance to
-- collect any documents.
--
-- vendor_compliance_status computes 'hard_blocked' purely from expiry_date: a
-- vendor with an active document expired 46+ days is blocked from every
-- work-order assignment path. That is the right rule for an established
-- account and the wrong one for a PM who signed up on Tuesday and bulk-
-- uploaded the COIs they already had on file — several of which are lapsed
-- precisely BECAUSE they have not chased the vendor for a new one yet. The
-- first thing FieldStay would do for them is refuse to let them dispatch
-- anybody.
--
-- WHAT THIS DOES NOT DO, deliberately: it does not touch compliance_status.
-- That column means "what the documents say", and three consumers rely on it
-- meaning exactly that —
--
--   • lib/notifications.ts filters the bell on
--     compliance_status IN ('hard_blocked','expiring_soon','grace_period')
--   • the vendor detail page renders it as a badge
--   • cron/metrics-snapshot tallies orgs by it
--
-- Folding the org's age into that column would drop a genuinely expired COI
-- out of the notification bell — telling the new PM nothing is wrong when
-- something is. They should still be TOLD; they just should not be BLOCKED.
--
-- So the org's onboarding window is exposed as its own fact alongside the
-- status, and the blocking decision (lib/vendors/compliance.ts, which is the
-- enforcement boundary) combines the two.
--
-- 60 days rather than 45. The 45 already means something else here — the
-- window a document may stay expired before it hard-blocks — and two clocks
-- sharing a number is how a debugging session goes wrong. 60 is also the more
-- forgiving reading of "they have not had time to get the info to us yet",
-- which is the entire point of the grace.
--
-- LEFT JOIN, not JOIN: the view is security_invoker, so the organizations read
-- runs under the caller's RLS (orgs_select — members of that org only). If a
-- caller ever cannot see the org row, a LEFT JOIN yields NULL and the vendor
-- still appears with org_onboarding_grace = false, i.e. exactly today's
-- behaviour. An inner join would instead make the vendor VANISH from the view,
-- and lib/vendors/compliance.ts treats a missing row as BLOCKED — so the
-- fail-safe direction and the fail-dangerous direction are opposite here, and
-- this is the safe one.
-- ============================================================================

CREATE OR REPLACE VIEW public.vendor_compliance_status
WITH (security_invoker = true) AS
SELECT
  v.id      AS vendor_id,
  v.org_id,
  v.name    AS vendor_name,
  v.lat,
  v.lng,
  v.service_zip,
  v.service_radius_miles,
  count(d.id) FILTER (WHERE d.expiry_date >= CURRENT_DATE AND d.is_active = true) AS active_doc_count,
  count(d.id) FILTER (WHERE d.expiry_date <  CURRENT_DATE AND d.is_active = true) AS expired_doc_count,
  count(d.id) FILTER (WHERE d.expiry_date >= CURRENT_DATE AND d.expiry_date <= (CURRENT_DATE + 30) AND d.is_active = true) AS expiring_soon_count,
  min(d.expiry_date) FILTER (WHERE d.expiry_date < CURRENT_DATE AND d.is_active = true) AS earliest_expired_date,
  CASE
    WHEN min(d.expiry_date) FILTER (WHERE d.expiry_date < CURRENT_DATE AND d.is_active = true) IS NOT NULL
      THEN CURRENT_DATE - min(d.expiry_date) FILTER (WHERE d.expiry_date < CURRENT_DATE AND d.is_active = true)
    ELSE NULL::integer
  END AS days_past_expiry,
  CASE
    WHEN count(d.id) FILTER (WHERE d.is_active = true AND d.expiry_date IS NOT NULL) = 0 THEN 'no_documents'::text
    WHEN count(d.id) FILTER (WHERE d.expiry_date < (CURRENT_DATE - 45) AND d.is_active = true) > 0 THEN 'hard_blocked'::text
    WHEN count(d.id) FILTER (WHERE d.expiry_date < CURRENT_DATE AND d.is_active = true) > 0 THEN 'grace_period'::text
    WHEN count(d.id) FILTER (WHERE d.expiry_date >= CURRENT_DATE AND d.expiry_date <= (CURRENT_DATE + 30) AND d.is_active = true) > 0 THEN 'expiring_soon'::text
    ELSE 'compliant'::text
  END AS compliance_status,

  -- The org's onboarding window. NULL org (see the LEFT JOIN note above)
  -- resolves to false via COALESCE, which is the no-grace / today's-behaviour
  -- direction.
  COALESCE(o.created_at > (now() - interval '60 days'), false) AS org_onboarding_grace,
  (o.created_at + interval '60 days')                          AS org_onboarding_grace_ends_at

FROM public.vendors v
  LEFT JOIN public.vendor_compliance_documents d ON d.vendor_id = v.id
  LEFT JOIN public.organizations o               ON o.id        = v.org_id
GROUP BY v.id, v.org_id, v.name, v.lat, v.lng, v.service_zip, v.service_radius_miles, o.created_at;

GRANT SELECT ON public.vendor_compliance_status TO authenticated;

NOTIFY pgrst, 'reload schema';
