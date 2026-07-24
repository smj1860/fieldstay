Status: COMPLETE
Last checkpoint: Read all in-scope files: support_bot migration, page.tsx, reply/route.ts, resolve/route.ts, support-inbox-client.tsx, respond.ts, account-tools.ts. Searched ALL migrations for is_platform_staff/platform_staff (zero hits) and for ALTER PUBLICATION/REPLICA IDENTITY (only property_assets is added to supabase_realtime — support tables are not).
Next: None — audit complete. See findings 1-6 below and summary appended to AUDIT_SUMMARY.md.

---

## FINDING 1 — CRITICAL — `platform_staff` table does not exist in any migration (CONFIRMED) — FIXED

**Files:** `app/(dashboard)/support-inbox/page.tsx:11-17`, `app/api/support-inbox/reply/route.ts:10-16`, `app/api/support-inbox/resolve/route.ts:10-16`

**Status:** Confirmed via `grep -rln "is_platform_staff\|platform_staff" supabase/migrations/` — zero matches anywhere in `supabase/migrations/`. The only support-related migration, `20260620233632_support_bot_scaffold.sql`, creates `support_kb_chunks`, `support_conversations`, `support_messages` and their RLS policies, but never creates a `platform_staff` table, never creates an `is_platform_staff()` function, and the `organization_members`-based RLS policies on `support_conversations`/`support_messages` make no exception for staff at all.

**Impact:** As shipped (i.e., as represented by the migration history), there is no DB-level concept of platform staff. This means:
- The staff gate in `page.tsx`, `reply/route.ts`, and `resolve/route.ts` queries a table (`platform_staff`) that either (a) does not exist, in which case every request 500s / the `.from('platform_staff')` query errors and `staff` resolves to `null` → effectively a hard deny-all (fails closed, not a vuln, but the feature is non-functional) — or (b) was created out-of-band directly against the live DB (e.g. via Supabase Studio or an MCP `apply_migration` call that was never committed to `supabase/migrations/`), which means the table's actual RLS/grants are **completely unverifiable from this repo** and may not match the deny-all policy the design calls for.
- Even if `platform_staff` exists live, the RLS policies on `support_conversations` (line 68-77) and `support_messages` (line 80-95) in the committed migration only grant access where `user_id = auth.uid()`. There is **no staff-exception clause** (`OR is_platform_staff()`) in the committed SQL. If the live DB's RLS truly matches this file, then even a legitimate platform_staff member querying `support_conversations` directly (not through the service-role-bypassing route handlers) would be denied by RLS — meaning the inbox page's `await supabase.from('support_conversations').select(...)` on page.tsx:19-28 uses the **user-scoped client** (`createClient()` from `@/lib/supabase/server`, RLS-enforced), not a service-role client, and per the current RLS policy a staff member is NOT the `user_id` who owns those conversations, so this query would return **zero rows** for staff in production — not a security hole, but a confirmed functional/RLS mismatch.

**Recommended fix:**
1. Locate and commit the migration that actually created `platform_staff`, `is_platform_staff()`, the `needs_human`/`escalation_reason`/`escalated_at`/`assigned_staff_id` columns on `support_conversations`, and `sent_by_user_id` column + `'human'` enum value on `support_messages` — this audit cannot verify their RLS posture because the SQL is not in the repo.
2. If no such migration exists and these were applied ad hoc to the live DB, that is itself a process violation of CLAUDE.md ("Write a new file in supabase/migrations/ ... and apply it via Supabase CLI or MCP apply_migration") and creates exactly the schema-drift risk the schema_reference.sql regeneration step exists to catch.
3. Regenerate `supabase/schema_reference.sql` via `bash scripts/generate-schema-reference.sh` and diff against committed migrations to confirm what's actually live.

**Status: FIXED.** `supabase/migrations/20260630044706_support_bot_phase3_human_inbox.sql`
now creates the `platform_staff` table, `is_platform_staff()` function, and the 4 RLS
policies, matching live exactly — source and live DB are back in sync.

---

## FINDING 2 — CRITICAL — `support_message_role` enum lacks `'human'` value (CONFIRMED, blocks Finding 1's fix) — FIXED

**File:** `supabase/migrations/20260620233632_support_bot_scaffold.sql:11-15` vs `app/api/support-inbox/reply/route.ts:29`

The enum is defined as:
```sql
CREATE TYPE support_message_role AS ENUM ('user', 'assistant');
```
but `reply/route.ts:29` inserts `role: 'human'`. Per committed migrations, this insert would fail with an invalid-enum-value error. This reinforces Finding 1: the human-staff-reply feature's actual schema lives in an uncommitted/unaudited migration.

