-- The guardrail for column-narrowed UPDATE grants.
--
-- Four tables now grant `authenticated` UPDATE on named columns instead of the
-- whole row — notifications (20260824001028), owner_transactions and reviews
-- (20260824011027). Each was narrowed because the write PATH only ever touched
-- one or two columns while the GRANT permitted every column, on a table that
-- holds a record rather than data a user maintains.
--
-- Nothing stops a later migration writing `GRANT UPDATE ON reviews TO
-- authenticated` and quietly undoing all of it. That is the failure this
-- reports: a widened grant is INVISIBLE — no error, no behaviour change, no
-- test goes red, and the only symptom is a capability nobody meant to hand out.
--
-- A separate function rather than a section on db_invariant_report(), because
-- adding one there means reproducing that whole 190-line body under CREATE OR
-- REPLACE, and a transcription slip in it would break checks 1-11 to add a 12th.
--
-- WHY "SOME BUT NOT ALL" IS THE RIGHT PREDICATE. A table-level GRANT UPDATE
-- confers the privilege on every column, so `granted = total` means table-wide
-- and `0 < granted < total` means narrowed. Dropping off this list is therefore
-- exactly the regression — a table appears here while it is narrowed and
-- vanishes the moment it is not, which is what lets check 12's registry be a
-- simple must-be-present assertion instead of a grant parser.

CREATE OR REPLACE FUNCTION public.db_narrowed_update_grants()
RETURNS jsonb
LANGUAGE sql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
  SELECT coalesce(jsonb_agg(s.entry ORDER BY s.entry->>'table'), '[]'::jsonb)
  FROM (
    SELECT jsonb_build_object(
             'table',   cl.relname,
             'columns', jsonb_agg(a.attname ORDER BY a.attname)
                          FILTER (WHERE pg_catalog.has_column_privilege(
                            'authenticated', cl.oid, a.attnum, 'UPDATE'))
           ) AS entry
    FROM pg_catalog.pg_class cl
    JOIN pg_catalog.pg_namespace n ON n.oid = cl.relnamespace AND n.nspname = 'public'
    JOIN pg_catalog.pg_attribute a
      ON a.attrelid = cl.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE cl.relkind = 'r'
    GROUP BY cl.oid, cl.relname
    HAVING count(*) FILTER (WHERE pg_catalog.has_column_privilege(
             'authenticated', cl.oid, a.attnum, 'UPDATE')) > 0
       AND count(*) FILTER (WHERE pg_catalog.has_column_privilege(
             'authenticated', cl.oid, a.attnum, 'UPDATE')) < count(*)
  ) s;
$function$;

-- Same exposure as db_invariant_report(): the CI script's service key, and
-- nothing else. It reads the grant catalogue, which is not a client's business.
REVOKE ALL ON FUNCTION public.db_narrowed_update_grants() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.db_narrowed_update_grants() TO service_role;

COMMENT ON FUNCTION public.db_narrowed_update_grants() IS
  'Every public table where `authenticated` holds UPDATE on SOME but not ALL columns, with the granted column list. Read by scripts/check-db-invariants.mjs check 12, whose registry names the tables that must appear here — a table that silently regains a table-wide UPDATE grant drops off this list, which is the regression the check exists to catch.';
