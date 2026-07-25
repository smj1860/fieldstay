# Structural Scalability — Remaining Tier Items: Implementation Instructions

Companion to `docs/CREW_SYNC_V2_PHASES.md`. That document covers the crew
PWA realtime redesign (originally Tier 1 item 3 of the scalability
assessment); this one captures everything else still open from that
assessment, written so an agent with no prior context can execute each
item. Read `CLAUDE.md` at the repo root in full first — every rule there
applies, and the guardrail suite will fail your build if you skip it.

## 0. Where the assessment stands

The original assessment ranked findings into three tiers. Verified current
status (checked against the live codebase, not assumed):

| Item | Tier | Status |
|---|---|---|
| 1. Serial per-org crons → event fan-out | 1 | ✅ Done — `daily-wrapup.ts`, SMS morning/evening crons, `ownerrez/incremental-sync`, `turnover-priority-decay` all converted to `step.sendEvent` fan-out |
| 2. OwnerRez/Hospitable shared-IP budget fair-share | 1 | ✅ Done |
| 3. Crew PWA Realtime footprint | 1 | 🔶 In progress — redesigned as Crew Sync v2; Phases 0–1 live, Phases 2–5 remain (see `CREW_SYNC_V2_PHASES.md`) |
| 4. Drop redundant per-row `is_org_member()` from SELECT policies | 1 | ✅ Done — migration applied |
| 5. SMS spend/throughput guard before `SMS_ENABLED=true` | 1 | ✅ Done (flag itself stays false until 10DLC clears) |
| 6. Memoize `requireOrgMember()` + fix layout waterfall | 2 | ✅ Done — `lib/auth.ts` wraps auth context in React `cache()` |
| 7. Dexie delta sync + outbox backoff | 2 | 🔶 Half done — delta sync shipped as Crew Sync v2 Phase 1; **outbox backoff = Phase 4, still open** |
| 8. Bound the unbounded queries | 2 | ✅ Done — `checklist-signals` has a 180-day rolling window, reviews/owners pages are `.limit()`-bounded |
| 9. Enforcement Tiers 1–3 (ESLint/guardrails → typed ServiceRoleContext → DB invariant CI gate) | — | ✅ Done — Tier 3 is PR #505 |
| 10. Tier 3 hygiene list | 3 | 🔶 Section 3 (Kroger rate limiter) done; sections 1, 2, 4, 5 remain — see below |

So the actual remaining work is: **Crew Sync v2 Phases 2–5** (the other
document), plus the four Tier 3 hygiene items and one enforcement leftover
below. Each section here is independent — they can be separate small PRs
in any order.

---

## 1. `notifications` retention cron

**Problem:** the `notifications` table (in-app bell events, added
2026-07-15) has no retention job — it grows forever. Every other
append-heavy table already has one (`audit-retention.ts`,
`comms-retention.ts`, `guest-pii-retention.ts` in
`lib/inngest/functions/cron/`).

**Instructions:**

1. Read `lib/inngest/functions/cron/audit-retention.ts` and mirror its
   shape exactly (batch-deleting cron, service client with
   `{ system: 'inngest:...' }` context, logger calls).
2. Policy: delete `notifications` rows where `read_at IS NOT NULL AND
   created_at < now() - interval '90 days'`, and unread rows older than
   180 days. Delete in bounded batches (the existing retention crons show
   the pattern) — never one unbounded `DELETE`.
3. Register the event in `lib/inngest/events.ts` (before the closing brace
   of `FieldStayEvents`) and the function in `app/api/inngest/route.ts`
   (inside the ONE existing `serve()` call).
4. No migration needed; no `types/database.ts` change.
5. Verification pass, commit.

## 2. Hostaway incremental sync

**Problem:** Hostaway sync is initial-import only / full-refetch — no
incremental cursor, unlike OwnerRez which has
`ownerrez/incremental-sync.ts`.

**Instructions:**

1. Read `lib/integrations/providers/` for the Hostaway provider and the
   OwnerRez incremental sync function as the reference implementation.
2. Mirror the OwnerRez pattern: a cron that fans out one event per
   Hostaway connection (`step.sendEvent`), a per-connection handler with
   a `latestActivity`/modified-since cursor stored on
   `integration_connections` (check what cursor fields already exist
   before adding columns — if a migration is needed, update
   `types/database.ts` in the same commit).
3. Respect the shared API budget pattern used for OwnerRez (per-org
   fair-share, resume-where-left-off — item 2 of the assessment, already
   built; reuse its helpers rather than reimplementing).
4. Register event + function per the standard Inngest rules; idempotency
   per CLAUDE.md (bookings dedup on external id, `ON CONFLICT DO NOTHING`).

## 3. Kroger API rate limiter