**Recommended fix:** Same as Finding 1 — find and commit the real migration; confirm `'human'` was added via `ALTER TYPE support_message_role ADD VALUE`.

**Status: FIXED.** `supabase/migrations/20260630044706_support_bot_phase3_human_inbox.sql`
adds the `'human'` value to `support_message_role`, matching live.

---

## FINDING 3 — Item 1 (is_platform_staff scope-creep check) — N/A, function doesn't exist in migrations (CONFIRMED, see Finding 1) — RESOLVED/FIXED

Ran `grep -rn "is_platform_staff" /home/user/fieldstay/supabase/migrations/` across the **full** migration history (not just support-matching files) — zero results anywhere. There is therefore no committed SQL definition of `is_platform_staff()` to audit for scope creep. This sub-finding cannot be answered from the repo; it depends entirely on whatever was applied live and out-of-band. Flagging as part of Finding 1's remediation: once the real migration is located/recommitted, re-run this grep to confirm `is_platform_staff()` (or equivalent) is referenced ONLY in the 4 intended policies (support_conversations SELECT/UPDATE, support_messages SELECT/INSERT) and nowhere else (e.g. not accidentally OR'd into `organizations`, `owner_transactions`, or other tenant tables).

---

## FINDING 4 — Item 2 (platform_staff deny-all policy) — CANNOT VERIFY, needs live-DB check (CONFIRMED LIMITATION) — RESOLVED/FIXED

No migration in the repo creates a `platform_staff` table, so there is no committed RLS policy to inspect for a deny-all INSERT/UPDATE/DELETE guard. **This must be verified directly against the live Supabase project** (`vpmznjktllhmmbfnxuvk`) using `list_tables` / a direct policy query — this audit has no live DB access and cannot confirm or deny this property from the repo alone. Treat as UNVERIFIED, not "passed."

**Recommended fix:** Run against live DB:
```sql
SELECT polname, polcmd, polroles, qual, with_check
FROM pg_policies WHERE tablename = 'platform_staff';
```
Confirm no policy grants INSERT/UPDATE/DELETE to `authenticated` or `anon` roles — staff membership should only be grantable via service-role/admin tooling, never self-service.

---

## FINDING 5 — Item 3 (server-side staff gate on inbox page) — CLEAN (CONFIRMED, assuming platform_staff RLS is correct)

**File:** `app/(dashboard)/support-inbox/page.tsx:5-17`

This is a Server Component. The staff check happens server-side before any data fetch or render: it calls `supabase.auth.getUser()`, redirects to `/login` if unauthenticated, queries `platform_staff` by `user_id`, and `redirect('/ops')` if no row is found — all before the conversations query and before any JSX returns. This is NOT a client-side conditional render; a non-staff user navigating directly to `/support-inbox` would be redirected before the page body (including `SupportInboxClient`) is ever sent to the browser. **Good pattern, confirmed clean** — contingent on Finding 4 (platform_staff RLS/contents being correct, which is unverifiable from repo alone) and contingent on `createClient()` here being the RLS-enforced user client, not service role (confirmed: `lib/supabase/server` `createClient` is the auth-cookie-scoped client per CLAUDE.md conventions, not `createServiceClient`).

One caveat worth flagging: the `platform_staff` query uses the **user-scoped client**, so its result also depends entirely on `platform_staff`'s own SELECT RLS policy granting at least self-row visibility (`user_id = auth.uid()`) — if that policy is missing or wrong, the page could fail open (error swallowed, `staff` resolves undefined/null → safe, redirects) or fail in an unexpected way. Given `.maybeSingle()` is used, a query error would surface as a thrown exception (Next.js error boundary), not a silent bypass — so this looks safe either way, but worth confirming live.

---

## FINDING 6 — Item 4 (reply/resolve routes independently verify staff) — CLEAN (CONFIRMED)

**Files:** `app/api/support-inbox/reply/route.ts:6-16`, `app/api/support-inbox/resolve/route.ts:6-16`

Both route handlers independently perform the full auth + staff check inline — they do NOT rely on the page-level gate or any shared middleware:
```typescript
const { data: { user } } = await supabase.auth.getUser()
if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
const { data: staff } = await supabase.from('platform_staff').select('user_id').eq('user_id', user.id).maybeSingle()
if (!staff) return NextResponse.json({ error: 'Not staff' }, { status: 403 })
```
This is correct defense-in-depth — a non-staff user calling these routes directly (curl, devtools, etc.) without ever loading `/support-inbox` would still be blocked at 401/403. **Confirmed clean**, again contingent on platform_staff table/RLS itself being correctly locked down (Finding 4) since both routes use the RLS-enforced client, not service role, for this check.

