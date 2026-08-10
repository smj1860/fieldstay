-- Crew Sync v2: collapse notify_crew_sync's per-user send LOOP into one
-- set-based INSERT.
--
-- The loop is the legitimate half of the scalability audit's CATASTROPHIC
-- finding on crew realtime. It ran
--
--   FOR v_user_id IN SELECT DISTINCT u FROM unnest(p_user_ids) ...
--   LOOP PERFORM realtime.send(...) END LOOP
--
-- inside a STATEMENT-level trigger, so a single write that affects many crew
-- at once — a checklist template rolled out org-wide, a turnover reassigned
-- across a large pool, a bulk work-order update — did O(affected crew) of
-- everything: N gen_random_uuid(), N `SET LOCAL realtime.topic`, N INSERTs and
-- N subplan/exception frames, all on the writing transaction's clock.
--
-- realtime.send() is a thin wrapper over ONE INSERT into realtime.messages
-- whose only per-row variation is the topic string (verified against this
-- schema: pg_get_functiondef(realtime.send)). So the whole loop is expressible
-- as a single INSERT ... SELECT over unnest(). Same rows, same topics, same
-- payload, one statement.
--
-- ── What this deliberately does NOT do ──────────────────────────────────────
--
-- The audit paired this with moving from per-user topics (`crew:{user_id}`) to
-- one per-org topic (`crew-org:{org_id}`), on the stated grounds that "channel
-- count is now bounded by org count, not crew headcount". That does not hold:
-- Supabase Realtime's limit is CONCURRENT CLIENTS, not distinct topic names.
-- Ten devices joined to one shared topic is still ten clients — renaming the
-- topic changes nothing about the axis that is actually metered. (The real
-- per-device win, 3-4 postgres_changes channels down to 1, was already banked
-- by Phase 3.)
--
-- Against that non-benefit, per-org topics would have cost:
--
--   * Privacy. Today the RLS policy pins a crew member to their own topic and
--     they receive only their own signals. Per-org, every crew member receives
--     every signal in the org — and the proposed payload added
--     {turnover_id, property_id}, so crew would learn object ids for turnovers
--     and properties they are not assigned to. Crew RLS otherwise confines
--     them to assigned turnovers; this would have widened that.
--   * Correctness of the client filter the design depends on. The proposed
--     relevance test was a chain of ORs in which `!scope?.turnover_id` alone
--     makes an unassigned-property signal "relevant" — so nearly every signal
--     passes and every device pulls on every org event. That is precisely the
--     amplification the proposal's own comment warns against.
--   * Multi-org crew. The proposed RLS resolved the org with
--     `WHERE cm.user_id = auth.uid() LIMIT 1`, so a crew member in two orgs
--     could only ever join one arbitrary org's topic. Zero crew are multi-org
--     today, but nothing in the schema prevents it.
--
-- So: keep per-user topics and the existing RLS untouched, and take the part
-- that is real. No client change, no policy change, no new information
-- disclosure — the function's signature and observable output are identical.
--
-- ── Notes on the rewrite ────────────────────────────────────────────────────
--
-- * The `SET LOCAL realtime.topic` that realtime.send() performs is dropped.
--   Its purpose is to let RLS policies referencing realtime.topic() evaluate
--   during the INSERT, and realtime.messages has no INSERT policy at all —
--   the write succeeds because this function is SECURITY DEFINER owned by
--   `postgres`, which holds BYPASSRLS. That is exactly how the loop version
--   already worked, so this is not a new dependency.
-- * `id` is generated per row and mirrored into the payload, matching
--   realtime.send()'s behaviour so subscribers see the same message shape.
--   The client reads only `payload.entity`, but parity costs nothing.
-- * The EXCEPTION block moves from per-send to per-statement. The invariant it
--   protects is "a broadcast failure must never break the write that triggered
--   it", which is preserved. Per-user failure granularity was never meaningful:
--   these rows differ only by topic string, so a failure is systemic, not
--   row-specific.

CREATE OR REPLACE FUNCTION public.notify_crew_sync(p_user_ids uuid[], p_entity text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_user_ids IS NULL THEN
    RETURN;
  END IF;

  BEGIN
    INSERT INTO realtime.messages (id, payload, event, topic, private, extension)
    SELECT ids.new_id,
           jsonb_build_object('entity', p_entity, 'id', ids.new_id),
           'sync',
           'crew:' || ids.user_id::text,
           true,
           'broadcast'
      FROM (
        -- Dedupe FIRST, generate the id after. gen_random_uuid() is VOLATILE
        -- and evaluated per row BEFORE DISTINCT is applied to the select
        -- list, so `SELECT DISTINCT u, gen_random_uuid()` gives every
        -- duplicate user id its own uuid and none of them dedupe — a crew
        -- member listed twice in p_user_ids gets two broadcasts. The original
        -- loop was immune to this because it ran DISTINCT in its own
        -- FOR ... IN SELECT DISTINCT before ever calling send(). Caught by
        -- probing the rewrite with a deliberately duplicated id.
        SELECT d.user_id, gen_random_uuid() AS new_id
          FROM (
            SELECT DISTINCT u AS user_id
              FROM unnest(p_user_ids) AS u
             WHERE u IS NOT NULL
          ) AS d
      ) AS ids;
  EXCEPTION WHEN OTHERS THEN
    -- A broadcast failure must never break the write that triggered it.
    RAISE WARNING 'notify_crew_sync: send failed for % (%): %',
      p_entity, array_length(p_user_ids, 1), SQLERRM;
  END;
END;
$$;

-- Unchanged from the original: trigger-context only. An authenticated user
-- must not be able to spam arbitrary crew topics through this definer fn.
REVOKE EXECUTE ON FUNCTION public.notify_crew_sync(uuid[], text) FROM PUBLIC, anon, authenticated;
