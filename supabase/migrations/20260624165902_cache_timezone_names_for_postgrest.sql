-- PostgREST fires SELECT name FROM pg_timezone_names on every schema cache
-- reload. pg_timezone_names reads from filesystem — 520ms per call at 182
-- calls = 10.67% of total DB time. A materialized view caches the result in
-- memory and reduces this to a sub-millisecond table scan.
CREATE MATERIALIZED VIEW IF NOT EXISTS public.cached_timezone_names AS
  SELECT name FROM pg_timezone_names;

CREATE UNIQUE INDEX IF NOT EXISTS idx_cached_timezone_names_name
  ON public.cached_timezone_names (name);

-- Note: this view needs a periodic refresh if timezone data changes,
-- which is essentially never in practice. If needed:
-- REFRESH MATERIALIZED VIEW CONCURRENTLY public.cached_timezone_names;
