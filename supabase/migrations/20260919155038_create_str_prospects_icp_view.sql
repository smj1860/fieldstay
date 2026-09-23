-- RECONSTRUCTED FROM PRODUCTION — see the header of
-- 20260919155031_create_str_prospects.sql for why these two files exist and
-- why the table underneath them has no RLS policies.
--
-- security_invoker=true, as in production: the view must not become a way to
-- read str_prospects around the deny-all RLS on the table. With the default
-- (security definer) a view is evaluated as its OWNER, which would hand any
-- role that could select from it the owner's access to every underlying row —
-- exactly what the empty policy list is there to prevent. Only service_role
-- holds a grant on it either way, but the invoker setting is what makes that
-- grant the ONLY thing standing in the way.

CREATE OR REPLACE VIEW public.str_prospects_icp
WITH (security_invoker = true) AS
  SELECT
    name,
    state,
    city,
    website,
    phone,
    email,
    property_count,
    confidence,
    kind,
    source,
    source_detail,
    evidence_url,
    status,
    pms,
    owner_notes,
    last_seen,
    CASE
      WHEN property_count >= 10  AND property_count <= 150 THEN 'core'
      WHEN property_count >= 151 AND property_count <= 225 THEN 'gray'
      WHEN property_count = 0                              THEN 'unsized'
      ELSE 'out_of_band'
    END AS icp_band,
    dedupe_key
  FROM public.str_prospects
  WHERE kind <> 'individual'
    AND confidence >= 60
    AND (property_count >= 10 AND property_count <= 225 OR property_count = 0)
  ORDER BY property_count DESC, confidence DESC;

REVOKE ALL ON public.str_prospects_icp FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.str_prospects_icp TO service_role;

COMMENT ON VIEW public.str_prospects_icp IS
  'strscout prospects filtered to the FieldStay ICP (10-150 properties core, gray band to 225, plus unsized directory/Places rows).';