**Status: ✅ Done.** `lib/rate-limit.ts` gained four endpoint-class limiters
(`krogerProductsApiLimiter` 9,000/day, `krogerLocationsApiLimiter` 1,440/day —
both 90%-headroom off Kroger's confirmed published daily limits;
`krogerCartApiLimiter` and `krogerAuthApiLimiter` use conservative defaults
where Kroger's own docs don't publish a figure — see the comments in that
file for sourcing). `lib/kroger/client.ts` now routes every outbound Kroger
call through a shared `krogerFetch()` wrapper (same shape as
`hospitableFetch` in `lib/integrations/providers/hospitable.ts`) that
consults the relevant limiter first and reacts to a real 429 by parsing
`Retry-After`, fails open on a Redis error, and throws the shared
`RateLimitError` either way. `build-shopping-cart.ts`'s `get-customer-token`
step now rethrows `RateLimitError` instead of swallowing it into the
list-only fallback; the two OAuth callback routes (which run outside any
Inngest step) now redirect to a distinct `rate_limited` reason instead of
the generic `token_exchange_failed`/restart-connect-flow path. See
`unit/lib/kroger-client-rate-limit.test.ts` and the added cases in
`unit/inngest/build-shopping-cart.test.ts` /
`unit/route-handlers/integrations-callback.test.ts`.

**Original problem:** `lib/integrations/providers/kroger.ts` calls the Kroger API
with no rate limiting or 429 handling — cart automation fanning out across
orgs shares one IP/token budget, same class of problem as OwnerRez was.

**Instructions:**

1. Check Kroger's published limits (public docs: 10,000/day per endpoint
   class is the commonly cited figure — verify at implementation time).
2. Add a limiter in the same style as `lib/rate-limit.ts`'s Upstash
   sliding-window limiters (one shared limiter keyed per endpoint class,
   not per org), consulted inside the Kroger provider before each call.
3. Handle 429 responses: honor `Retry-After` when present; inside Inngest
   steps, throw a retriable error so Inngest's backoff does the waiting
   (never `sleep()` inside a step).
4. Fail open if Redis is unavailable **for reads of the limiter**, but see
   section 4 — outbound-spend budgets are the one place we fail closed.

## 4. Fail-closed outbound budgets on Redis outage

**Problem:** budget/spend limiters (SMS budget chokepoint in
`lib/sms/telnyx.ts`, retailer/cart spend) currently follow the same
fail-open-on-Redis-error convention as the abuse rate limiters in
`proxy.ts`. For token-enumeration throttles fail-open is correct (an
outage shouldn't take down public pages); for **money-spending** paths it
is backwards — a Redis outage would remove all spend ceilings exactly when
nothing is watching.

**Instructions:**

1. Identify every limiter whose purpose is bounding *spend* rather than
   *abuse* (grep `lib/rate-limit.ts` consumers; the SMS budget check in
   `lib/sms/telnyx.ts` is the canonical one).
2. For those call sites only: on limiter error, **skip the send and log
   loudly** (`console.error` + `reportError`) instead of proceeding.
   Message the failure into the PM notification stream if the existing
   notification helpers make that cheap.
3. Do NOT change the fail-open behavior of `proxy.ts`'s public-route
   limiters — that direction is deliberate and documented there.
4. Per the CLAUDE.md meta-rule, add a one-line note to the SMS section of
   CLAUDE.md and, if practical, a guardrail test asserting the SMS send
   path contains the fail-closed branch (grep-style, like
   `forbidden-patterns`).

## 5. Enforcement leftover: `types/database.ts` drift check

**Problem:** PR #505's `db-invariants` CI job implemented checks 1–3 of
the Tier 3 outline (RLS everywhere, FK covering indexes, zero anon
grants). Check 4 — generating types from the e2e project and diffing the
table/column shape against the committed `types/database.ts` — was
deferred.

**Instructions:**

1. Extend `scripts/check-db-invariants.mjs` (or add a sibling script) to
   fetch generated types for the e2e project (`syhthijeqlnltufdawyb`) via
   the Supabase CLI or REST, reduce both the generated output and the
   committed `types/database.ts` to a comparable table→column→nullability
   shape, and diff.
2. Report drift as a CI failure listing the specific tables/columns —
   this is exactly the class of bug that cost half a day this session
   (`wo_status` missing `quote_requested` on e2e; see migration
   `20260725043000`). The check exists to make that impossible to miss
   again.
3. Same self-disarming behavior as the rest of the job when e2e secrets
   are absent.
4. Expect an initial reconciliation pass: the first run will surface
   existing drift; fix it with migrations (both projects) rather than
   loosening the check.

---

## Quick reference

- Verification pass: `npx tsc --noEmit && npm run lint && npx vitest run && npm run check:ui-classes`
- Prod Supabase: `vpmznjktllhmmbfnxuvk` · E2E: `syhthijeqlnltufdawyb` — never any other project; migrations applied to BOTH + file committed, same PR.
- Inngest: functions in `lib/inngest/functions/`, events registered in `lib/inngest/events.ts`, ONE `serve()` in `app/api/inngest/route.ts`.
- New convention ⇒ ships with its guardrail, same PR.
