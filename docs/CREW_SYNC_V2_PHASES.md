# Crew Sync v2 — Remaining Phases (2–5): Implementation Instructions

Standalone instructions for completing the crew PWA realtime redesign
("Option B": **broadcast signal + delta pull**). Written so an agent with no
prior context on this project can execute each phase. Read `CLAUDE.md` at the
repo root in full before starting — every rule there applies to this work,
and several of its guardrail tests will fail your build if you skip it.

---

## 0. Context — What This Is and What's Already Done

### The design in one paragraph

The crew PWA (`app/crew/*`) is local-first: client components read only from
a Dexie (IndexedDB) cache, writes go through a local mutation outbox
(`lib/dexie/syncService.ts`), and a sync layer pulls Supabase data into
Dexie. The old sync layer used three Supabase Realtime `postgres_changes`
subscriptions plus periodic full refetches — expensive at scale because
`postgres_changes` fans out row payloads per subscriber and forces
per-subscriber RLS evaluation on the database. The v2 design replaces this
with **Realtime Broadcast as a wake-up signal only**: database triggers call
`realtime.send()` to a per-crew-user private topic (`crew:{user_id}`) with a
tiny `{entity}` payload, and the client responds by running a **delta pull**
(`updated_at` cursor filter) for that entity. Broadcasts carry no data, so
they're cheap and leak nothing; correctness never depends on a broadcast
arriving, because reconciliation pulls (full id-set) and a safety poll catch
anything missed.

### Phase status

| Phase | Content | Status |
|---|---|---|
| 0 | DB prep: `property_assets` touch trigger, `updated_at` indexes | ✅ Done — migration `20260724100000_crew_sync_delta_foundation.sql`, applied to prod **and** e2e project |
| 1 | Delta-sync foundation (cursors, delta pulls, reconciliation) | ✅ Done — merged and live in production since 2026-07-24 |
| 2 | Broadcast infrastructure (DB triggers + RLS on `realtime.messages`) | ⬜ **This document, section 2** |
| 3 | Client cutover (single private broadcast channel, behind a flag) | ⬜ Section 3 |
| 4 | Outbox retry backoff | ⬜ Section 4 |
| 5 | Rollout, acceptance test, old-code deletion, convention + guardrail | ⬜ Section 5 |

### Phase 1 artifacts you will build on (read these before touching code)

- `lib/dexie/sync/cursors.ts` — cursor storage + the pure
  `computeAdvancedCursor()` rule (max seen `updated_at` − 10 s overlap,
  forward-only) and `partitionByKnown()` (fresh scope ids must be pulled
  WITHOUT a cursor).
