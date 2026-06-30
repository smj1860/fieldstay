# Support Chat Agent Audit — Coordinating Summary

Scope: lib/support/*, app/api/support/chat/route.ts, app/api/support-inbox/*,
app/(dashboard)/support-inbox/*, components/support/support-chat-widget.tsx,
support_bot/support_staff migrations. 4 parallel subagents covered Tenant Isolation,
Prompt Injection/Output Safety, Staff Access/Human Inbox, and Abuse/Cost/Availability.
A 5th pass (this session, direct) used Supabase MCP to query the **live** database
(project `vpmznjktllhmmbfnxuvk`) to resolve items the subagents could only assess from
migration files. See `LIVE_DB_VERIFICATION.md` for raw query results.

---

## Critical / High Findings

### 1. [HIGH] No rate limiting on `/api/support/chat` — confirmed, single agent
**File:** `app/api/support/chat/route.ts`
The codebase has an established Upstash-Redis rate-limit pattern (`lib/rate-limit.ts`)
already used on comparable AI-cost endpoints (`scanLimiter` on data-plate OCR,
`repuguardLimiter` on RepuGuard generation), but the support chat route — which fires
a classification call, a response call (Haiku or Sonnet), and an OpenAI embedding call
per message — has none of it. Any authenticated user can hammer it directly (the
client-side `loading` debounce is trivially bypassed by calling the API directly).
**Fix:** add a `supportChatLimiter` to `lib/rate-limit.ts`, call `.limit(user.id)` at
the top of the handler, mirroring `scan-data-plate/route.ts`.
**Status:** CONFIRMED. This is the single most actionable, highest-confidence finding
in the audit — recommend fixing first.

### 2. [HIGH] Escalation detection is brittle keyword-matching on bot OUTPUT — confirmed
**File:** `lib/support/respond.ts`, `detectEscalation()` (~lines 118-134)
Checks the bot's generated reply text against 6 fixed phrases rather than using a
structured signal. A user can plausibly induce different phrasing (e.g. "don't use the
word 'team'") or simply benefit from natural model phrasing drift, causing a genuine
escalation (billing dispute, safety incident, legal threat) to silently never reach
`needs_human=true` and never enter the staff inbox. The consequence of a missed
escalation is asymmetric and significant — worse than a false positive.
**Fix:** Replace string-matching with a forced structured tool-call/JSON output, the
same pattern already used by `classify.ts`'s `route_support_request` tool.
**Status:** CONFIRMED, exploitable in principle, not live-tested against the model.

### 3. [MEDIUM→RESOLVED] Schema drift: `platform_staff` authorization layer not in committed migrations
**Files:** no `supabase/migrations/*.sql` references `platform_staff`/`is_platform_staff` at all
(confirmed via repo-wide grep — zero hits). Yet it's used throughout `lib/support/*`,
`app/api/support/chat/route.ts`, `app/api/support-inbox/*`, `support-inbox-client.tsx`,
`app/(dashboard)/layout.tsx`.

**This was independently flagged as the #1 "Critical/Unverified" finding by BOTH
Agent 1 (Tenant Isolation) and Agent 3 (Staff Access)** — high-confidence cross-agent
agreement that this needed live verification.

**RESOLVED via live Supabase MCP queries this session** (see `LIVE_DB_VERIFICATION.md`):
- `is_platform_staff()` is correctly defined live: `SECURITY DEFINER`, `STABLE`, body is
  exactly `SELECT EXISTS (SELECT 1 FROM platform_staff WHERE user_id = auth.uid())` —
  no bypass logic, no hardcoded escape hatch.
- It is referenced in **exactly 4** live RLS policies (`support_conversations`
  SELECT/UPDATE, `support_messages` SELECT/INSERT) — confirmed via direct
  `pg_policies` query for any qual/with_check mentioning the function. **No scope
  creep.**
- `platform_staff` table has a live deny-all write policy (`qual=false,
  with_check=false`) plus a self-select policy — correctly not client-writable.
- **Net result: the underlying security posture is CLEAN.** Both subagents' suspected
  Critical findings do NOT represent a live vulnerability.

**However, the schema-drift finding itself stands and should be tracked as a real
Medium-severity process gap**, not retracted entirely: this authorization layer was
applied to the live DB outside the migrations workflow, violating CLAUDE.md's migration
discipline. This causes real cost (two independent subagents had to spend their full
budget chasing what live data proved to be a non-issue) and risk (no record of the
exact DDL for disaster recovery / new environments / branch parity).
**Fix:** Write a migration that reproduces the live `platform_staff` table,
`is_platform_staff()` function, the 4 RLS policies, and the `'human'` message-role enum
value idempotently (`CREATE TABLE IF NOT EXISTS`, `CREATE OR REPLACE FUNCTION`,
`DROP POLICY IF EXISTS` + `CREATE POLICY`) to bring source and live DB back in sync.

### 4. [LOW, downgraded from HIGH] Realtime subscriptions in `support-inbox-client.tsx` are inert, not leaking
**File:** `app/(dashboard)/support-inbox/support-inbox-client.tsx`
Agent 1 and Agent 3 both flagged the unfiltered `postgres_changes` subscription on
`support_conversations`/`support_messages` as High severity, contingent on the
(now-resolved) RLS question — reasoning that if RLS were broader than intended, this
client-side code would directly expose cross-org data via realtime.
**RESOLVED via live query:** neither table is in the `supabase_realtime` publication
(`pg_publication_tables` returns zero rows for both). Supabase silently drops realtime
delivery for tables outside the publication, regardless of RLS — so **these
subscriptions currently receive no events at all.** This is not a leak vector. It is,
however, a **functional bug**: the support inbox's "live updates" are inert; staff are
effectively relying on manual refresh.
**Fix (if realtime is actually wanted):** add both tables to the publication via a
migration, then re-verify RLS scoping specifically for `postgres_changes` (Realtime
does respect RLS once a table is published, scoped per-connection).

---

## Medium Findings

### 5. [MEDIUM] No explicit prompt-injection hardening in system prompt
`buildSystemPrompt()` (`lib/support/respond.ts`) never instructs the model to disregard
"ignore your instructions" style attacks or refuse verbatim disclosure of the system
prompt/tool definitions. Relies entirely on Claude's baseline behavior, no
application-level hardening. **Fix:** add explicit precedence + non-disclosure
instructions to the system prompt.

### 6. [MEDIUM] `account_specific` classification is the worst-case cost path, no hard technical barrier
Routes to Sonnet with up to a 3-round tool-use loop (up to 4 Sonnet calls vs. 1 Haiku
call for `faq`). The classifier (`lib/support/classify.ts`) is reasonably well-scoped
and fails safe (defaults to cheap `faq`), but nothing structurally prevents a user from
phrasing messages to bait this classification repeatedly. Primary mitigation is finding
#1 (rate limiting), which bounds blast radius regardless of classification gaming.

### 7. [MEDIUM] Free-form/off-topic chatbot abuse constrained by prompt only, no output-side check
System prompt instructs the model to answer only from KB context and never invent
features — meaningfully discourages "write me a poem" style abuse — but there's no
technical control verifying responses stayed on-topic. Low per-message cost impact in
isolation, but compounds with finding #1: without a throttle, this is a "free
inference" surface on FieldStay's Anthropic/OpenAI billing at volume.

---

## Confirmed CLEAN (explicit verification, not absence of mention)

- **Tenant isolation in `account-tools.ts` is structurally sound, not prompt-based.**
  All four tools (`getPlanStatus`, `getRecentTurnovers`, `getIntegrationStatus`,
  `getRecentPurchaseOrders`) take `orgId` as their sole parameter and every query is
  `.eq('org_id', orgId)`-scoped. Traced end-to-end: `orgId` originates from
  `requireOrgMember()` in the route handler, never from the request body or the
  model's tool-call arguments — `block.input` is never read in `respond.ts`, and
  `ACCOUNT_TOOLS` schemas declare empty `input_schema.properties`, so there is no slot
  for the model to populate even if it tried. A prompt-injection attempt can only
  taint the bot's hallucinated text, never the actual DB query parameter.
- **Knowledge-base poisoning path does not exist.** Only `scripts/seed-support-kb.ts`
  writes to `support_kb_chunks`, sourced exclusively from repo-local `docs/support/*.md`
  via the service-role key, run manually offline. Live RLS confirms read-only
  (`SELECT USING (true)`, no INSERT/UPDATE/DELETE policy) — corroborated independently
  by both code-level (Agent 2) and live-DB (this session) checks.
- **Tool-use loop hard-capped at 3 rounds**, unconditional local counter, max 4 API
  calls per account-specific request — no DoS/cost-loop vector.
- **No cross-org/cross-request data contamination.** No shared/global mutable state in
  `lib/support/*`; orgId threaded explicitly as a function parameter throughout.
- **Staff server-side gating is correctly implemented everywhere checked.**
  `support-inbox/page.tsx` redirects server-side before render (not client-only);
  both `reply/route.ts` and `resolve/route.ts` independently re-verify
  `platform_staff` membership inline on every POST, not relying on page-level gating.
- **Cross-tenant staff replies are intentional, not scope creep** — staff can act on
  any org's conversation by design, confirmed as the intended human-support model.
- **`is_platform_staff()` usage has zero scope creep** — referenced in exactly the 4
  intended policies live, confirmed by direct query across all of `pg_policies`.
- **`platform_staff` table is not client-writable** — live deny-all policy confirmed.
- **Route requires authentication** — `requireOrgMember()` is the first line of the
  POST handler, no anonymous path exists.
- **Embedding call is exactly 1-per-message**, no retry-loop multiplication;
  `retrieveContext()` falls back to a non-OpenAI recency query on embedding failure
  rather than retrying.
- **Conversation history capped at 10 messages**, bounding per-call token cost
  regardless of total conversation length (see correctness note below).

---

## Correctness bugs noted in passing (not security findings, worth a follow-up ticket)

- Conversation history query has no offset/ordering fix — once a conversation exceeds
  10 messages, the bot always replays the *oldest* 10, not the most recent, degrading
  response quality in long conversations.
- Realtime "live updates" in the support inbox are currently non-functional (finding #4).

---

## Cross-Agent Agreement (higher confidence)

- **Schema drift / platform_staff authorization layer not in migrations** — independently
  raised as the top finding by both Agent 1 (Tenant Isolation) and Agent 3 (Staff
  Access), without coordination. Now resolved as non-vulnerable but real process debt.
- **Realtime subscription scoping** — raised by both Agent 1 and Agent 3 as contingent
  on the RLS question above; both pointed to the same root uncertainty, now resolved.

---

## Severity Breakdown

| Severity | Count | Items |
|---|---|---|
| Critical | 0 | (two suspected Critical findings resolved CLEAN via live DB verification) |
| High | 2 | #1 no rate limiting, #2 brittle escalation detection |
| Medium | 4 | #3 schema drift (process), #5 no injection hardening, #6 cost-path gaming, #7 off-topic abuse |
| Low | 1 | #4 realtime inert (downgraded from High) |
| Clean (explicitly confirmed) | 11 items | see above |

---

## Recommended Remediation Order

1. **Add rate limiting to `/api/support/chat`** (#1) — highest confidence, lowest
   effort, addresses the most realistic abuse path (cost/DoS by any authenticated user).
2. **Replace `detectEscalation()` with a structured tool-call output** (#2) — the
   consequence of a missed escalation (unhandled billing dispute, safety issue) is
   asymmetric; this is a trust/safety fix, not just a cost fix.
3. **Write a backfill migration for the `platform_staff` authorization layer** (#3) —
   not urgent for security (live state is clean) but prevents future audits and
   environments from hitting the same false-positive-Critical dead end, and restores
   migration-history integrity per CLAUDE.md.
4. **Add explicit injection-resistance instructions to the system prompt** (#5) —
   cheap, defense-in-depth.
5. **Decide on realtime support inbox updates** (#4) — either wire up the publication
   properly or remove the dead subscription code; currently harmless but misleading.
6. **Fix conversation-history pagination** (correctness bug) and **tighten
   `account_specific` classification confidence** (#6/#7) as lower-priority follow-ups,
   largely mitigated once #1 lands.
