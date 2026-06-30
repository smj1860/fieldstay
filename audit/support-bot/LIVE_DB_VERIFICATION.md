# Live DB Verification (Supabase MCP, project vpmznjktllhmmbfnxuvk)
Queried directly against the live database on 2026-06-30 to supplement migration-file analysis.

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
