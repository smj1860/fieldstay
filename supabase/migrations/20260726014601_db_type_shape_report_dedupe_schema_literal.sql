-- Reconciliation capture (Task 4, migration drift): this already exists
-- live under version 20260726014601 with no matching local file — captured
-- verbatim from pg_get_functiondef(). Dedupes the repeated 'public' schema
-- literal in db_type_shape_report (from 20260725201034_db_type_shape_report.sql)
-- into a single CTE.
CREATE OR REPLACE FUNCTION public.db_type_shape_report()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  WITH target_schema AS (
    SELECT 'public'::name AS schema_name
  )
  SELECT jsonb_build_object(
    'tables', (
      SELECT coalesce(jsonb_object_agg(x.table_name, x.cols), '{}'::jsonb)
      FROM (
        SELECT c.table_name,
               jsonb_object_agg(c.column_name, jsonb_build_object(
                 'data_type',   c.data_type,
                 'udt_name',    c.udt_name,
                 'is_nullable', (c.is_nullable = 'YES')
               )) AS cols
        FROM information_schema.columns c
        WHERE c.table_schema = (SELECT schema_name FROM target_schema)
          AND EXISTS (
            SELECT 1 FROM information_schema.tables t
            WHERE t.table_schema = (SELECT schema_name FROM target_schema)
              AND t.table_name   = c.table_name
              AND t.table_type   = 'BASE TABLE'
          )
        GROUP BY c.table_name
      ) x
    ),
    'enums', (
      SELECT coalesce(jsonb_object_agg(e.enum_name, e.labels), '{}'::jsonb)
      FROM (
        SELECT t.typname AS enum_name,
               jsonb_agg(en.enumlabel ORDER BY en.enumsortorder) AS labels
        FROM pg_catalog.pg_type t
        JOIN pg_catalog.pg_enum en ON en.enumtypid = t.oid
        JOIN pg_catalog.pg_namespace n ON n.oid = t.typnamespace
        WHERE n.nspname = (SELECT schema_name FROM target_schema)
        GROUP BY t.typname
      ) e
    )
  );
$function$;
