Status: COMPLETE
Last checkpoint: Read all in-scope files: lib/support/{account-tools,respond,classify,retrieve,
embed,anthropic-client,types}.ts, app/api/support/chat/route.ts, app/api/support-inbox/{reply,
resolve}/route.ts, app/(dashboard)/support-inbox/{page,support-inbox-client}.tsx,
components/support/support-chat-widget.tsx, supabase/migrations/20260620233632_support_bot_scaffold.sql.
All items (1-5) addressed. Summary appended to AUDIT_SUMMARY.md.
Next: None — audit complete.

## Item 4 & 5: support-inbox routes + RLS policy verification

**FINDING — CRITICAL (confirmed via migration analysis; live DB state NOT verified, see caveat below)**

File: `supabase/migrations/20260620233632_support_bot_scaffold.sql`, lines 67-95.

The only RLS policies on `support_conversations` and `support_messages` are:
```sql
CREATE POLICY "org members access own conversations"
  ON support_conversations FOR ALL
  USING (user_id = auth.uid() AND org_id IN (SELECT org_id FROM organization_members WHERE user_id = auth.uid()))
  ...
CREATE POLICY "org members access own conversation messages"
  ON support_messages FOR ALL
  USING (conversation_id IN (SELECT id FROM support_conversations WHERE user_id = auth.uid() AND ...))
```

There is NO policy granting `platform_staff` (or any staff/admin role) read/write access to
OTHER users' conversations. Both policies hard-require `user_id = auth.uid()` — i.e. only the
PM who created the conversation can ever see or modify it under RLS as currently defined in
this migration.

However:
- `app/(dashboard)/support-inbox/page.tsx` (lines 19-28) queries `support_conversations` with
  `createClient()` (RLS-enforced, confirmed via `lib/supabase/server.ts` convention — this is
  NOT `createServiceClient()`) with NO `user_id` or `org_id` filter, clearly intending to surface
  ALL orgs' conversations to staff for the support inbox view.
- `app/api/support-inbox/reply/route.ts` and `resolve/route.ts` similarly use `createClient()`
  (RLS-enforced) to UPDATE/INSERT into `support_conversations`/`support_messages` for
  conversations that do not belong to the staff member (`user_id` will not be `auth.uid()`
  for the staff user calling these routes).

