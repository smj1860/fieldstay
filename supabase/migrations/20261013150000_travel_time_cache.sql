-- Phase G: routed travel times, cached per (origin, destination) pair.
--
-- WHY A CACHE AT ALL: a crew member's day is the same few property pairs every
-- week. Routing them nightly would spend a Mapbox request on an answer that
-- has not changed since the last time we asked, and the road between two
-- houses does not move.
--
-- WHY IT IS ORG-SCOPED rather than a global pair table. A row here is
-- "somebody has a property at these coordinates and another one at those",
-- which is portfolio shape. A global table would need either a policy letting
-- every authenticated user read every tenant's coordinate pairs, or no read
-- policy at all — and the policy-less case is a shrink-only allowlist in
-- scripts/check-db-invariants.mjs that nothing new may join. Scoping by org
-- costs almost nothing in hit rate (cross-tenant sharing would only help two
-- orgs with properties at identical coordinates) and keeps tenant isolation
-- the same shape as every other table.
--
-- WHY A TEXT KEY alongside the four coordinates: the read is one
-- `.in('cache_key', keys)` for a whole day's legs. A composite IN over four
-- numeric columns is not expressible in PostgREST, so the alternative is a
-- query per leg, which is the N+1 this cache exists to avoid.
--
-- The key is DIRECTIONAL. A to B is not B to A once one-way streets and turn
-- restrictions are involved, so travelLegKey() never normalises the pair.

CREATE TABLE IF NOT EXISTS travel_time_cache (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Rounded to 4 decimal places (~11m) by lib/travel/estimate.ts's
  -- roundCoord(), the same rounding that builds cache_key. Stored as well as
  -- keyed so a row is readable on its own when auditing coverage.
  cache_key   text NOT NULL,
  origin_lat  numeric(9,6) NOT NULL,
  origin_lng  numeric(9,6) NOT NULL,
  dest_lat    numeric(9,6) NOT NULL,
  dest_lng    numeric(9,6) NOT NULL,

  minutes     integer NOT NULL CHECK (minutes >= 0),
  -- Nullable: Mapbox returns a duration without a distance under some
  -- profiles, and a fabricated 0 would be summed into a day's mileage.
  miles       numeric(8,2),
  provider    text NOT NULL DEFAULT 'mapbox-matrix',

  fetched_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Also the covering index for the org_id FK (DB invariant check 3): org_id is
-- its leading column.
CREATE UNIQUE INDEX IF NOT EXISTS travel_time_cache_org_key_idx
  ON travel_time_cache (org_id, cache_key);

ALTER TABLE travel_time_cache ENABLE ROW LEVEL SECURITY;

-- SELECT only, deliberately. Every write comes from the day planner's Inngest
-- step under the service role, which bypasses RLS; there is no user-facing
-- write path to this table and granting one would let a member poison their
-- own org's drive times. Same shape as `notifications`, which is
-- system-inserted with a read policy for members.
DROP POLICY IF EXISTS "travel_time_cache_select" ON travel_time_cache;
CREATE POLICY "travel_time_cache_select"
  ON travel_time_cache FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

-- The grant Postgres checks BEFORE RLS ever evaluates. Without it every read
-- fails with "permission denied for table" however correct the policy is
-- (see 20260710200000_grant_authenticated_missing_tables.sql).
GRANT SELECT ON travel_time_cache TO authenticated;
