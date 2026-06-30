Status: IN PROGRESS
Last checkpoint: Read lib/support/account-tools.ts, app/api/support/chat/route.ts,
lib/support/respond.ts. Items 1-3 of the brief (account-tools scoping, orgId trace,
prompt-injection structural test) verified CLEAN — details below.
Next: Check app/api/support-inbox/{reply,resolve}/route.ts for platform_staff
server-side checks; search ALL migrations touching support_conversations/support_messages
for RLS policy drift; check support-inbox-client.tsx + page.tsx; check support-chat-widget.tsx
for any client-supplied org_id; check classify.ts/retrieve.ts/embed.ts briefly.

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