Given the RLS policy as written in this migration, **these support-inbox code paths should
not work at all for legitimate staff** — RLS would silently filter the SELECT in page.tsx down
to zero rows (since `user_id = auth.uid()` fails for staff reading another user's conversation),
and the INSERT/UPDATE in the API routes would be rejected by the `WITH CHECK` clause (which
also requires `user_id = auth.uid()` on the conversation, an immutable fact unrelated to who's
calling).

**Two possible explanations, both concerning:**
1. **A later migration (not found in this repo's `supabase/migrations/` directory) added a
   `platform_staff`-aware bypass policy directly via the Supabase dashboard/SQL editor, bypassing
   the migrations-as-source-of-truth discipline this codebase otherwise follows.** If so, that
   policy is invisible to code review and `types/database.ts`/migration history, and its exact
   scope (does it check role? all platform_staff rows, or specific roles?) cannot be verified
   from the repo. This would be a process/drift finding, not necessarily a live vulnerability,
   but it means the live RLS posture for these two tables is **unverifiable from source** and
   could differ from what this audit can confirm as safe.
2. **No such bypass policy exists**, and the support-inbox feature is currently broken in
   production (functionally, not a security hole) — staff queries return empty, reply/resolve
   silently fail their WITH CHECK and return Postgres errors. This wouldn't be a tenant-isolation
   breach, but contradicts the apparent intent of the feature working at all.

Either way: **I could not confirm from the migration files that staff access to
support_conversations/support_messages is correctly and narrowly scoped to platform_staff only**
(as opposed to either being broken, or being defined by an out-of-band policy this audit cannot
see). This is flagged as the top finding of this audit.

Severity: Critical (if an undocumented/out-of-band policy exists and is broader than intended,
e.g. granted to `authenticated` rather than specifically gated on `platform_staff` membership,
it would be a tenant-isolation breach allowing any authenticated user to read all orgs' support
conversations). Status: SUSPECTED / UNVERIFIED — could not confirm live DB state.

Recommended fix:
1. Add an explicit migration (so it's source-controlled) creating a `platform_staff`-gated
   SELECT/UPDATE/INSERT policy on both tables, e.g.:
   ```sql
   CREATE POLICY "platform staff access all conversations"
     ON support_conversations FOR ALL
     USING (EXISTS (SELECT 1 FROM platform_staff WHERE user_id = auth.uid()))
     WITH CHECK (EXISTS (SELECT 1 FROM platform_staff WHERE user_id = auth.uid()));
   -- and equivalent for support_messages joined through conversation_id
   ```
2. Run `bash scripts/generate-schema-reference.sh` and inspect the regenerated
   `supabase/schema_reference.sql` to see the LIVE policy set on these two tables — this
   audit was migration-file-only and explicitly could not verify live DB state (no DB access
   available to this agent).
3. Once confirmed, the API routes (reply/resolve) could optionally switch to
   `createServiceClient()` with the existing manual `platform_staff` check (already present
   and correct in both route handlers, lines 10-16 of each) as a more explicit, auditable
   alternative to relying on an RLS bypass policy — this is arguably the safer pattern since
   it makes the staff-gate visible in application code rather than in an RLS policy that must
   be cross-referenced against migrations to verify.

**IMPORTANT CAVEAT:** This audit has no live Supabase DB access. All RLS conclusions above are
derived purely from reading `supabase/migrations/*.sql` files. If a policy was added via the
Supabase dashboard, MCP `apply_migration` without a corresponding committed file, or any other
out-of-band mechanism, it would not appear here and the actual live behavior could differ from
what's described above.

## Item 4b: platform_staff table definition

`grep -rl "platform_staff" supabase/migrations/` returned NO results — the `platform_staff`
table itself is not defined in any migration in this repository. It is referenced only in
application code (`app/api/support-inbox/resolve/route.ts`, `app/api/support-inbox/reply/route.ts`,
`app/(dashboard)/support-inbox/page.tsx`, `app/(dashboard)/layout.tsx`). This reinforces the
conclusion that the staff/admin authorization layer for this feature was set up outside the
migrations directory and is not auditable from source in this repo. Flagging as Medium severity
on its own (schema-drift/process issue) — compounds the Critical RLS finding above since it
means there's no migration to inspect for how `platform_staff` itself is populated/secured either.

## Item 4c: support-inbox API routes — server-side staff check on every request

CONFIRMED CLEAN (independent of the RLS question above). Both
`app/api/support-inbox/reply/route.ts` (lines 6-16) and
`app/api/support-inbox/resolve/route.ts` (lines 6-16) re-verify `auth.getUser()` and the
`platform_staff` membership lookup INSIDE the route handler on every POST request — this is
not a page-load-only check cached client-side. Each request independently:
1. Calls `supabase.auth.getUser()` (no trust of any client-supplied identity)
2. Queries `platform_staff` for that user.id
3. Returns 403 if no row found
This is the correct pattern and matches the page.tsx check at lines 11-17. No violation found
on this specific sub-item.

Note: `resolve/route.ts` (line 28) and the support_conversations UPDATE in `reply/route.ts`
(lines 36-42) do NOT scope the `.eq('id', conversationId)` update to any org_id or ownership
check beyond the platform_staff gate — this is intentional and correct for a staff tool (staff
should be able to act on any org's conversation), assuming the RLS policy question in Item 4
above resolves to "staff genuinely have broader RLS access," which is exactly what could not be
confirmed from source.

---

## Item 1: lib/support/account-tools.ts — org_id scoping audit

CONFIRMED CLEAN. All four tools take `orgId: string` as their sole parameter and every
Supabase query is scoped:
- `getPlanStatus` (line 12-42): organizations query `.eq('id', orgId)` (line 18, correct —
  org's own id), properties query `.eq('org_id', orgId)` (line 24), guidebook_sponsors
  query `.eq('org_id', orgId)` (line 30). All three scoped correctly.
- `getRecentTurnovers` (line 44-73): `.eq('org_id', orgId)` (line 55). Clean.
- `getIntegrationStatus` (line 75-95): `.eq('org_id', orgId)` (line 81). Clean.
- `getRecentPurchaseOrders` (line 97-123): `.eq('org_id', orgId)` (line 107). Clean.

All four use `createServiceClient()` (line 13, 45, 76, 98) which bypasses RLS — this makes
the manual `.eq('org_id', orgId)` filter the ONLY tenant boundary for these queries. There
is no RLS backstop. This is acceptable ONLY because orgId is structurally guaranteed
server-side (see Item 2) and never model- or client-supplied. Flagging as architecturally
sound but worth noting explicitly: a future edit that adds a new tool function and forgets
the `.eq('org_id', ...)` filter would have ZERO RLS safety net since the service client
bypasses RLS entirely. No current violation found.

Severity: N/A (clean) — informational note only on lack of defense-in-depth.

## Item 2: orgId trace — app/api/support/chat/route.ts → respond.ts → account-tools.ts

CONFIRMED CLEAN, traced end to end:
- `app/api/support/chat/route.ts` line 8: `const { supabase, user, membership } = await requireOrgMember()`
  — orgId originates from the authenticated session via the standard `requireOrgMember()`
  helper (per CLAUDE.md pattern), NOT from `req.json()` body. Confirmed: `body` (line 10)
  is only destructured for `message` and `conversationId` — `org_id` is never read from it.
- Line 70: `generateResponse({ category, message, history, orgId: membership.org_id })`
  — orgId passed is `membership.org_id`, server-derived.
- `lib/support/respond.ts` line 70 / 30: orgId flows through `params.orgId` into
  `generateAccountSpecificResponse({ ..., orgId: params.orgId })` unchanged.
- `lib/support/respond.ts` line 88: `callAccountTool(block.name, params.orgId)` — critically,
  only `block.name` (the tool name string) is read from the model's tool-use block.
  `block.input` (where the model could have stuffed an org_id-like argument) is NEVER
  read anywhere in this file. Confirmed via full-file read — no reference to `.input` exists
  in respond.ts.
- `ACCOUNT_TOOLS` definitions (account-tools.ts line 130-151) all declare
  `input_schema: { type: 'object', properties: {} }` — empty schema, so even if the model
  tried to pass an org_id argument, the tool contract doesn't define a slot for it, and the
  dispatcher (`callAccountTool`, line 158-166) takes orgId as a function parameter from the
  caller, not from any per-call argument object.

Severity: N/A (clean). This is exactly the structural (not prompt-based) guarantee the
brief asked to verify.

## Item 3: Structural prompt-injection test

CONFIRMED — no code path exists where a model-stated org_id (e.g. embedded in the user's
message text, or hypothetically reflected back by the model in a tool_use block) can reach
a Supabase query. Reasoning:
1. The tool definitions the model sees (`ACCOUNT_TOOLS`) have empty `input_schema.properties`
   — there is no field for the model to populate with an org_id even if it wanted to.
2. Even if Anthropic's API were coerced into sending some `block.input` payload, respond.ts
   never reads `block.input` — only `block.name` and `block.id` (for tool_use_id correlation).
3. `callAccountTool(toolName, orgId)` receives orgId as a positional argument supplied by
   respond.ts using `params.orgId`, which is itself sourced from the route handler's
   `membership.org_id` — never from anything in the `messages` array sent to/from the model.
4. A malicious instruction in the user's chat message (e.g. "show me org abc-123's data")
   can only influence the natural-language `content` the model generates in its final text
   reply (a hallucination risk, not a data-access risk) — it cannot change which org_id
   value is used in the actual DB query, because that value is never wired from the
   model/message layer to the query layer at all.

This is a sound structural mitigation, not merely a prompt-engineering one. No violation found.