- `lib/dexie/sync/turnovers.ts` — turnover scope pull: full assignment pull
  always (that's the deletion/reconciliation mechanism), checklist pulls via
  `pullChecklistsForTurnovers(...)` with an `advanceCursors` option that
  defaults to `false` (partial-scope pulls must never advance a global
  cursor).
- `lib/dexie/sync/work-orders.ts` — id-only snapshot reconciliation + cursor
  delta.
- `lib/dexie/context.tsx` — `DexieProvider`: `resync()` on mount/reconnect,
  three `postgres_changes` channels (`turnover-assignments-*`,
  `checklist-items-*`, `property-assets-*`), and the generation-token guards
  (`refreshChecklistSubscription` / `refreshAssetsSubscription`). Phase 3
  replaces the channels and the generation machinery; Phase 5 deletes them.
- `unit/dexie/` — in-memory Dexie fake + sync tests. Extend these; don't
  hand-roll a new fake.

### Invariants — never break these

1. **Cursors are an optimization, never a correctness mechanism.** Deletion
   and scope membership are handled ONLY by reconciliation (full id-set
   pulls). A missing/stale cursor may cost bandwidth, never correctness.
2. **Cursors advance only from full-scope pulls**, only forward, and only
   from row `updated_at` values (never client wall-clock, never server
   "now").
3. **Fresh scope ids are pulled without a cursor** (`partitionByKnown`) —
   the scope-growth-vs-cursor trap.
4. **Broadcast payloads carry a signal, not data.** Only
   `{ entity: '<name>' }`. No row contents, no PII, no phone numbers, no
   org ids. The client treats any broadcast as "go pull".
5. **Triggers must never break the underlying write.** Every
   `realtime.send()` call is wrapped in its own exception handler.
6. **Crew client components never read Supabase directly** — Dexie only.
   Writes only via `enqueueMutation()`.
7. `SMS_ENABLED` stays untouched. Nothing in this work touches SMS.

### Supabase projects

| | Project ref | Use |
|---|---|---|
| Production | `vpmznjktllhmmbfnxuvk` | Apply every migration here |
| E2E/CI | `syhthijeqlnltufdawyb` (fieldstay-e2e) | Apply every migration here too (schema parity for CI) |

The Supabase account has **unrelated projects (Rootstock-vercel,
trade-suite-pro)** — never touch them. Apply migrations with the Supabase
MCP `apply_migration` tool (name = the migration filename's version +
description), and commit the identical SQL file to
`supabase/migrations/` in the same PR.

### Repo working rules (summary — CLAUDE.md is authoritative)

- Verification pass before every commit:
  `npx tsc --noEmit && npm run lint && npx vitest run && npm run check:ui-classes`
- Migration filenames: `YYYYMMDDHHMMSS_description.sql`, version prefix must
  be unique (the `migration-hygiene` guardrail test fails the build
  otherwise). All DDL idempotent (`CREATE OR REPLACE`, `DROP ... IF EXISTS`).
- A migration that adds/changes columns updates `types/database.ts` in the
  same commit (Phases 2–5 add no columns, so this shouldn't trigger).
- `Math.random()` is ESLint-banned; the two legitimate uses in this work
  (reconnect jitter, backoff jitter) each need
  `// eslint-disable-next-line no-restricted-properties` with a one-line
  justification, matching the existing sampling/jitter sites.
- New conventions ship WITH a guardrail (ESLint rule or `unit/guardrails/`
  test) in the same PR — see Phase 5.

---

## 1. Entity → signal mapping (shared vocabulary for Phases 2 and 3)

The broadcast payload's `entity` value must match what the client switches
on. Exactly three values exist:

| `entity` value | Fired by changes to | Client reaction (Phase 3) |
|---|---|---|
| `turnovers` | `turnover_assignments`, `turnovers` | Full turnover scope pull (assignments reconciliation + turnover rows + checklists for fresh turnovers) |
| `checklists` | `checklist_instances`, `checklist_instance_items` | Checklist delta pull across the current assigned-turnover set |
| `work_orders` | `work_orders` | Work-order snapshot reconciliation + delta |

`property_assets` deliberately has **no trigger**: crew-facing asset data is
low-churn, the property→crew fan-out join is wide, and the Phase 3 safety
poll (≤5 min staleness) plus the turnover-signal refresh covers it. If that
freshness ever becomes insufficient, add a sixth trigger later — don't do it
now.

---

## 2. Phase 2 — Broadcast migration (deploys dark)

**Goal:** all database-side broadcast infrastructure, live in production but
invisible — no client subscribes to these topics until Phase 3, so this
phase has zero user-facing risk and does not need to wait for any soak
window.

**Deliverable:** one migration file
`supabase/migrations/<YYYYMMDDHHMMSS>_crew_sync_broadcast_triggers.sql`
(pick the current UTC timestamp; verify the version prefix is unique in the
directory), applied to **both** Supabase projects, plus verification
evidence.

### 2a. Design constraints (why the SQL looks the way it does)

- **Statement-level AFTER triggers with transition tables** — one trigger
  invocation per statement regardless of row count (a bulk checklist
  instantiation of 60 items = one broadcast, not 60). PostgreSQL does not
  allow transition tables on multi-event triggers, so each table gets one
  trigger **per event** (INSERT/UPDATE/DELETE as needed), all sharing one
  trigger function that branches on `TG_OP`.
- **`SECURITY DEFINER` + `SET search_path = ''`** on every function: the
  functions must read join tables (`crew_members`, `turnover_assignments`,
  `checklist_instances`) without being filtered by the calling role's RLS,
  and a pinned empty search_path (with fully schema-qualified references)
  is the Supabase-advisor-clean way to write definer functions.
- **Per-user exception-safe send loop**: a `realtime.send()` failure must
  log a warning and continue — it must never abort the transaction that
  performed the actual write.
- **No DELETE trigger on `turnovers` or checklist tables**: deleting a
  turnover cascade-deletes its `turnover_assignments` rows, and cascaded
  deletes fire the child table's own statement trigger — so the
  `turnover_assignments` DELETE trigger already signals the affected crew.
  Checklist deletes likewise cascade from turnovers; reconciliation covers
  the rest.
- **UPDATE triggers notify old AND new parties** where a row can be
  re-pointed (`turnover_assignments.crew_member_id`,
  `work_orders.assigned_crew_member_id`) — a reassigned crew member must be
  told the item left their scope, not just the new assignee told it
  arrived.
- **`crew_members.user_id` is nullable** (some crew have no auth account) —
  always filter `user_id IS NOT NULL`.

### 2b. The migration SQL

Use this SQL as written (re-verify column names against
`types/database.ts` / the live schema before applying — key joins:
`turnover_assignments(turnover_id, crew_member_id)`,
`crew_members(id, user_id)`, `checklist_instances(id, turnover_id)`,
`checklist_instance_items(id, instance_id)`,
`work_orders(id, assigned_crew_member_id)`):

```sql
-- Crew Sync v2 Phase 2: broadcast wake-up signals for the crew PWA.
-- Statement-level triggers call realtime.send() on topic 'crew:{user_id}'
-- with a minimal {entity} payload. Signal-only: no row data, no PII.
-- Deploys dark — no client subscribes until the Phase 3 cutover.

-- ── Shared send helper ──────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.notify_crew_sync(p_user_ids uuid[], p_entity text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  IF p_user_ids IS NULL THEN
    RETURN;
  END IF;
  FOR v_user_id IN SELECT DISTINCT u FROM unnest(p_user_ids) AS u WHERE u IS NOT NULL
  LOOP
    BEGIN
      PERFORM realtime.send(
        jsonb_build_object('entity', p_entity),  -- payload: signal only, never row data
        'sync',                                  -- event
        'crew:' || v_user_id::text,              -- topic
        true                                     -- private channel
      );
    EXCEPTION WHEN OTHERS THEN
      -- A broadcast failure must never break the write that triggered it.
      RAISE WARNING 'notify_crew_sync: send failed for user % (%): %',
        v_user_id, p_entity, SQLERRM;
    END;
  END LOOP;
END;
$$;

-- Not callable by clients — trigger-context only. An authenticated user
-- must not be able to spam arbitrary crew topics through this definer fn.
REVOKE EXECUTE ON FUNCTION public.notify_crew_sync(uuid[], text) FROM PUBLIC, anon, authenticated;

-- ── turnover_assignments → 'turnovers' ─────────────────────────────────
CREATE OR REPLACE FUNCTION public.crew_sync_on_turnover_assignments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT cm.user_id) INTO v_user_ids
    FROM new_rows r
    JOIN public.crew_members cm ON cm.id = r.crew_member_id
    WHERE cm.user_id IS NOT NULL;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT cm.user_id) INTO v_user_ids
    FROM old_rows r
    JOIN public.crew_members cm ON cm.id = r.crew_member_id
    WHERE cm.user_id IS NOT NULL;
  ELSE  -- UPDATE: notify both the previous and the new crew member
    SELECT array_agg(DISTINCT cm.user_id) INTO v_user_ids
    FROM (
      SELECT crew_member_id FROM new_rows
      UNION
      SELECT crew_member_id FROM old_rows
    ) r
    JOIN public.crew_members cm ON cm.id = r.crew_member_id
    WHERE cm.user_id IS NOT NULL;
  END IF;

  PERFORM public.notify_crew_sync(v_user_ids, 'turnovers');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS crew_sync_turnover_assignments_ins ON public.turnover_assignments;
CREATE TRIGGER crew_sync_turnover_assignments_ins
  AFTER INSERT ON public.turnover_assignments
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_turnover_assignments();

DROP TRIGGER IF EXISTS crew_sync_turnover_assignments_upd ON public.turnover_assignments;
CREATE TRIGGER crew_sync_turnover_assignments_upd
  AFTER UPDATE ON public.turnover_assignments
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_turnover_assignments();

DROP TRIGGER IF EXISTS crew_sync_turnover_assignments_del ON public.turnover_assignments;
CREATE TRIGGER crew_sync_turnover_assignments_del
  AFTER DELETE ON public.turnover_assignments
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_turnover_assignments();

-- ── turnovers (UPDATE only) → 'turnovers' ──────────────────────────────
-- INSERT is pointless (a brand-new turnover has no assignments yet — the
-- assignment INSERT is the signal). DELETE is covered by the FK cascade
-- firing crew_sync_turnover_assignments_del.
CREATE OR REPLACE FUNCTION public.crew_sync_on_turnovers()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT cm.user_id) INTO v_user_ids
  FROM new_rows r
  JOIN public.turnover_assignments ta ON ta.turnover_id = r.id
  JOIN public.crew_members cm ON cm.id = ta.crew_member_id
  WHERE cm.user_id IS NOT NULL;

  PERFORM public.notify_crew_sync(v_user_ids, 'turnovers');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS crew_sync_turnovers_upd ON public.turnovers;
CREATE TRIGGER crew_sync_turnovers_upd
  AFTER UPDATE ON public.turnovers
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_turnovers();

-- ── checklist_instances (INSERT, UPDATE) → 'checklists' ────────────────
CREATE OR REPLACE FUNCTION public.crew_sync_on_checklist_instances()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT cm.user_id) INTO v_user_ids
  FROM new_rows r
  JOIN public.turnover_assignments ta ON ta.turnover_id = r.turnover_id
  JOIN public.crew_members cm ON cm.id = ta.crew_member_id
  WHERE cm.user_id IS NOT NULL;

  PERFORM public.notify_crew_sync(v_user_ids, 'checklists');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS crew_sync_checklist_instances_ins ON public.checklist_instances;
CREATE TRIGGER crew_sync_checklist_instances_ins
  AFTER INSERT ON public.checklist_instances
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_checklist_instances();

DROP TRIGGER IF EXISTS crew_sync_checklist_instances_upd ON public.checklist_instances;
CREATE TRIGGER crew_sync_checklist_instances_upd
  AFTER UPDATE ON public.checklist_instances
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_checklist_instances();

-- ── checklist_instance_items (INSERT, UPDATE) → 'checklists' ───────────
CREATE OR REPLACE FUNCTION public.crew_sync_on_checklist_items()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_ids uuid[];
BEGIN
  SELECT array_agg(DISTINCT cm.user_id) INTO v_user_ids
  FROM new_rows r
  JOIN public.checklist_instances ci ON ci.id = r.instance_id
  JOIN public.turnover_assignments ta ON ta.turnover_id = ci.turnover_id
  JOIN public.crew_members cm ON cm.id = ta.crew_member_id
  WHERE cm.user_id IS NOT NULL;

  PERFORM public.notify_crew_sync(v_user_ids, 'checklists');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS crew_sync_checklist_items_ins ON public.checklist_instance_items;
CREATE TRIGGER crew_sync_checklist_items_ins
  AFTER INSERT ON public.checklist_instance_items
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_checklist_items();

DROP TRIGGER IF EXISTS crew_sync_checklist_items_upd ON public.checklist_instance_items;
CREATE TRIGGER crew_sync_checklist_items_upd
  AFTER UPDATE ON public.checklist_instance_items
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_checklist_items();

-- ── work_orders (INSERT, UPDATE, DELETE) → 'work_orders' ───────────────
CREATE OR REPLACE FUNCTION public.crew_sync_on_work_orders()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_user_ids uuid[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT cm.user_id) INTO v_user_ids
    FROM new_rows r
    JOIN public.crew_members cm ON cm.id = r.assigned_crew_member_id
    WHERE r.assigned_crew_member_id IS NOT NULL AND cm.user_id IS NOT NULL;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT cm.user_id) INTO v_user_ids
    FROM old_rows r
    JOIN public.crew_members cm ON cm.id = r.assigned_crew_member_id
    WHERE r.assigned_crew_member_id IS NOT NULL AND cm.user_id IS NOT NULL;
  ELSE  -- UPDATE: notify previous and new assignee (covers reassignment)
    SELECT array_agg(DISTINCT cm.user_id) INTO v_user_ids
    FROM (
      SELECT assigned_crew_member_id FROM new_rows
      UNION
      SELECT assigned_crew_member_id FROM old_rows
    ) r
    JOIN public.crew_members cm ON cm.id = r.assigned_crew_member_id
    WHERE r.assigned_crew_member_id IS NOT NULL AND cm.user_id IS NOT NULL;
  END IF;

  PERFORM public.notify_crew_sync(v_user_ids, 'work_orders');
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS crew_sync_work_orders_ins ON public.work_orders;
CREATE TRIGGER crew_sync_work_orders_ins
  AFTER INSERT ON public.work_orders
  REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_work_orders();

DROP TRIGGER IF EXISTS crew_sync_work_orders_upd ON public.work_orders;
CREATE TRIGGER crew_sync_work_orders_upd
  AFTER UPDATE ON public.work_orders
  REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_work_orders();

DROP TRIGGER IF EXISTS crew_sync_work_orders_del ON public.work_orders;
CREATE TRIGGER crew_sync_work_orders_del
  AFTER DELETE ON public.work_orders
  REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.crew_sync_on_work_orders();

-- ── Authorize crew clients to receive their own private-topic broadcasts ─
-- Private Realtime channels authorize against RLS on realtime.messages.
-- A crew user may join exactly one topic: crew:{their own auth.uid()}.
DROP POLICY IF EXISTS "crew_receive_own_sync_broadcasts" ON realtime.messages;
CREATE POLICY "crew_receive_own_sync_broadcasts"
  ON realtime.messages
  FOR SELECT
  TO authenticated
  USING (
    realtime.messages.extension = 'broadcast'
    AND realtime.topic() = 'crew:' || (SELECT auth.uid())::text
  );
```

### 2c. Applying it

1. Write the file into `supabase/migrations/` with a current-UTC timestamp
   name; run the guardrail suite (`npx vitest run unit/guardrails`) to
   confirm migration-hygiene passes (no version collision; this file
   creates no tables so the RLS-in-same-file rule doesn't bite).
2. Apply to production (`vpmznjktllhmmbfnxuvk`) via Supabase MCP
   `apply_migration`, name matching the filename (without `.sql`).
3. Apply the identical SQL to the e2e project (`syhthijeqlnltufdawyb`).
4. Run Supabase MCP `get_advisors` (security) on production afterward —
   the definer functions should NOT be flagged (search_path is pinned); if
   anything new appears, fix it before merging.

### 2d. Verification — REQUIRED before Phase 3 starts

**SQL-level (production):**

```sql
-- 1. Find a turnover with an assignment whose crew member has a user_id:
SELECT t.id AS turnover_id, cm.user_id
FROM turnovers t
JOIN turnover_assignments ta ON ta.turnover_id = t.id
JOIN crew_members cm ON cm.id = ta.crew_member_id
WHERE cm.user_id IS NOT NULL
LIMIT 1;

-- 2. Touch it (harmless: bumps updated_at, which the delta layer absorbs):
UPDATE turnovers SET updated_at = now() WHERE id = '<turnover_id>';

-- 3. Confirm the broadcast row landed:
SELECT topic, event, payload, extension, inserted_at
FROM realtime.messages
ORDER BY inserted_at DESC
LIMIT 5;
-- Expect: topic = 'crew:<user_id>', event = 'sync',
--         payload = {"entity": "turnovers"}, extension = 'broadcast'
```

Repeat the touch test for one `checklist_instance_items` row (expect
`entity = 'checklists'`) and one assigned `work_orders` row (expect
`entity = 'work_orders'`). Also verify the failure-isolation property:
the `UPDATE` statements themselves must succeed regardless of broadcast
outcome. Note `realtime.messages` is partitioned with short retention —
query soon after the touch.

**Scratch-client (run against the e2e project, not prod):** a throwaway
Node script using `@supabase/supabase-js`:

1. Sign in as a seeded crew user (e2e project credentials).
2. `await supabase.realtime.setAuth()` then
   `supabase.channel('crew:' + user.id, { config: { private: true } })`
   `.on('broadcast', { event: 'sync' }, cb).subscribe()` — must reach
   `SUBSCRIBED`.
3. Touch an assigned turnover row via SQL → `cb` must fire with
   `{ entity: 'turnovers' }` within a couple of seconds.
4. Negative test: subscribe to `crew:<some-other-uuid>` — must FAIL to
   subscribe (`CHANNEL_ERROR` / unauthorized). This proves the RLS policy
   actually scopes topics per-user. **Do not skip this test.**

**Definition of done (Phase 2):** migration file merged; applied to both
projects; all three SQL touch tests produce correct `realtime.messages`
rows; scratch client receives own-topic broadcast and is rejected from a
foreign topic; advisors clean; full local verification pass green.

---

## 3. Phase 3 — Client cutover (behind a flag, ships dormant)

**Goal:** the crew PWA subscribes to its single private broadcast topic and
converts signals into debounced delta pulls — gated behind
`NEXT_PUBLIC_CREW_SYNC_V2` so it ships dormant and the old path remains the
default until Phase 5 flips the flag.

**Precondition:** Phase 2 verified (section 2d), and Phase 1 has soaked in
production for at least a few real field-days with no sync regressions
(check Sentry for `[DexieProvider]`/sync errors and any crew bug reports
via `crew_feedback`).

### 3a. Files touched

- `lib/dexie/context.tsx` — the only substantial change site.
- `.env.example` (if present) — document `NEXT_PUBLIC_CREW_SYNC_V2`.
- `unit/dexie/` — tests for the debouncer and signal→action mapping
  (extract both as pure functions so they're testable without a DOM).

### 3b. Behavior spec

All inside `DexieProvider`, keyed off
`process.env.NEXT_PUBLIC_CREW_SYNC_V2 === 'true'`:

**Flag OFF (default):** current behavior, untouched — three
`postgres_changes` channels + generation-token refresh machinery. Do not
refactor it "while you're in there"; it gets deleted wholesale in Phase 5.

**Flag ON:**

1. **No `postgres_changes` channels at all.** One channel:

   ```typescript
   await supabase.realtime.setAuth()   // required before joining private channels
   const channel = supabase
     .channel(`crew:${userId}`, { config: { private: true } })
     .on('broadcast', { event: 'sync' }, ({ payload }) => {
       handleSyncSignal(payload?.entity)
     })
     .subscribe(handleChannelStatus)
   ```

   Re-run `setAuth()` on Supabase auth `TOKEN_REFRESHED` events (there is
   already an `onAuthStateChange` listener in the provider — extend it).
   Check the installed `@supabase/supabase-js` version's private-channel
   semantics; newer versions refresh realtime auth automatically, but the
   explicit call is harmless and version-proof.

2. **Signal → action map with a 1 s trailing debounce per entity.**
   `handleSyncSignal(entity)` validates entity is one of
   `'turnovers' | 'checklists' | 'work_orders'` (ignore anything else) and
   schedules the matching refresh through a per-entity debouncer: burst of
   N broadcasts inside 1 s → one pull. Actions:
   - `turnovers` → the full turnover-scope sync from
     `lib/dexie/sync/turnovers.ts` (assignment reconciliation + turnover
     delta + checklists for fresh turnovers). This is a full-scope pull, so
     cursor advancement is allowed.
   - `checklists` → checklist pull across the full current assigned-
     turnover id set with `advanceCursors: true` (full scope). Never a
     partial-scope pull with cursor advancement.
   - `work_orders` → the WO reconciliation+delta sync from
     `lib/dexie/sync/work-orders.ts`.
   Serialize refreshes per entity (if a pull is in flight when the debounce
   fires again, queue exactly one follow-up run — don't stack).

3. **Safety poll:** every 5 minutes, run the full `resync()` (all entities
   + reconciliation). This is the correctness backstop for missed
   broadcasts AND the freshness path for `property_assets` (which has no
   trigger — see section 1). Also run a full `resync()`:
   - on mount (already exists),
   - on `online` (already exists),
   - on `visibilitychange` → visible (add it — PWA returning from
     background has likely missed broadcasts).

4. **Reconnect with jitter:** on channel status `CHANNEL_ERROR`,
   `TIMED_OUT`, or `CLOSED` (when not deliberately unmounting), tear down
   and resubscribe after `base + jitter` where jitter is uniform in
   ±30 s (e.g. base 5 s, so 5–35 s spread) — prevents a thundering herd of
   rejoins when a Realtime node restarts. `Math.random()` here needs the
   eslint-disable + justification line. After every successful
   (re)subscribe, run one full `resync()` — the gap while disconnected may
   have swallowed signals.

5. **Keep** the outbox `online` flush and everything in
   `lib/dexie/syncService.ts` untouched (Phase 4's concern).

6. **Do not delete** the generation-token machinery or the old channels in
   this phase — the flag must be able to toggle back. Deletion is
   Phase 5.

### 3c. Tests

Extract and unit-test as pure/injectable pieces (fake timers):
- the per-entity debouncer (burst coalescing; serialized in-flight +
  queued-follow-up behavior),
- the entity→action mapping (unknown entity ignored, each known entity
  invokes the right sync fn),
- reconnect jitter bounds (delay always within [base−0, base+30 s] window
  chosen).

**Definition of done (Phase 3):** merged with flag defaulting off; full
verification pass green; a manual smoke with the flag on locally
(`NEXT_PUBLIC_CREW_SYNC_V2=true npm run dev` against the e2e project)
showing subscribe + signal → pull in the network tab; old path verified
untouched with flag off.

---

## 4. Phase 4 — Outbox retry backoff

**Goal:** failed outbox mutations retry on exponential backoff with jitter
instead of hammering on every drain. Independent of Phases 2–3; can be its
own small PR.

### 4a. Spec

- `lib/dexie/schema.ts`: bump to `this.version(8)` (current max is 7 —
  re-check at implementation time). Add `nextAttemptAt?: number`
  (epoch ms) to `MutationRow`. Keep the existing store index string
  unchanged unless an index is genuinely needed (it isn't — the drain
  scans in insertion order anyway). Follow the existing pattern of
  repeating the full `stores({...})` map in the new version block.
- `lib/dexie/syncService.ts` `processOutbox()`:
  - Before pushing a mutation: if `mutation.nextAttemptAt` is set and
    `> Date.now()`, **stop the drain entirely** (do not skip-and-continue —
    later mutations against the same record must never jump ahead; the
    existing stop-on-first-error semantics already encode this, backoff
    just adds "not due yet" as a stop reason).
  - On push failure:
    `retryCount += 1`, and
    `nextAttemptAt = Date.now() + Math.min(2 ** retryCount * 5_000, 300_000) * (0.5 + jitter)`
    where `jitter` is uniform in [0, 1) (`Math.random()` with the
    eslint-disable justification — spreads retry storms after an outage).
    So delays grow 5 s → 10 s → 20 s … capped at 5 min, each scaled by
    0.5–1.5×.
  - Preserve the existing `failed: true` permanent-failure classification
    exactly as-is.
  - When the drain stops on a not-yet-due mutation, schedule a one-shot
    `setTimeout` to re-run `processOutbox()` at `nextAttemptAt` (clear any
    previously scheduled one first — keep a single timer handle on the
    SyncEngine instance). The existing `online` listener and
    `enqueueMutation()` fire-and-forget drains remain additional entry
    points.

### 4b. Tests

In `unit/dexie/` with the existing fake + fake timers: backoff delay math
(growth, cap, jitter bounds), drain stops at a not-yet-due head mutation
and touches nothing behind it, due mutation retries and clears
`nextAttemptAt` on success, permanent-failure path unchanged.

**Definition of done (Phase 4):** merged; verification pass green; unit
tests cover the four behaviors above.

---

## 5. Phase 5 — Rollout, acceptance, deletion, convention

**Preconditions:** Phases 2–4 merged; Phase 3 deployed dark to production.

### 5a. Owner (human) tasks — surface these, don't do them

- Supabase dashboard → Realtime settings: confirm the concurrent-clients
  quota comfortably covers the crew fleet (~1,500 was the discussed
  target).
- Set `NEXT_PUBLIC_CREW_SYNC_V2=true` in Vercel — **Preview environment
  first**, production only after the acceptance test passes.

### 5b. Two-device acceptance test (run on Preview with the flag on)

With one PM session and one crew device (or two crew devices where noted):

1. PM assigns a turnover to the crew member → appears on the crew device
   within ~2 s without a manual refresh.
2. PM unassigns it → disappears from the crew device (broadcast → full
   scope pull → reconciliation removes it).
3. Crew device A completes a checklist item → crew device B (same
   turnover) shows it within ~2 s.
4. PM assigns a work order → appears; PM reassigns it to another crew
   member → vanishes from the first device, appears on the second.
5. Put the crew device offline (airplane mode), make PM-side changes,
   reconnect → device catches up via the reconnect resync (within
   seconds, not the 5-min poll).
6. Leave a device idle 10+ minutes → confirm the safety poll fires (network
   tab) and nothing accumulates errors in the console/Sentry.

### 5c. Production flip and soak

Flip the flag in production. Watch for one week: Sentry (crew PWA errors,
channel-subscribe failures), Supabase Realtime dashboard (concurrent
connections, message counts), `crew_feedback` table, and DB CPU (trigger
overhead should be negligible; confirm).

### 5d. Old-code deletion (only after a green soak week)

In one PR: remove the flag conditionals (v2 becomes the only path), delete
the three `postgres_changes` channel setups, delete
`refreshChecklistSubscription` / `refreshAssetsSubscription` and the entire
generation-token machinery from `lib/dexie/context.tsx`, delete any tests
that exist solely to cover the deleted machinery, and remove the env var
from Vercel/docs. Keep the safety poll and reconnect-resync forever — they
are load-bearing correctness backstops, not scaffolding.

### 5e. Convention + guardrail (the CLAUDE.md meta-rule applies)

Add to `CLAUDE.md` (Dexie/crew section): **"Every table the crew PWA caches
in Dexie must be covered by exactly one of: (a) a broadcast trigger in the
crew-sync trigger migration, or (b) the safety-poll pull list — and new
cached tables must be added to one of them in the same PR."**

Per the repo's meta-rule, ship the guardrail with it: a new
`unit/guardrails/crew-sync-coverage.test.ts` that derives the list of
synced Supabase-backed tables from `lib/dexie/schema.ts` (maintain an
explicit exported const if parsing is brittle — e.g.
`CREW_SYNCED_TABLES`), and asserts each appears either in the trigger
migration SQL (grep the `supabase/migrations/*crew_sync_broadcast*` file
for `ON public.<table>`) or in an explicit `SAFETY_POLL_ONLY` allowlist
(initially: `property_assets`, plus purely-local tables like `mutations` /
`sync_meta` in a `LOCAL_ONLY` list). A new cached table then fails CI until
the developer consciously places it.

**Definition of done (Phase 5 / the whole program):** flag removed, old
path deleted, acceptance test recorded as passed, soak week clean,
CLAUDE.md + guardrail merged.

---

## Appendix A — Enforcement Tier 3 (separate work, unscheduled)

Not part of crew sync; listed so it isn't lost. DB-level invariant checks
in CI, run against the **e2e project** (never hold prod credentials in CI):

1. Every `public` table has `rowsecurity = true` and at least one policy
   (`pg_tables` / `pg_policies`).
2. Every FK column has a covering index.
3. No unexpected `anon`/`authenticated` grants (diff against a committed
   allowlist).
4. `types/database.ts` drift check: generate types from the e2e project
   (Supabase MCP `generate_typescript_types` or CLI) and diff the table/
   column shape against the committed file.

Each check is a script under `scripts/` wired into `.github/workflows/ci.yml`,
self-disarming when the e2e secrets are absent (same pattern the e2e job
already uses).

## Appendix B — Quick reference

- Verification pass: `npx tsc --noEmit && npm run lint && npx vitest run && npm run check:ui-classes`
- Prod Supabase: `vpmznjktllhmmbfnxuvk` · E2E: `syhthijeqlnltufdawyb` — never any other project.
- Migrations: apply via Supabase MCP `apply_migration` to BOTH projects + commit the file, same PR.
- Broadcast topic: `crew:{auth user id}` · event: `sync` · payload: `{ entity }` only.
- Entities: `turnovers` | `checklists` | `work_orders`.
- Cursor rules: forward-only, full-scope pulls only, fresh ids pulled cursorless, deletion via reconciliation only.
- Flag: `NEXT_PUBLIC_CREW_SYNC_V2` (default off until Phase 5).
