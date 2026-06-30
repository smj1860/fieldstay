Status: IN PROGRESS
Last checkpoint: Read the only support migration (20260620233632_support_bot_scaffold.sql), page.tsx, reply/route.ts, resolve/route.ts. CRITICAL gap found: schema migration does not match application code.
Next: Search all migrations for is_platform_staff/platform_staff references (none found yet — see finding #1), check support-inbox-client.tsx realtime config, check classify.ts/respond.ts for escalation logic, write summary.

---

## FINDING 1 — CRITICAL — `platform_staff` table does not exist in any migration (CONFIRMED)

**Files:** `app/(dashboard)/support-inbox/page.tsx:11-17`, `app/api/support-inbox/reply/route.ts:10-16`, `app/api/support-inbox/resolve/route.ts:10-16`

**Status:** Confirmed via `grep -rln "is_platform_staff\|platform_staff" supabase/migrations/` — zero matches anywhere in `supabase/migrations/`. The only support-related migration, `20260620233632_support_bot_scaffold.sql`, creates `support_kb_chunks`, `support_conversations`, `support_messages` and their RLS policies, but never creates a `platform_staff` table, never creates an `is_platform_staff()` function, and the `organization_members`-based RLS policies on `support_conversations`/`support_messages` make no exception for staff at all.

**Impact:** As shipped (i.e., as represented by the migration history), there is no DB-level concept of platform staff. This means:
- The staff gate in `page.tsx`, `reply/route.ts`, and `resolve/route.ts` queries a table (`platform_staff`) that either (a) does not exist, in which case every request 500s / the `.from('platform_staff')` query errors and `staff` resolves to `null` → effectively a hard deny-all (fails closed, not a vuln, but the feature is non-functional) — or (b) was created out-of-band directly against the live DB (e.g. via Supabase Studio or an MCP `apply_migration` call that was never committed to `supabase/migrations/`), which means the table's actual RLS/grants are **completely unverifiable from this repo** and may not match the deny-all policy the design calls for.
- Even if `platform_staff` exists live, the RLS policies on `support_conversations` (line 68-77) and `support_messages` (line 80-95) in the committed migration only grant access where `user_id = auth.uid()`. There is **no staff-exception clause** (`OR is_platform_staff()`) in the committed SQL. If the live DB's RLS truly matches this file, then even a legitimate platform_staff member querying `support_conversations` directly (not through the service-role-bypassing route handlers) would be denied by RLS — meaning the inbox page's `await supabase.from('support_conversations').select(...)` on page.tsx:19-28 uses the **user-scoped client** (`createClient()` from `@/lib/supabase/server`, RLS-enforced), not a service-role client, and per the current RLS policy a staff member is NOT the `user_id` who owns those conversations, so this query would return **zero rows** for staff in production — not a security hole, but a confirmed functional/RLS mismatch.

**Recommended fix:**
1. Locate and commit the migration that actually created `platform_staff`, `is_platform_staff()`, the `needs_human`/`escalation_reason`/`escalated_at`/`assigned_staff_id` columns on `support_conversations`, and `sent_by_user_id` column + `'human'` enum value on `support_messages` — this audit cannot verify their RLS posture because the SQL is not in the repo.
2. If no such migration exists and these were applied ad hoc to the live DB, that is itself a process violation of CLAUDE.md ("Write a new file in supabase/migrations/ ... and apply it via Supabase CLI or MCP apply_migration") and creates exactly the schema-drift risk the schema_reference.sql regeneration step exists to catch.
3. Regenerate `supabase/schema_reference.sql` via `bash scripts/generate-schema-reference.sh` and diff against committed migrations to confirm what's actually live.

---

## FINDING 2 — CRITICAL — `support_message_role` enum lacks `'human'` value (CONFIRMED, blocks Finding 1's fix)

**File:** `supabase/migrations/20260620233632_support_bot_scaffold.sql:11-15` vs `app/api/support-inbox/reply/route.ts:29`

The enum is defined as:
```sql
CREATE TYPE support_message_role AS ENUM ('user', 'assistant');
```
but `reply/route.ts:29` inserts `role: 'human'`. Per committed migrations, this insert would fail with an invalid-enum-value error. This reinforces Finding 1: the human-staff-reply feature's actual schema lives in an uncommitted/unaudited migration.

**Recommended fix:** Same as Finding 1 — find and commit the real migration; confirm `'human'` was added via `ALTER TYPE support_message_role ADD VALUE`.

