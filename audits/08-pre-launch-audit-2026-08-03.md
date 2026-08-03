# FieldStay Third Pre-Launch Audit — 2026-08-03

> **RE-VERIFIED against `origin/main` @ `8fd4064` (PR #551 merged).** See the
> [Verification Addendum](#verification-addendum--re-verified-against-8fd4064)
> at the end. Summary: **all 9 CRITICALs stand**; 2 findings fixed by #551,
> 4 withdrawn as invalid, 1 mechanism corrected, 1 scope narrowed.
>
> **Remediation status (2026-08-03):** all 8 code-level CRITICALs closed, plus
> H2/H3 (OAuth binding + open redirect), H4 (Stripe entitlement race), H8
> (Inngest concurrency) and H16 (DB gate armedness). C8 is a dashboard action.
> Findings marked ✅ RESOLVED inline carry their outcome.

**Scope:** Full-repo sweep across seven dimensions, run the day before the
intended launch. Unlike audits 06 and 07, no area was declared out of scope —
each lane re-read its territory from scratch rather than trusting the prior
passes' remediation.

**Method:** Seven partitioned auditors run in parallel, each carrying the same
seven-dimension brief plus one assigned lane. Findings verified against source
and against the live Supabase project `vpmznjktllhmmbfnxuvk` (read-only
`SELECT`s against `pg_policies`, `pg_constraint`, `information_schema`,
`pg_settings`, and the Supabase advisors). CI gates were executed rather than
assumed. **No files were modified during the audit.**

**Baseline:** audited at `7e954c6` — merged `main`, i.e. after audits 06 and 07
were remediated.

---

## Verdict: **NOT LAUNCH-READY for tomorrow. ~1–2 days of work to clear.**

The security architecture holds. Three independent lanes looked for
cross-tenant read leakage — through RLS policies, through 85 service-role call
sites, and through every token-gated public surface — and **none found one**.
That is a real result. RLS is enabled on all 96 public tables, grants are
correct in both directions, every `authenticated`-callable `SECURITY DEFINER`
function re-validates org membership, and the RLS init-plan problem that
usually wrecks Supabase apps at scale is already solved throughout.

What blocks launch is not architecture. It is a cluster of **silent
money-correctness defects**, one **scale ceiling that is already inside your
first customer's range**, and **cost-amplification paths with no limiter** —
one of which is currently masked by `SMS_ENABLED=false` and becomes live the
moment 10DLC clears.

| Lane | Verdict | Crit | High | Med/Low |
|---|---|---|---|---|
| RLS policies + GRANTs (DB layer) | Go, 1 fix | 0 | 2 | 4 |
| Query-level isolation + IDOR (app layer) | Conditional go | 0 | 2 | 10 |
| Dexie offline-sync | Not ready | 1 | 3 | 11 |
| Scalability to 150+ tenants | Not ready | 3 | 8 | 10 |
| Rate limiting + cost control | No-go | 3 | 4 | 13 |
| Data integrity + concurrency | Not ready | 2 | 3 | 10 |
| Complexity + build health | Shippable | 0 | 3 | 8 |

---

## The finding that should change how you read the rest

**Four guardrail bypasses were verified by running the tests. Three of the
nine CRITICALs were invisible to a guardrail written to catch that exact
class.** The enforcement layer is extensive and mostly excellent — but its
pattern-matching is shallow in four specific places, and every one of those
places is where a CRITICAL was hiding.

| Guardrail | Bypass mechanism | What it let through |
|---|---|---|
| `work-order-completion-side-effects.test.ts:38-41` | Only inspects files matching `/workOrderCompletionFields\s*\(/`. A literal `status: 'completed'` write means the file is skipped entirely. | **C1** — two of five completion paths |
| `unbounded-fanout-loops.test.ts` (`BOUND_TOKENS`) | Bare `definition.includes('org_id')`. The substring matched a *filter predicate*, not an org scope. | **C4** — per-booking step explosion |
| `public-route-rate-limiting.test.ts:70` (`AUTH_GATES`) | Exempts any file whose text contains `auth.getUser()`, whether or not the result gates anything. | **C7** — unauthenticated unbounded write |
| `n-plus-one-loops.test.ts` | Looks for a literal `.from(` in the loop body; the query lived behind a helper in another file. | M1 — iCal cancellation N+1 |
| `upload-payload-null-fields.test.ts:69-74` | Skips any function containing `.upsert(`, blinding it to the UPDATE half. | (correct today, unenforced going forward) |
| `external-fetch-timeout.test.ts:64` | Scans `lib` only; `app/` entirely out of scope. Semgrep's twin matches literal `https://` URLs, not variables. | M5 — untimed tenant-supplied fetch |

The meta-rule in CLAUDE.md — "a new convention ships WITH its guardrail" — is
being followed. The gap is that a guardrail written from the *shape of the
instance that was found* tends to miss the next instance written in a
different shape. Recommend tightening these six after launch; the specific
fixes are in each lane's detail below.

---

## CRITICAL

### C1 — Work-order completion has five paths; two skip every side effect
`app/api/crew/work-orders/[id]/complete/route.ts:61-70` (crew),
`supabase/migrations/20260801200000_complete_work_order_via_token_rpc.sql` +
`app/api/work-orders/[token]/complete/helpers.ts:107-167` (vendor portal)

CLAUDE.md names three completion paths. There are five. Both of these write the
completion columns as inline literals instead of calling
`finalizeWorkOrderCompletion()`. Neither calls `advanceSchedulesAfterCompletion`.
The crew path never fires `work-order/completed`, so the `owner_transactions`
maintenance expense never posts.

The second-order effect is worse than the missing expense. Because
`next_due_date` never advances, the next cron sees the schedule still due,
tries to insert a WO for the same `(schedule, date)`, hits
`wo_maintenance_schedule_date_unique`, and treats the 23505 as an expected lost
race. **The maintenance schedule stops recurring, permanently and silently.**

No race required — this is the guaranteed path for any cron-created WO
completed by crew in the PWA.

**Fix:** both routes select `COMPLETED_WORK_ORDER_SELECT` off their claiming
UPDATE and call `finalizeWorkOrderCompletion`. The vendor RPC already reads
`source_schedule_id` into `v_wo` and needs only to return it. Then broaden the
guardrail to match `status:\s*'completed'` on any `work_orders` update under
`app/`.

### C2 — Concurrent turnover generation double-bills the owner's cleaning fee
`lib/turnovers/generator.ts:222-233, 355-382`; `lib/inngest/functions/booking-events.ts:103-104`

`handleBookingDetected` has no `concurrency` key, and `ical-sync.ts:401-445`
fires one `booking/detected` per new booking — so N bookings on one property
spawn N concurrent `generateTurnoversForProperty` runs. The comment at
`ical-sync.ts:394-396` explicitly names this hazard and leaves the fan-out in
place.

The generator's dedup is an in-memory context loaded once per run. On 23505,
`insertStandaloneTurnover` returns `null` and the caller `continue`s — so the
losing run never records that the standalone now exists. Its Pass 2 then falls
through and inserts a *pair* turnover alongside the *standalone*;
`turnovers_booking_pair_unique` and `turnovers_standalone_unique` are disjoint
partial indexes, so nothing forbids coexistence. The winner's
`upgradeStandaloneToPair` then violates the pair index and **its error is
discarded entirely** (`:369`, no destructuring at all).

Result: two turnovers for one physical checkout, both on the board, both
assigned, both completed, two distinct `source_reference_id`s → **two cleaning
fee rows on the owner's P&L**. The reverse interleaving is benign, so this is
roughly a coin flip per contended pair.

**Fix:** `concurrency: { limit: 1, key: 'event.data.property_id' }` closes it
alone. Also: return the winning row's id on 23505 so the context stays
truthful, and capture the discarded error at `:369`.

### C3 — Inventory page silently truncates at ~15 properties
`app/(dashboard)/inventory/page.tsx:33`

Unbounded `.select()` sorted by `property_id` first. Past PostgREST's
`max_rows = 1000` (÷ ~67 items/property ≈ **15 properties**), the PM sees the
first 30% of their portfolio and **zero inventory for every property sorted
after that**. Below-par counts, restock decisions and the Kroger cart all
compute off that array. 200 response, no error, no signal.

**This is inside your stated 10–50 property target — your first customer can
hit it.** Same defect: `templates/inventory/par-levels/page.tsx:24`,
`templates/inventory/saved/page.tsx:23`, `inventory/actions.ts:428`,
`templates/inventory/actions.ts:409`. Bookings calendar has the same shape at
~20 properties (`bookings/page.tsx:100`), where the *forward* end of the
calendar empties.

**Fix:** `fetchAllRows()` — already imported elsewhere in `app/`.

`unbounded-select.test.ts` is scoped to `lib/inngest/**`, so this entire class
is invisible to CI, and semgrep's `-org-scoped` tier counts these 113 sites at
INFO on the assumption "one org's page is always fine" — false for
one-to-many tables.

### C4 — Crew PWA can permanently stop syncing after one failed query
`lib/dexie/context.tsx:445-454`, `:492-504`, `:507`, `:527`

The `crew_members` lookup early-returns on failure, and **every** listener is
installed after it — realtime channels, the `online` handler,
`visibilitychange`, and `installSafetyPoll()`. The effect keys on `[userId]`,
so it never re-runs. The code comment claiming "the next run retries" is false.

`public/sw.js:44-53` serves the cached shell on navigation, so a crew member
opening the app at a property with no signal mounts the provider fully offline
and trips exactly this query. Consequences: no pull-side sync for the rest of
the session even after signal returns, and `crewMemberId` stays `null`, which
silently disables both confirm actions (`use-turnover-actions.ts:279`, `:294`
both bare-`return`). **Tapping "Confirm Checklist Complete" does nothing** — no
error, no toast. Auto-completion never fires, the turnover never completes, no
cleaning fee posts.

**Fix:** install listeners and the safety poll before the crew lookup; make
crew-member resolution retryable or cache the id in `sync_meta`; surface an
error state in the confirm handlers instead of returning.

### C5 — Unauthenticated unbounded DB write with no cleanup
`app/api/integrations/[provider]/connect/route.ts:113`, `proxy.ts:148,230`

`/connect` is in `BYPASS_ROUTES`, and `rateLimiterForPathname()` matches
`/api/integrations/` **only when the path also contains `/callback`**. The
`auth.getUser()` at `:102` is not a gate — `user` may be null by design. Every
request service-role-`INSERT`s into `oauth_states` with an attacker-controlled
`return_to` (unbounded `text`).

Verified against the live DB: **no `cleanup_expired_oauth_states` function
exists** — its migration is in `supabase/migrations/_unshipped/` — and no cron
touches the table. `expires_at` is written but nothing deletes on it.

At ~50 req/s: ~4.3M rows/day, and with `return_to` padded to Vercel's ~16 KB
ceiling, ~70 GB/day of writes to your primary Postgres. No auth, no token, no
signature.

**Fix:** add a `/connect` branch to `rateLimiterForPathname()`; cap `return_to`
length at the boundary; ship the `_unshipped` cleanup function.

### C6 — Email/SMS fan-out is bounded per invocation, not per recipient
`app/(dashboard)/settings/actions.ts:401` (`bulkImportCrew`), `:870` (`inviteAllUninvitedCrew`)

`bulkImportCrew` accepts arbitrary `rows[]` with no cap, no limiter, no
validation beyond a non-empty name. `inviteAllUninvitedCrew` is limited to
20 calls/hour — but each allowed call fans out to up to 1,000 recipients.

Any authenticated trial user: stage 100k addresses, then 20 × 1,000 =
**20,000 emails + 20,000 SMS per hour** to third parties from your sending
domain and Telnyx number. ~$158/hr in Telnyx alone; domain blocklisting is
unrecoverable. The limiter's own comment describes exactly the attack it fails
to stop.

**Fix:** consume N tokens for an N-recipient batch, cap `bulkImportCrew` rows,
add a daily per-org recipient ceiling.

### C7 — Unlimited email + SMS relay to attacker-supplied addresses
`app/actions/work-order-public.ts:27` (`dispatchWorkOrderToVendor`)

Recipient email **and phone come directly from client input** — never read from
a `vendors` row. `requireOrgMember()` and **no rate limiter of any kind**. The
Resend `idempotencyKey` includes the attacker-controlled `vendorEmail`, so
varying it defeats the key; the SMS path has no idempotency at all.

**The email half is live now. The SMS half is masked only by
`SMS_ENABLED=false` and becomes unmitigated the moment 10DLC clears** — which
is the launch plan. Fix before that flag flips, not after.

**Fix:** apply `emailSendActionLimiter` keyed on `user.id`; validate
`vendorEmail`/`vendorPhone` against a `vendors` row in the caller's org.

### C8 — Database instance is one to two sizes too small
Verified via `pg_settings`: `max_connections = 90`, `shared_buffers = 512 MB`
— Supabase **Small** (2 GB RAM, shared vCPU). Auth is additionally pinned to 10
connections.

Those 90 backends must cover PostgREST's pool, Supavisor, Realtime replication
workers, ~30 crons, and every concurrent Inngest handler. Modelled at 150
tenants: ~750 crew devices polling every 5 min × ~8 queries ≈ 20 qps floor,
plus PM dashboards at 6–8 parallel queries per render, plus the 12:30–13:30
cron block. Compounded by **55 of 111 Inngest functions declaring no
`concurrency`** — including every high-volume handler. Connection exhaustion
surfaces as unrelated step failures platform-wide.

**Fix:** resize before onboarding past ~30 tenants; add `concurrency` to
event-triggered Supabase-touching functions. Dashboard change, not code — but
nothing else on this list matters if the instance browns out.

### C9 — Pre-arrival email cron: one Inngest step per booking, platform-wide
`lib/inngest/functions/guidebook-pre-arrival-email-cron.ts:108`

`eligibleBookings` is every confirmed check-in tomorrow across all tenants.
7,500 properties ÷ ~5-day cycle ≈ 1,500 check-ins/day → ~1,500 sequential steps
in one run, against Inngest's 1,000-step ceiling and the 300 s `maxDuration`.
**Cutover ≈ 65 tenants.** Passed `unbounded-fanout-loops` via the `BOUND_TOKENS`
substring bypass described above.

**Fix:** convert to the dispatcher shape `cron/daily-wrapup.ts` already uses.

---

## HIGH

### H1 — Offboarding is systemically broken (two lanes, same root cause)
`deactivateCrewMember()` (`app/(dashboard)/settings/actions.ts:374-382`) only
flips `is_active = false`. It does not delete `turnover_assignments` and does
not revoke the Supabase session. Two independent auditors found the
consequences in different layers:

- **RLS layer:** `get_crew_turnover_ids()` has **no `is_active` filter**,
  unlike its two siblings `get_crew_org_ids()` and `get_crew_property_ids()`
  which both have one. Same omission in ~12 inline `crew_members` policy
  subqueries (`properties_select`, `work_orders_select`,
  `inventory_items_select/_update`, `checklist_*`, `turnovers_select/_update`,
  …). The crew PWA's main read path is browser-client → Supabase direct
  (`lib/dexie/context.tsx:78,104`), so **RLS is the only gate** — `lib/crew-auth.ts`
  guards only `app/api/crew/*`.
- **App layer:** `sendMessageToPM` (`app/(dashboard)/messages/actions.ts:96-102`)
  uses an inline `crew_members` lookup with no `is_active` check.

A fired cleaner with a live JWT keeps reading every assigned property —
including `wifi_password`, `access_instructions`, `internal_notes` — retains
**write** access to turnovers, checklists and inventory, and can keep messaging
the PM. Their PWA simply keeps working.

**Fix:** add `AND cm.is_active = true` to `get_crew_turnover_ids()` and each
inline subquery; replace the `sendMessageToPM` lookup with `requireCrewMember()`;
have `deactivateCrewMember()` call `auth.admin.signOut(userId)`.

### H2 — OAuth callback binds the connection to the session user, not the state token's owner
`app/api/integrations/[provider]/callback/route.ts:200`

```ts
const appUserId = sessionUser?.id ?? stateRecord.user_id ?? null
```

`/connect` is reachable unauthenticated (C5), so an attacker starts the flow,
authorizes with their own OwnerRez/Hospitable account, captures the callback
URL, and gets a logged-in PM to open it (`sameSite: 'lax'` permits top-level
navigation). State validation passes. `appUserId` becomes the **victim**, and
`finalizeIntegrationConnection()` writes `integration_connections.org_id =
victim's org`.

Attacker-controlled PMS is now the victim org's live integration; the initial
sync writes attacker properties/bookings into their tenant, and
`hospitable-owner.ts:243-249` thereafter resolves that `external_user_id`
straight to the victim's org — persistent cross-tenant write.

The `oauth_state_*` cookie written at `:136` as "belt-and-suspenders secondary
verification" is **never read or compared** — only deleted at `:115`.

**Fix:** compare the cookie with `timingSafeEqual`; reject when
`stateRecord.user_id` is non-null and differs from `sessionUser.id`.

### H3 — Open redirect in the OAuth callback
`app/api/integrations/[provider]/callback/route.ts:300-304`

`'//evil.com'.startsWith('/')` is `true`, and `new URL('//evil.com/x', appUrl)`
resolves to `https://evil.com/x`. `return_to` is taken verbatim from the
attacker-supplied query string. A strong phishing primitive and the natural
chaser for H2. The sibling `app/(auth)/callback/route.ts:17` already has the
correct predicate. Same bug client-side at `login-form.tsx:22,54` (MEDIUM).

### H4 — New subscriber may never get an entitlement
`app/api/webhooks/stripe/handlers/core-billing.ts:77-82`, `settings/actions.ts:1216-1234`

`subscription_data.metadata` is not set at session creation, so for a
first-time subscriber the org↔customer link exists **only** after
`checkout.session.completed`. Stripe does not guarantee ordering against
`customer.subscription.created`. If the latter lands first, the org lookup
returns nothing and the handler silently `return`s — no log, no `reportError`,
200 to Stripe, no retry. `plan`, `plan_status`, `max_properties`,
`stripe_subscription_id`, `trial_ends_at` are never written. **The customer has
paid and has no entitlement** until some later `subscription.updated` happens
to fire.

**Fix:** set `subscription_data: { metadata: { org_id } }` and resolve from it
first; at minimum `reportError` + `throw` on the `!org` branch.

### H5 — Outbox head-of-line block that can never dead-letter
`lib/dexie/net.ts:68`, `lib/dexie/syncService.ts:200-213`, `:152-155`,
`app/crew/_components/failed-sync-banner.tsx:60-63`

`classifyUploadFailure` returns `'network'` for any error whose message matches
`\btimeout\b` — including a Postgres statement timeout (`57014`) — even while
`navigator.onLine === true`. The network branch never increments `retryCount`,
never sets `failed`, and returns "stop the drain". So the head mutation retries
forever and **every later mutation across every table is blocked
indefinitely**, with `FailedSyncBanner` showing nothing because it filters on
`failed`.

A full shift's checklist ticks, inventory counts and WO completions queue
invisibly behind one stuck mutation, then get discarded at logout.

**Fix:** dead-letter (or surface a distinct `stuck` state) after N transport
failures accumulated while online, or on a wall-clock age threshold. Add a
non-`failed` "queued > N minutes" indicator.

### H6 — "Retry all" resurrects superseded writes
`lib/dexie/syncService.ts:222-243`, `lib/dexie/helpers.ts:167-182`

Dead-lettering deliberately breaks per-record ordering, but
`retryAllFailedMutations` clears `failed` **in place**, so the row keeps its
low `id` and `drain()` replays the stale payload as if newest. Tick →
dead-letter → un-tick → Retry all → the old tick wins on the server, and the
next delta pull overwrites Dexie too. Same shape for
`inventory_items.current_quantity` and `crew_availability`.

**Fix:** dead-letter subsequent mutations for the same target too, or
delete-and-re-add on retry so it lands at the tail.

### H7 — Vendor-submitted `subtotal` is never reconciled against line items
`app/api/work-orders/[token]/complete/route.ts:99,112,145` → the RPC at
`20260801200000_...sql:92,108-112`

The route carefully validates line items into `safeLineItems`, and `line_total`
is `GENERATED ALWAYS` specifically so a client cannot state a total that
disagrees with its own quantity × unit cost. That control is then **defeated at
the aggregate level**: `subtotal` is taken verbatim from the request body,
bounded only on the upside (`> 1_000_000`), and written to
`work_orders.actual_cost`, `work_order_invoices.subtotal`/`.total`, and the
Stripe platform fee.

Non-adversarial case: one line item failing validation is dropped from
`safeLineItems` but still counted in `subtotal`, so the invoice total exceeds
the sum of the items displayed beneath it, silently. Adversarial: $50 of line
items with `subtotal: 999999`. Negative values pass too.

This is the one unauthenticated write path that mints financial records.

**Fix:** compute `subtotal` server-side inside the RPC from the same rows it
inserts; ignore the client field when line items are present.

### H8 — Purchase order can be created permanently empty
`lib/inngest/functions/inventory-events.ts:213-258`

Three writes in one `step.run`; the items insert and the status update
**discard their results entirely**. If the items insert fails, the step returns
success. On any retry the idempotency pre-check finds the PO and short-circuits
with `alreadyExisted: true`. The PM opens a restock order that lists nothing,
forever, with nothing logged.

**Fix:** single RPC transaction, or destructure and `throw` on both; make the
short-circuit verify the PO actually has items.

### H9 — `turnover/completed` fires without completing the turnover
`app/api/work-orders/[token]/complete/helpers.ts:141-166`

`dispatchCompletionEvents` reads the turnover, checks its status, and sends
`turnover/completed` — but never writes `turnovers.status`, and neither does
the RPC. The cleaning fee posts and the PM is told "✓ Turnover complete" while
the turnover stays `in_progress` on the board. When it is later completed for
real, the `.neq('status','completed')` guard passes and the event fires
**again** — metric double-counted, and `completed_at` stamped hours after the
fee posted, corrupting the duration that crew scoring derives.

### H10 — Migration ledger has diverged from local files
311 live entries vs 309 local files: **33 local files absent from live history,
35 live entries with no local file.** Verified as renumbering rather than
unapplied content — live `schema_migrations.name` values carry the local
filenames under different version numbers — and production's schema was
confirmed correct by checking effects directly.

The risk is procedural: `supabase db push` now sees 33 files as unapplied and
will try to re-apply them, including a revoke/restore pair
(`20260801280000` / `20260801290000`) that breaks work-order inserts if replayed
partially. It also falsifies CLAUDE.md's stated invariant that E2E-verified
schema invariants hold for production by construction.

**Fix:** `supabase migration repair --status applied <version>` for the 33
before any further push. **Do not run `db push` against production until
reconciled.**

### H11 — iCal sync cannot keep up with its own schedule
`lib/inngest/functions/ical-sync.ts:151` — the comment says "up to 20 feeds in
parallel", the config says `concurrency: { limit: 5 }`. At 3–8 s per feed the
ceiling is ~3,600 feeds/hour; demand at 150 tenants × 30 properties × 2 feeds is
**9,000/hour**. Queue grows ~5,400/hour permanently, starting ~60 tenants. The
symptom is not an error — calendars go progressively staler while every cron
reports success.

### H12 — `.in()` lists from platform-wide scans will exceed the URI limit
`.in()` serialises to a GET param at ~37 bytes/UUID against a ~16–32 KB request
line — roughly 400–800 UUIDs. `turnover-priority-decay.ts:77` passes
platform-wide property ids (~3,000–7,500 at 150 tenants ≈ 110–280 KB) → hard
414 **every day**, breaking ~30–60 tenants.
`guidebook-pre-arrival-email-cron.ts:97` ≈ 55 KB. No server-side equivalent of
the crew client's `IN_CHUNK_SIZE = 100` chunker exists.

### H13 — `compliance-documents` bucket has no size or MIME limit
Verified live: `file_size_limit` and `allowed_mime_types` both `null`, unique
among the buckets. The upload at `vendors/[id]/compliance-section.tsx:65` is a
**direct browser→Supabase call that never touches Next.js**, so no proxy
limiter and no size check exists anywhere in the path — the `accept=` attribute
is cosmetic. One SQL statement to fix.

### H14 — Every IP-keyed limiter trusts the leftmost `X-Forwarded-For`
`lib/integrations/webhook-verification.ts:68` returns `header.split(',')[0]`.
The doc comment asserts Vercel prepends the real client IP; **that could not be
verified from the repo, and it is the wrong default regardless** (standard
proxy behavior is to append). If it appends, one header defeats
`ownerPortalRatelimit`, `workOrderRatelimit`, `guidebookRatelimit`,
`vendorConnectRatelimit`, `inviteAcceptRatelimit`, `demoRatelimit`,
`unsubscribeRatelimit` and both guidebook limiters simultaneously.

**Verify in 2 minutes:** `curl -H 'X-Forwarded-For: 1.2.3.4' <deploy>/api/health`
and log `x-forwarded-for` vs `x-vercel-forwarded-for` server-side.
**Fix regardless:** prefer `x-vercel-forwarded-for`, then `x-real-ip`, then the
**rightmost** XFF entry.

### H15 — Lint ratchet is at exactly 202/202 with zero headroom
`package.json:12`. Any new sonarjs warning — one nested ternary in a hotfix —
fails CI outright, on the eve of a launch where hotfixes are likely. Burn down
a few or raise the cap to ~210 with a dated comment. Do not disable it.

### H16 — The DB-invariant and type-drift gates self-disarm — ✅ RESOLVED 2026-08-03
`.github/workflows/ci.yml:266-267`, `:188-217`

`check-db-invariants.mjs` is what mechanically verifies RLS-on-every-table,
zero `anon` grants, FK covering indexes and dedupe-key uniqueness. It exits 0
with a `::warning` when secrets are missing. **A green CI does not prove it
ran.**

**Outcome.** The job *was* armed — PR #553's log shows real secrets and real
check output — so no invariant had actually gone unverified. But that was luck,
not design: nothing about the check's status distinguished "ran and passed"
from "skipped silently", which is the defect. Two fixes, both preserving the
reason self-disarm exists (fork PRs must not sit on a permanently red required
check, which `unit/guardrails/ci-gating.test.ts` deliberately asserts):

- `DB_INVARIANTS_REQUIRE_ARMED=1` makes an absent secret a hard failure. CI
  sets it for non-fork runs only, so forks keep the disarm and the canonical
  repo cannot silently skip.
- `DB_INVARIANTS_ALLOW_PROD=1` / `npm run check:db-invariants:prod` allows a
  deliberate production verification. `db_invariant_report()` is `LANGUAGE sql`
  / `SECURITY DEFINER` with zero DDL or DML, so this is read-only; the blanket
  refusal existed to keep prod credentials out of CI, not because the check
  writes.

Also corrected the script header's load-bearing (and unsound) claim that
"schema-level invariants verified on the E2E project hold for production by
construction" — the ledgers have diverged, so an E2E pass is evidence about
E2E only. That is a gap in what CI can *prove*, not a known production defect.

**Production was verified directly and passes all nine checks**: no table
without RLS, zero `anon` grants, every FK column indexed, every dedup column
uniquely indexed, every member-facing policy grant-backed, no memberless orgs,
every storage policy org-scoped, and the policy-less table and bucket
allowlists match production 1:1 in both directions.

---

## Selected MEDIUM (full detail in lane reports)

- **`crew_availability` accepts `org_id` from the browser**
  (`lib/dexie/syncService.ts:562-582`) and the RLS crew branch constrains
  `crew_member_id` but not `org_id` — cross-tenant row *injection* (integrity,
  not read leak). `property_assets_insert` has the correct pattern to copy.
- **`asset-health` cron throws at ~90 tenants** — `fetchAllRows` over 3 years of
  platform-wide WOs ≈ 337k rows, exceeding its own 200k `maxRows` ceiling.
- **SMS opt-in crons re-scan the entire TCPA trail daily** — the stay-window
  filter is in JS below the query; ~90k rows/year, 180 round-trips/day, no
  supporting index, `fetchAllRows` throws at ~2.2 years.
- **`addCrewToTurnover`** (CC 26) does O(n×m) conflict detection over an
  unbounded assignments select; past 1000 rows conflict warnings silently stop.
  A null `checkin_datetime` also produces a zero-width interval that never
  overlaps.
- **Realtime ships on v1** — `NEXT_PUBLIC_CREW_SYNC_V2` defaults off, so each
  device opens 3 channels / 6 `postgres_changes` bindings, re-evaluating RLS per
  client per WAL change. The v2 broadcast path is built and guardrailed but
  dormant. Build-time inline: flipping it needs a redeploy.
- **Untimed `fetch` to a tenant-supplied Slack URL**
  (`app/(dashboard)/messages/actions.ts:254`) — found by two lanes, sits in the
  gap between two guardrails.
- **`assignCrew` can double-assign** — delete-then-upsert is not atomic and
  `turnover_assignments_crew_unique` is on `(turnover_id, crew_member_id)`, so
  two PMs assigning different crew both succeed.
- ~~**`maintenance_schedule_templates.org_id` has no FK** to `organizations` —
  the only such table in the schema.~~ **WITHDRAWN — not a defect.** The column
  is genuinely FK-less, but deliberately so: the table holds the platform-level
  seed template `FieldStay STR Standard` under the sentinel `org_id`
  `00000000-0000-0000-0000-000000000000`, a "belongs to no tenant" marker.
  Creating an `organizations` row purely to satisfy the constraint would then
  trip the memberless-org check. It is an explicit, reasoned entry in
  `ORG_ID_FK_EXCEPTIONS` (`scripts/check-db-invariants.mjs`). See the addendum.
- **Billed LLM + Mapbox calls with no limiter** — `fireManualLookup`
  (`properties/actions.ts:486`, web-search tool, ~$0.01–0.03/call) and
  `geocodeZip` (`lib/geocoding.ts:37`, no cache despite zip→lat/lng being
  immutable).
- **Kroger quota is platform-wide with no per-tenant allocation** — ceiling is
  ~78–150 cart builds/day, so it breaks *within* the 150-tenant target as a
  noisy-neighbor: early crons consume the budget, the rest get no cart.
- **Photo blob gone = silent delete** (`lib/dexie/photo-sync.ts:273-278`) — iOS
  7-day eviction destroys a required checklist photo with no trace.
- **Zero-row assignment read wipes the local cache**
  (`lib/dexie/sync/turnovers.ts:219-226`) — an RLS blip returning `[]` is
  indistinguishable from "unassigned from everything".

---

## What was checked and found clean

This is a real result, not an absence of looking:

- **No cross-tenant read leak** on any surface, found independently by three
  lanes. 85 `createServiceClient()` sites enumerated exhaustively; owner portal
  and vendor WO portal both trace clean end-to-end; no entry point anywhere
  reads `org_id` from client input (the one exception is the `crew_availability`
  MEDIUM above).
- **RLS enabled on all 96 public tables.** Policy-less tables match
  `SERVICE_ROLE_ONLY_TABLES` 1:1. Zero `anon` grants at table or column level.
  Zero tables with policies but no `authenticated` grant.
- **`auth_rls_initplan`: zero findings.** Every `auth.uid()` /
  `get_user_org_ids()` reference in a SELECT policy is `(select …)`-wrapped —
  the single biggest RLS scaling factor, correct throughout.
- **All 66 `SECURITY DEFINER` functions** owned by `postgres`, 65 of 66 pin
  `search_path`, and every one callable by `authenticated` with a caller-supplied
  `p_org_id` re-validates with `is_org_member` *and* scopes every statement.
- **All four webhooks verify signature before any work**, with claim→handle→
  release-on-throw dedup. Telnyx adds Ed25519 + freshness + replay claim.
- **The `owner_transactions` idempotency spine** — `(source_reference_id, source)`
  unique, upserted at every posting site.
- **`wo_number` allocation** is row-lock serialized; two concurrent WOs cannot
  share a number.
- **Fail-policy assignment is right everywhere checked** — spend ceilings fail
  CLOSED (nudge budget, scan, Kroger), abuse limiters fail OPEN, each with a
  written justification. The strongest part of the codebase.
- **Token entropy is a non-issue** — every public token is UUIDv4 or 32-byte
  hex; expected time to hit a live one at the 20 req/min ceiling is ~10²⁴ years.
  **Do not spend launch time here.**
- **Build health:** `tsc` clean, 2770/2770 tests pass, build compiles,
  `check:ui-classes` clean, semgrep chokepoints at 0, ratchet at baseline. No
  `ignoreBuildErrors`, no CORS headers, CSP nonce-per-request with no
  `unsafe-inline` in production, exactly one OTEL registration, zero `as any` /
  `@ts-ignore`, one TODO repo-wide.
- **The Dexie sync engine does not appear in the complexity violation list at
  all** — the right outcome for the most race-prone subsystem.

---

## Suggested sequencing

**Before launch (~1–2 days):**
1. C8 — resize the DB instance (dashboard, minutes)
2. C3 — `fetchAllRows` in five files (minutes, highest user-visible impact)
3. C2 — one `concurrency` key (minutes, stops double-billing)
4. C1 — route both completion paths through `finalizeWorkOrderCompletion`
5. C5 + C6 + C7 — limiter branch, per-recipient counting, vendor dispatch limiter
6. H1 — `is_active` in RLS + `sendMessageToPM` + session revocation
7. H2 + H3 — OAuth cookie comparison + redirect predicate
8. H7 — server-side `subtotal`
9. H10 — reconcile the migration ledger **before any `db push`**
10. H14 + H16 — two empirical checks, ~10 minutes total

**Before flipping `SMS_ENABLED=true`:** C7 must be fixed first.

**Staged onboarding buys time:** C9, H11, H12 and the asset-health/SMS-cron
ceilings all break between 60 and 150 tenants. Keeping onboarding below ~50
while those are fixed post-launch is a legitimate call.

**Post-launch:** the six guardrail bypasses, C4/H5/H6 (Dexie — significant work,
and the crew PWA is lower-traffic on day one), complexity burn-down.

---

# Verification Addendum — re-verified against `8fd4064`

The audit ran at baseline `7e954c6`. PR #551 ("database generic wiring") merged
afterwards. Every finding was re-checked against `origin/main` @ `8fd4064`, and
the live DB findings were re-queried against `vpmznjktllhmmbfnxuvk`.

**Bottom line: the launch verdict is unchanged. All nine CRITICALs stand.**

### Scope of the merge

PR #551 changed 7 files: `inventory/actions.ts`, `maintenance/actions.ts`,
`turnovers/actions.ts`, a new `lib/tenancy/verify.ts`, two guardrail tests, and
`.semgrep/baseline-counts.json`. Every file backing a CRITICAL is
**byte-identical** to the audit baseline — verified by comparing blob hashes,
then spot-checking the code directly:

| Finding | Confirmed present at `8fd4064` |
|---|---|
| C1 | `status: 'completed'` still an inline literal in the crew route; no `finalizeWorkOrderCompletion` |
| C2 | `handleBookingDetected` still `{ id, name, retries: 3 }` — no `concurrency` key |
| C3 | `inventory/page.tsx` still unbounded; its comment now says "up to ~2,500 rows" — 2.5× the cap it truncates at |
| C4 | `if (!crewMember \|\| cancelled) return` still above every listener; comment still claims "the next run retries" |
| C5–C7, C9 | files untouched |
| C8 | infrastructure, unaffected by a code merge |
| H1 | re-queried live: `get_crew_turnover_ids` still lacks `is_active`; both siblings have it |
| H10 | still 311 live ledger entries |
| H13 | `compliance-documents` still `file_size_limit = NULL`, `allowed_mime_types = NULL` |

### FIXED by PR #551 (2)

- **`addCrewToTurnover` unbounded conflict read** — now `tryFetchAll(...)` with
  `.range()` at `turnovers/actions.ts:765-775`, and it fails *loudly*: a null
  result surfaces "Couldn't check … for conflicts — please verify manually."
  (`:789`). The `alreadyAssigned` pre-check is paginated and fails closed too.
- **Cognitive complexity 26 in `addCrewToTurnover`** — eliminated via
  `loadAssignmentTargets`, `sendAssignmentPush`, `countScheduleConflicts`,
  `fetchCrewTimeOff`, `tryFetchAll`. `maintenance/actions.ts` is **unchanged**
  (CC 23 @ `:131`, CC 21 @ `:1630`) and grew 2369 → 2529 lines; the commit's
  "to zero" refers to the supabase-error-handling ratchet, not complexity.

Also fixed in passing, unreported by the audit: `push_subscriptions`
(`turnovers/actions.ts:206-215`) **gained a missing `.eq('org_id', orgId)` on a
service-role read** — a genuine tenant-isolation fix.

### WITHDRAWN as invalid (4)

- **`maintenance_schedule_templates.org_id` has no FK — not a defect.**
  Withdrawn 2026-08-03 while resolving H16. The observation was accurate (the
  column has zero FK constraints, verified against the live DB) but the
  conclusion was wrong: it is a deliberate, documented exception in
  `ORG_ID_FK_EXCEPTIONS` (`scripts/check-db-invariants.mjs`). The table holds
  the platform seed template under sentinel `org_id`
  `00000000-0000-0000-0000-000000000000` — "belongs to no tenant" — and adding
  an `organizations` row to satisfy the FK would then violate the
  memberless-org invariant. The DB-layer lane additionally reasoned that
  `db_invariant_report()`'s check 9 "should flag this, and that it hasn't is
  corroborating evidence for the ledger drift." That inference was also wrong —
  the check doesn't flag it because it is allowlisted, not because it is
  looking at a different database.

  **The general lesson, since two lanes made the same mistake:** an invariant
  checker passing on something that *looks* like a violation is at least as
  likely to mean "deliberate exception" as "checker is blind." Read the
  allowlist before concluding the tool is broken.

  Production was verified directly during this correction and **passes all nine
  invariant checks** — see the H16 entry below.

### Previously withdrawn (3)

- **C3's `inventory/actions.ts:428` site — mis-attributed.** At baseline that
  line was a `properties` read, not `inventory_items`. Both `inventory_items`
  reads in that file were *already* paginated. C3's real site list is **three**
  files, not five: `inventory/page.tsx:33`,
  `templates/inventory/par-levels/page.tsx:24`,
  `templates/inventory/saved/page.tsx:23` — all three re-read and confirmed
  genuinely unbounded and org-scoped-only. The fifth claimed site,
  `templates/inventory/actions.ts:409`, is an `.in('id', …)` read sized by a
  client-supplied list, which is a different and much weaker class — it
  truncates only on a >1000-item template edit. **C3's severity is unchanged**
  (the page that breaks at ~15 properties is real), but its blast radius is
  narrower than reported.
- **Null `checkin_datetime` → zero-width interval** — `turnovers.checkin_datetime`
  is `NOT NULL` (`schema_reference.sql:2615`, `database.generated.ts:4715`). The
  `?? checkout_datetime` fallback at `turnovers/actions.ts:262` is dead code, not
  a live bug. Worth deleting so it stops reading as a handled case.
- **L4 — `next_wo_number` callable by `authenticated`** — its ACL is
  `postgres=X | service_role=X`. `authenticated` cannot call it. The finding was
  inferred from an `_unshipped` migration's comment describing the
  *pre-hardening* state rather than from the live grant.

### CORRECTED mechanism (1)

**C5** claimed `cleanup_expired_oauth_states` does not exist and its migration
sits in `_unshipped/`. Both wrong: the function **exists in production**, defined
by a shipped migration (`20260531181701_integration_framework.sql`), is
`service_role`-only, and has `search_path` pinned. What sits in `_unshipped/` is
a *hardening* migration whose effect landed by another route.

**The finding survives on its substance:** `pg_cron` is not installed and there
are zero code references to the function, so **nothing ever calls it**. Expired
`oauth_states` rows still accumulate with no bound. The unauthenticated
unbounded write is real; only the stated reason for the missing cleanup was
wrong.

### Both corrections share one root cause

Two of the three withdrawals came from an agent treating
`supabase/migrations/_unshipped/` as evidence of what is *not* in production,
when those changes had landed by another route. That is the same drift as
**H10** — local migration files are not a reliable picture of live state. It
strengthens H10 rather than weakening it, and it is a standing hazard for any
future audit: **verify against the live DB, not the migrations directory.**

### `lib/tenancy/verify.ts` (new, reviewed)

A new shared tenancy helper days before launch warrants scrutiny; it is
**correct**. `verifyPropertyInOrg` filters on both `.eq('id', …)` and
`.eq('org_id', …)`, and **fails closed in both directions** — a read error and
a missing row each return `{ok:false}`, with no path returning `ok:true` on a
failed read. It correctly separates "read failed" from "not yours", which is the
defect it was extracted to fix. All 7 call sites branch correctly
(`if (!owned.ok) return { error: owned.error }`) and every one passes
`membership.org_id` from `requireOrgMember()`, never a client value.

Two nits, neither a defect: the `createClient` import is a value import used
only in a type position (`import type` would avoid pulling the service-role
module into the graph), and the parameter type would also accept a service-role
client — safe here since the helper filters `org_id` explicitly, but the type
carries no guarantee.

### Guardrail and baseline changes — all tightening, none loosened

Checked specifically because a removed guardrail line can be either a burn-down
or a loosened check:

- **`supabase-error-handling.test.ts`** — three baseline entries deleted
  (8 + 23 + 16 = **47 sites moved from allowed to forbidden**). A mandatory
  burn-down: the test fails on a stale entry, so leaving them would break CI.
  Zero is real — the only remaining unchecked destructures are dynamic
  `import()`s the matcher excludes.
- **`n-plus-one-loops.test.ts`** — one line, `:855` → `:907`. Pure line shift;
  the code at the new offset is byte-identical to baseline. No exception added
  or broadened.
- **`.semgrep/baseline-counts.json`** — every changed count went **down**
  (`read-without-error` 306→259, `discarded-result` 143→142,
  `unbounded-select-in-list` 43→36, `-single-parent` 45→40). None increased, so
  nothing bypassed the ratchet.

**One caveat on the "bounded reads" claim:** three maintenance sites
(`maintenance/actions.ts:892, 1375, 1966`) were bounded with
`.limit(SUPABASE_MAX_ROWS)` = `.limit(1000)` — exactly the PostgREST cap, so a
1001st row is still silently dropped. All three are small-cardinality, so this
is acceptable rather than a bug, but **the ratchet count moved without the
truncation risk actually being removed.** Worth knowing before trusting that
counter as a proxy for safety.

### New findings introduced by #551

None of substance. Verified: no newly-added discarded results (a diff-scoped
grep for added bare `await supabase…` returns zero), no new unbounded selects
(all 14 added `.select(` calls terminate in `maybeSingle()`, `fetchAllRows`/
`tryFetchAll`, or an explicit `.limit()`), and no service-role call without org
scope.

Three minor observations:
1. `applyTemplateToProperties` error precedence changed — a valid empty template
   with no owned properties now reports "No valid properties selected" instead
   of "No items in template". Cosmetic.
2. `countScheduleConflicts` is now O(n × m) over a fully-paginated set — fixing
   the unbounded read removed the accidental 1000-row cap that used to hide it.
   Small in practice.
3. `addCrewToTurnover`'s status advance (`:728`) issues
   `.update({status:'assigned'}).in('id', pendingIds)` with **no** status
   precondition, while its sibling `assignCrew:371-375` **does** have
   `.eq('status','pending_assignment')`. Pre-existing, not introduced here, but
   the asymmetry between two sibling actions is the same TOCTOU shape as the
   `updatePurchaseOrderStatus` finding.

### Still valid, in the changed files

- **`updatePurchaseOrderStatus` TOCTOU** — now `inventory/actions.ts:786`
  (pre-read) vs `:791-797` (UPDATE). Still no status precondition in the WHERE;
  two concurrent calls both pass, both `logAuditEvent`, both send
  `purchase-order/approved` with no dedup key.
- **`assignCrew` double-assign race** — now `turnovers/actions.ts:353-357`
  (delete), `:360-363` (upsert), `:371-375` (status). Delete and status update
  still discard their results; delete-then-upsert still two statements. Confirmed
  against live schema that `turnover_assignments_crew_unique` is
  `(turnover_id, crew_member_id)` and so does **not** constrain
  one-crew-per-turnover.
