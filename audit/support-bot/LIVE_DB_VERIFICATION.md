# Live DB Verification (Supabase MCP, project vpmznjktllhmmbfnxuvk)
Queried directly against the live database on 2026-06-30 to supplement migration-file analysis.

**Update 2026-07-23: FIXED.** The backfill migration recommended below
(`supabase/migrations/20260630044706_support_bot_phase3_human_inbox.sql`) has since
been written and committed, closing the schema-drift gap this file documents. The
realtime publication gap noted below has also been fixed via
`supabase/migrations/20260630100300_support_realtime_publication.sql`.

## RLS policies on support_conversations / support_messages / platform_staff

```
platform_staff | platform_staff_restrict_write | ALL    | qual=false, with_check=false   -> deny-all write, CONFIRMED LIVE
platform_staff | platform_staff_self_select    | SELECT | user_id = auth.uid()

support_conversations | org members access own conversations | ALL    | user_id=auth.uid() AND org_id IN (caller's orgs)
support_conversations | support_conversations_staff_select    | SELECT | is_platform_staff()
support_conversations | support_conversations_staff_update    | UPDATE | is_platform_staff() (USING and WITH CHECK both set)

support_messages | org members access own conversation messages | ALL    | scoped via parent conversation's user_id+org_id
support_messages | support_messages_staff_select                | SELECT | is_platform_staff()
support_messages | support_messages_staff_insert                | INSERT | with_check=is_platform_staff() (qual null, expected for INSERT)
```

CONFIRMED CLEAN: staff SELECT/UPDATE/INSERT policies on support_conversations/support_messages
are exactly as scoped as intended (gated solely on is_platform_staff()), and match what the
migration files describe — no later migration broadened these. platform_staff write path is
denied (`false`/`false`) at the live-DB level, not just in migration source.

## is_platform_staff() usage — full scope check across ALL policies in the live DB

```sql
select tablename, policyname, cmd from pg_policies
where qual ilike '%is_platform_staff%' or with_check ilike '%is_platform_staff%';
```
Result: exactly 4 rows, all support_conversations/support_messages SELECT/UPDATE/INSERT policies
listed above. CONFIRMED CLEAN — no scope creep. is_platform_staff() is not referenced by any
other table's RLS policy in the live database.

## support_kb_chunks RLS

```
support_kb_chunks | authenticated users read kb chunks | SELECT | qual=true
```
Only one policy exists: SELECT, true (any authenticated user can read). CONFIRMED CLEAN — no
INSERT/UPDATE/DELETE policy exists for any role on support_kb_chunks in the live DB, meaning no
RLS-permitted client write path exists regardless of what API routes do/don't expose. This
corroborates Agent 2's code-level check that no API route inserts into this table.

Note: write access (INSERT/UPDATE/DELETE) to support_kb_chunks would only be possible via the
service role key (RLS-bypassing), used in seed scripts per CLAUDE.md conventions — this is
expected/intentional and was not separately re-verified here since it's out of scope (seed
script isn't in the audited file list).

## Resolution of Agent 1 & Agent 3's top finding (schema drift / unverifiable RLS)

Both Agent 1 (Tenant Isolation) and Agent 3 (Staff Access) independently flagged as their
top finding that `platform_staff`, `is_platform_staff()`, and the staff RLS policies on
`support_conversations`/`support_messages` are not defined in any committed migration file
(confirmed: `grep -rli "platform_staff" supabase/migrations/ scripts/` returns zero results),
and that they could not verify live DB state to confirm the policies are correctly scoped.

**This is now RESOLVED via live Supabase MCP queries (see above sections of this file):**

- The `is_platform_staff()` function IS correctly defined live: `SECURITY DEFINER`, `STABLE`,
  body is exactly `SELECT EXISTS (SELECT 1 FROM platform_staff WHERE user_id = auth.uid())`.
  No broader logic, no role bypass, no hardcoded escape hatch.
- It is referenced in EXACTLY 4 policies live (support_conversations SELECT/UPDATE,
  support_messages SELECT/INSERT) — no scope creep, confirmed by direct query of
  `pg_policies` for any qual/with_check containing `is_platform_staff`.
- `platform_staff` table has a live deny-all write policy (`qual=false, with_check=false`)
  plus a self-select policy — matches intended design, not client-writable.
- So: **the underlying security posture is CLEAN** — both agents' suspected-critical
  findings do not represent an actual live vulnerability.

**However, the schema-drift finding itself stands and should be promoted, not retracted:**
this entire authorization layer (`platform_staff` table, `is_platform_staff()` function, the
4 RLS policies, the `'human'` message role, and columns like `needs_human`, `escalation_reason`,
`escalated_at`, `assigned_staff_id`) was applied to the live database outside the migrations
directory — violating the CLAUDE.md rule that all schema changes go through committed
`supabase/migrations/*.sql` files. This means:
1. `supabase/schema_reference.sql` (if regenerated) would show these objects, but the repo's
   migration history doesn't explain how they got there or who/what created them.
2. Anyone auditing from source only (as both subagents correctly did, per their scope — they
   had no live DB tool access) will always misdiagnose this as a potential critical
   vulnerability, costing audit time and creating false-positive alarm.
3. There is no record of the exact DDL that was run — if it needs to be reproduced (e.g. new
   environment, branch, disaster recovery), it must be reverse-engineered from `pg_policies`/
   `pg_proc` rather than replayed from a migration file.

**Recommended fix (Medium-High priority, process/auditability — not a live vulnerability):**
Write a new migration file (e.g. `supabase/migrations/<timestamp>_support_staff_backfill.sql`)
that reproduces the live `platform_staff` table, `is_platform_staff()` function, the 4 RLS
policies, and the `support_message_role` enum addition for `'human'`, using `CREATE TABLE IF
NOT EXISTS` / `CREATE OR REPLACE FUNCTION` / `DROP POLICY IF EXISTS` + `CREATE POLICY` so it's
idempotent against the already-applied live state, bringing source and live DB back in sync.

**Status: FIXED.** `supabase/migrations/20260630044706_support_bot_phase3_human_inbox.sql`
is exactly this backfill migration.

## Realtime publication check (Agent 3 Item 6)

```sql
select schemaname, tablename from pg_publication_tables
where pubname='supabase_realtime' and tablename in ('support_conversations','support_messages');
```
Result: **empty** — neither table is in the `supabase_realtime` publication.

This means the `postgres_changes` subscriptions in `support-inbox-client.tsx` (lines ~43-61,
77-85 per Agent 3/1's read) will never receive any events — Supabase silently drops realtime
delivery for tables not in the publication, regardless of RLS. This is NOT a cross-org leak
vector (good news, resolves the High-severity concern downward), but IS a functional bug: the
support inbox's "realtime" updates are inert, and staff must be relying on polling/refresh or
the feature appears live but isn't. Recommended fix: add both tables to the publication
(`ALTER PUBLICATION supabase_realtime ADD TABLE support_conversations, support_messages;`,
via a migration) if realtime updates are actually desired, and re-verify RLS scoping for
postgres_changes specifically once enabled (Supabase realtime does respect RLS for
postgres_changes events when the table is in the publication, scoped per-connection by the
authenticated role).

**Status: FIXED.** `supabase/migrations/20260630100300_support_realtime_publication.sql`
adds both tables to the `supabase_realtime` publication (a later duplicate,
`20260707145519_support_realtime_publication.sql`, is a cosmetic dup self-annotated
as already applied — not a security issue).