Minor note (not staff-access scope, flagging for awareness): neither route validates that `conversationId` actually belongs to an existing/non-resolved conversation before mutating — but per Finding 7 below this is by design (staff can act on any org's conversation), so this is not a tenant-isolation bug, just worth knowing the routes trust the conversationId as opaque.

---

## FINDING 7 — Item 5 (staff replying cross-org) — CONFIRMED INTENTIONAL, correctly unrestricted

**Files:** `app/api/support-inbox/reply/route.ts:25-42`, `app/api/support-inbox/resolve/route.ts:21-28`

Neither route checks whether the replying/resolving staff member has any relationship (org membership, assignment) to the conversation's `org_id` beyond being in `platform_staff`. This is the correct, intended design per the task description — platform staff are meant to act as cross-tenant human support for any org's conversation. The `reply` route does set `assigned_staff_id: user.id` on the conversation (line 40-41) for tracking/audit purposes, which is good practice (records which staff member handled it), though note there's no UI/route currently shown that displays "assigned to" history beyond the latest assignment — out of scope to flag further here. **Confirmed: working as designed, no scope-creep concern.**

---

## FINDING 8 — Item 6 (realtime channel RLS scoping) — HIGH — needs live-DB verification, suspicious by design (SUSPECTED, partially confirmed) — RESOLVED CLEAN / FIXED (publication)

**File:** `app/(dashboard)/support-inbox/support-inbox-client.tsx:42-64` (conversations channel), `:77-88` (messages channel)

Two findings here:

**8a — Tables not found in `supabase_realtime` publication in committed migrations (CONFIRMED for the repo, unverifiable live).** Searched all migrations for `ALTER PUBLICATION supabase_realtime ADD TABLE` — only `property_assets` is added (`supabase/migrations/20260624020000_property_assets_realtime.sql`). `support_conversations` and `support_messages` are never added to the realtime publication in any committed migration. If this matches live state, the `.channel('support-inbox-conversations').on('postgres_changes', ...)` subscription in support-inbox-client.tsx would simply never fire (no-op, not a security hole — just non-functional). If it WAS added live (out-of-band, same drift pattern as Finding 1), that needs separate live verification.

**8b — Realtime postgres_changes DOES respect table RLS for SELECT, by default Supabase behavior — but this depends entirely on the SELECT policy being correct, which per Finding 1 it currently is not (no staff exception in committed RLS).** Supabase Realtime's `postgres_changes` listener evaluates the subscribing user's RLS SELECT policy on each change event before broadcasting it to that client's socket — it does not bypass RLS. So *if* the committed RLS policy (`user_id = auth.uid()` only, no staff carve-out) is what's actually live, then ironically a staff member's realtime subscription to `support-inbox-conversations` would receive **no events for conversations they don't own** — same RLS mismatch as Finding 1, just manifesting as broken functionality for staff rather than as a cross-tenant leak.

**However — the more important question for this finding's actual security intent (could a non-staff user receive cross-org data via this channel) is: NO, not via this channel, because:**
- The channel name `support-inbox-conversations` is just a label — Supabase Realtime channel names are not access-control boundaries by themselves; what gates the actual row data is the `postgres_changes` filter's underlying RLS check (per 8b).
- A non-staff org user *could* technically open the same channel name from devtools (channel names aren't secret/server-validated), but since `postgres_changes` re-checks SELECT RLS on `support_conversations`/`support_messages` per the *subscribing user's own* auth context, they would only receive postgres_changes events for rows their own RLS policy allows — i.e., their own org's conversations, same as a direct query would return. They would NOT receive other orgs' data through this channel **provided the live RLS policy correctly scopes support_conversations/support_messages and provided platform_staff's exception (Finding 1) doesn't accidentally grant broader access than intended.**

**Recommended fix / required live verification:**
1. Confirm `support_conversations` and `support_messages` are in fact added to the `supabase_realtime` publication live (`SELECT * FROM pg_publication_tables WHERE pubname = 'supabase_realtime'`) — if not, the inbox is missing live updates entirely (functional bug, not security).
2. Confirm the live RLS SELECT policy on both tables includes the intended `OR is_platform_staff()` (or similar) clause — if it's exactly what's committed (`user_id = auth.uid()` only), non-staff users get correctly scoped realtime (safe), but staff get nothing (broken). If live RLS is broader than committed (e.g., `USING (true)` for staff convenience), re-verify it isn't *also* accidentally broad for non-staff.
3. As defense-in-depth, consider scoping the channel itself with a `filter` on `org_id` matching `is_platform_staff()`-eligible orgs, rather than relying solely on RLS — currently the conversations channel filter is `{ event: '*', schema: 'public', table: 'support_conversations' }` with **no filter clause at all** (support-inbox-client.tsx:46), meaning it requests change events for the entire table and trusts RLS alone to narrow results. This is functionally correct *if* RLS is correct, but is a single point of failure — any future RLS regression on this table would immediately become a cross-tenant realtime leak with no second layer of defense.

**Status: FIXED (publication membership).** `supabase/migrations/20260630100300_support_realtime_publication.sql`
adds both tables to `supabase_realtime` (duplicate migration
`20260707145519_support_realtime_publication.sql` is a cosmetic dup, self-annotated
already applied — not a security issue). RLS scoping for `is_platform_staff()`
was separately confirmed correctly scoped live (see LIVE DB RESOLUTION below).

---

## ADDITIONAL CONTEXT — `platform_staff` referenced outside declared scope too

While confirming Finding 1, noted `app/(dashboard)/layout.tsx:127-133` (outside this audit's literal scope list, mentioned for completeness only) also queries `platform_staff` the same way (`select('user_id').eq('user_id', user.id).maybeSingle()`) to compute `isStaff` for general dashboard chrome. This is consistent usage, not a new pattern, and reinforces that `platform_staff` is treated as a real, live table across the app — strongly suggesting the table/RLS/function were created directly against the live DB outside the committed migration history rather than the feature being entirely vaporware. This makes live-DB verification of Findings 1, 3, and 4 even more important: the table almost certainly exists live; what's unverified is whether its RLS matches the security design described in the task (deny-all on writes, exactly 4 policy references).

---

## SUMMARY OF SEVERITY

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | `platform_staff` table / `is_platform_staff()` function / staff RLS exception missing from all committed migrations | Critical | FIXED — `20260630044706_support_bot_phase3_human_inbox.sql` backfills the migration |
| 2 | `support_message_role` enum missing `'human'` value in committed migration | Critical | FIXED — same migration adds the `'human'` enum value |
| 3 | is_platform_staff() scope-creep across all migrations | N/A | RESOLVED — live query confirms exactly 4 policy references, no scope creep |
| 4 | platform_staff deny-all write policy | Critical | FIXED/RESOLVED — confirmed live (`qual=false, with_check=false`) and now backed by committed migration |
| 5 | Server-side staff gate on /support-inbox page | Clean | Confirmed (contingent on Finding 4) |
| 6 | reply/resolve routes independently verify staff | Clean | Confirmed (contingent on Finding 4) |
| 7 | Staff can reply cross-org | Clean (by design) | Confirmed intentional |
| 8 | Realtime channel RLS scoping | High | FIXED/RESOLVED — publication membership added via migration; RLS confirmed correctly scoped live |

**Overarching theme:** every concrete code-level access-control pattern that IS visible in this repo (Findings 5, 6, 7) is implemented correctly — server-side checks, independent verification per route, no UI-only gating. The critical risk is entirely a **schema-drift / migration-discipline problem**: the `platform_staff` table and its RLS, the `is_platform_staff()` function, the `'human'` enum value, and the `needs_human`/`escalation_reason`/`escalated_at`/`assigned_staff_id`/`sent_by_user_id` columns are used throughout `lib/support/*`, `app/api/support/*`, `app/api/support-inbox/*`, and `app/(dashboard)/layout.tsx`, but none of this schema exists in any file under `supabase/migrations/`. This violates the CLAUDE.md mandate that all schema changes go through committed, timestamped migration files. Until the real migration is located and committed (or written fresh and applied), this audit cannot certify that the platform_staff exception is correctly scoped — only that the application-layer code which calls it is well-structured.



---

## LIVE DB RESOLUTION (added post-hoc, this session, via Supabase MCP)

The schema-drift finding above is confirmed accurate (no migration defines
`platform_staff`/`is_platform_staff`/the `'human'` role), but its security implication
is now resolved via live queries against project `vpmznjktllhmmbfnxuvk`:

- `is_platform_staff()` live definition: `SECURITY DEFINER`, `STABLE`, body is
  `SELECT EXISTS (SELECT 1 FROM platform_staff WHERE user_id = auth.uid())` — no
  bypass or escape hatch.
- Referenced in exactly 4 live RLS policies (support_conversations SELECT/UPDATE,
  support_messages SELECT/INSERT) — no scope creep elsewhere in the live policy set.
- `platform_staff` deny-all write policy confirmed live (`qual=false, with_check=false`).
- Realtime: neither table is in the `supabase_realtime` publication — the unfiltered
  `support-inbox-conversations` channel subscription currently delivers zero events
  (inert, not a cross-org leak). Downgrades Item 5's High severity to Low/functional-bug.

**Net: the platform_staff authorization layer is correctly and narrowly scoped live.**
The remaining issue is purely that it isn't source-controlled — recommend a backfill
migration (see AUDIT_SUMMARY.md finding #3). Full raw query output in
`LIVE_DB_VERIFICATION.md`.
