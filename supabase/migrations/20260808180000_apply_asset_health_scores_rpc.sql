-- Fixes the asset-health score write, which has never worked.
--
-- persistScores (lib/inngest/functions/cron/asset-health-helpers.ts) wrote the
-- daily scores with
--
--   .upsert([{ id, health_score, health_score_updated_at }], { onConflict: 'id' })
--
-- under the comment "upsert with onConflict: 'id' only updates the columns
-- provided". That belief is wrong. PostgREST emits INSERT ... ON CONFLICT (id)
-- DO UPDATE, and Postgres validates NOT NULL on the PROPOSED tuple before it
-- resolves the conflict — so a partial column list fails 23502 on
-- property_assets.org_id every single time, even though the row exists and the
-- DO UPDATE branch is the one that would have run. It is not a race and not
-- intermittent: it is a 100% failure.
--
-- Reproduced against this schema on an id that already existed:
--   23502 :: null value in column "org_id" of relation "property_assets"
--            violates not-null constraint
--
-- Production evidence: 160 assets, 7 with a score, newest
-- health_score_updated_at 2026-06-20 — older than
-- asset-health-helpers.ts itself (created 2026-07-23). Nothing has been
-- persisted since the upsert shipped. It only became VISIBLE on 2026-08-07
-- when the read-without-error burn-down (c04b7784) stopped discarding the
-- write result, which is why Sentry calls it one day old.
--
-- The right verb was UPDATE, not upsert: every id in the payload was just read
-- from this table, and a score write must never create a row. PostgREST cannot
-- express a bulk UPDATE with per-row values, which is presumably why upsert was
-- reached for — so this does it in one statement, in one round trip, without
-- being able to insert anything.
--
-- p_org_id is defense in depth, not decoration: this is SECURITY DEFINER and
-- therefore bypasses RLS, so the WHERE clause pins every row it can touch to
-- the org the per-org cron invocation is already scoped to. A bug that mixed
-- up ids across tenants writes zero rows instead of another org's scores.
--
-- Returns the row count so the caller can compare it against what it sent and
-- notice assets that vanished mid-run, rather than assuming success.

CREATE OR REPLACE FUNCTION public.apply_asset_health_scores(
  p_org_id  uuid,
  p_updates jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated integer;
BEGIN
  IF p_org_id IS NULL THEN
    RAISE EXCEPTION 'apply_asset_health_scores requires p_org_id';
  END IF;

  UPDATE property_assets AS pa
     SET health_score            = u.health_score,
         health_score_updated_at = u.health_score_updated_at
    FROM jsonb_to_recordset(p_updates)
      AS u(id uuid, health_score smallint, health_score_updated_at timestamptz)
   WHERE pa.id     = u.id
     AND pa.org_id = p_org_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated;
END;
$$;

-- Same grant shape as claim_hospitable_promo_slot: the cron calls this with the
-- service role, and nothing else has any business writing health scores in bulk.
REVOKE ALL ON FUNCTION public.apply_asset_health_scores(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_asset_health_scores(uuid, jsonb) TO service_role;
