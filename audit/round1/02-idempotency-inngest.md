# Idempotency / Deduplication / Inngest Audit

> **ARCHIVED — superseded by `audit/` Round 2. Findings here reflect the codebase as of 2026-07-13 and should not be read as current state.**

Status: COMPLETE
Last checkpoint: audited all lib/inngest/functions/*.ts (including cron/, ownerrez/, hostaway/ subdirectories) for idempotency, createServiceClient placement, step.sleep nesting, for-of return-vs-continue, and event registration. Verified exactly one serve() call in app/api/inngest/route.ts and all used events are registered in events.ts.
Next: none — audit complete

## Findings

### Finding 1: turnover-events.ts and booking-events.ts use correct upsert pattern
- File: lib/inngest/functions/turnover-events.ts:239-258, lib/inngest/functions/booking-events.ts:48-65, lib/inngest/functions/booking-events.ts:115-130
- Severity: N/A (informational — good pattern, not a bug)
- Issue: None — these correctly use `.upsert(..., { onConflict: 'source_reference_id,source', ignoreDuplicates: true })`, which is a proper atomic dedup against the owner_transactions unique constraint, better than a check-then-insert TOCTOU pattern.
- Confirmed: yes
- Fix: N/A — use this as the reference pattern when reviewing other files.

### Finding 2 (RETRACTED — false alarm): renderPmAlert prop names
- File: lib/resend/emails/pm-alert.tsx:12-20
- Severity: N/A
- Issue: Verified actual `PmAlertProps` interface — `heading`, `body`, `details`, `table`, `note`, `ctaLabel`, `ctaUrl` are ALL valid optional/required props on the real component. CLAUDE.md's claim that the signature is "NOT heading, body, table, note, pmName" does not match this file's current code. Calls in turnover-events.ts are correct as written. Not flagging further — out of my domain (idempotency) anyway; mentioning only to retract my earlier suspicion.
- Confirmed/Suspected: Confirmed not a bug (read the source file directly).
- Fix: None needed.

### Finding 3: work-order-events.ts — owner_transactions upsert correctly guards against estimated_cost
- File: lib/inngest/functions/work-order-events.ts:184-214
- Severity: N/A (informational)
- Issue: None — `handleWorkOrderCompleted` correctly only posts when `actual_cost` is set (not `estimated_cost`), uses the upsert+ignoreDuplicates dedup pattern, and a code comment in `handleWorkOrderCompletedViaPortal` (lines 258-260) explicitly explains why that function does NOT also post an expense (to avoid racing the same source_reference_id/source pair). This is a well-reasoned, intentional separation of concerns.
- Confirmed: yes
- Fix: N/A

### Finding 4: repuguard-batch-generate.ts — counters mutated in outer function scope across step.run boundaries (replay-safety concern)
- File: lib/inngest/functions/repuguard-batch-generate.ts:43-44, 85, 109, 112-114
- Severity: Medium
- Issue: `generated` and `skipped` are declared in the outer function scope (let generated = 0; let skipped = 0) and mutated *inside* `step.run()` callbacks (`generated++` at line 109, `skipped++` at line 85). Because Inngest replays the entire function body on every step completion/retry, but memoizes the *return value* of already-completed `step.run()` calls (skipping re-execution of the callback body), the increments inside the callback bodies will NOT re-run on replay for already-completed reviews — only for the step(s) actually executing in that invocation. This means `generated`/`skipped` are reconstructed via re-running the whole loop each time the function resumes, but only newly-executing steps mutate the counters; memoized (skipped) steps do not re-increment. Net effect across a full successful run this nets out correctly, but it's a fragile pattern: any future refactor that moves logic between step.run callback and outer scope, or any partial-failure/retry interleaving, risks undercounting `generated`/`skipped` in the final `notify-pm` email body, since that step runs after the loop and reads the closure variables which may not reflect counts from steps memoized in a prior invocation attempt in all Inngest execution model edge cases.
- Confirmed/Suspected: Suspected — the exact replay semantics depend on Inngest's execution model details (step memoization is per run, and a single run's outer function does fully re-execute on each step-boundary resumption, so this is likely fine in practice for a single run). Flagging because mutating shared counters across a step.run boundary inside a loop is a known anti-pattern Inngest's own docs warn about ("non-deterministic side effects must live inside step.run, but variables derived from them and used outside steps can drift") — and because the same pattern recurs in repuguard's `pace-${review.id}` step.sleep calls outside step.run, which is correct, but the counters are a smaller variant of the same general hazard.
- Fix: Compute `generated`/`skipped` counts via a final `step.run('tally-results', ...)` that re-queries `review_responses`/`reviews` by `org_id` and a batch marker (e.g. reviews updated in this run, or count of rows with response_status in ('draft','ready') created since batch start), rather than relying on in-memory counters mutated inside per-item step.run callbacks. This removes any replay ambiguity.

### Finding 5: repuguard-batch-generate.ts notify-pm email idempotency keyed by day, not by batch
- File: lib/inngest/functions/repuguard-batch-generate.ts:130-133
- Severity: Low
- Issue: The notify-pm email's `idempotencyKey` is `repuguard-batch-${org_id}-${requested_by}-${new Date().toISOString().split('T')[0]}` — keyed by org, requester, and *today's date*. If the same org/user triggers two separate repuguard batch-generate runs on the same calendar day (e.g. manually re-triggered after the first batch only processed 25 of 60 pending reviews, since BATCH_LIMIT=25), the second run's PM notification email will be silently deduplicated by Resend's idempotency key and the PM will never be told about the second batch's results.
- Confirmed/Suspected: Confirmed by reading the code — this is a real consequence of date-only keying combined with BATCH_LIMIT pagination, though it is a notification-suppression bug rather than a data-correctness bug.
- Fix: Include a per-run identifier (e.g. the Inngest run ID, or the batch's `reviews[0].id`/count) in the idempotency key, e.g. `repuguard-batch-${org_id}-${requested_by}-${event.id}` (Inngest event ID) so multiple same-day batches each notify independently.

### Finding 6: build-shopping-cart.ts, kroger-connected.ts, auto-assign-turnover.ts — clean idempotency patterns (informational)
- File: lib/inngest/functions/build-shopping-cart.ts:339-361, lib/inngest/functions/kroger-connected.ts:25-105, lib/inngest/functions/auto-assign-turnover.ts:214-280
- Severity: N/A
- Issue: None. These are the strongest examples in the codebase:
  - build-shopping-cart.ts guards the actual Kroger cart-add API call with a `runId`-scoped `org_milestones` row checked before calling `addItemsToKrogerCart`, preventing a retried step from double-adding items to the customer's real Kroger cart (a double-charge-adjacent risk since this is a live external retailer cart).
  - auto-assign-turnover.ts handles the `23505` unique-violation on `turnover_assignments` insert explicitly, treating "already assigned" as a successful idempotent outcome rather than retrying into a duplicate-row error loop, and the `assignment_outcomes` upsert keys on `(turnover_id, crew_member_id)`.
  - kroger-connected.ts is a clean one-shot setup function with no real duplication risk (all writes are idempotent upserts/updates keyed on org_id).
- Confirmed: yes
- Fix: N/A — reference patterns.

### Finding 7: CRITICAL — createServiceClient() called in outer function scope (not inside step.run) across the entire guidebook-*.ts family
- File: lib/inngest/functions/guidebook-sponsor-activated.ts:11, guidebook-sponsor-deactivated.ts:17, guidebook-daily-monitor.ts:13, guidebook-grace-expired-handler.ts:14, guidebook-sponsor-payment-recovered.ts:11, guidebook-guest-opted-in.ts:10, guidebook-stay-extension-handler.ts:15
- Severity: High
- Issue: CLAUDE.md states explicitly: "createServiceClient() inside step.run() only — never in outer function scope." All seven files listed call `const supabase = createServiceClient()` (or `const admin = ...` in some) once at the top of the handler, OUTSIDE any `step.run()`, and then close over that single client instance inside every subsequent `step.run()` callback. This is the exact anti-pattern the project's own constraints document calls out. It matters because Inngest replays the outer function body on every step boundary; while creating a lightweight client instance itself is unlikely to use stale state immediately, this pattern is flagged as forbidden in CLAUDE.md specifically because of past incidents in this codebase (the constraint wouldn't otherwise be called out so prominently), and a client created in module/closure scope can silently carry forward stale auth/connection state across what should be independent, isolated step executions — also makes each step's side effects harder to reason about in isolation when debugging retries.
- Confirmed/Suspected: Confirmed via direct code read — `createServiceClient()` is unambiguously outside `step.run()` in all 7 files.
- Fix: Move `const supabase = createServiceClient()` inside each individual `step.run()` callback that uses it (matching the correct pattern used in turnover-events.ts, work-order-events.ts, inventory-events.ts, booking-events.ts, build-shopping-cart.ts, auto-assign-turnover.ts, ownerrez/*, hostaway/initial-sync.ts — all of which correctly instantiate the client per-step).

### Finding 8: guidebook-guest-opted-in.ts — check-then-act race on door-code SMS dedup
- File: lib/inngest/functions/guidebook-guest-opted-in.ts:38-62
- Severity: Medium
- Issue: The `send-door-code-sms` step reads `door_code_sent_at` from `guidebook_guest_sms_optins` (line 38-42), returns early if already set (line 44), then — if not set — sends the SMS (line 49-52) and only afterward updates `door_code_sent_at` (line 54-61) to mark it sent. If this step is retried after the SMS send succeeds but before (or during) the DB update (e.g. the function crashes, times out, or Inngest retries due to an unrelated transient error after `sendSMS` resolves but before the `update` call completes), the retry will re-read `door_code_sent_at` as still null, and send the SMS a second time to the same guest's phone number. There is no unique constraint or atomic claim (e.g. `UPDATE ... WHERE door_code_sent_at IS NULL RETURNING ...` done before sending, or an `ON CONFLICT DO NOTHING` insert into a separate dedup table) — this is a textbook check-then-act gap on a paid, user-visible external side effect (an SMS to a guest).
- Confirmed/Suspected: Confirmed by reading the code — the check and the write are two separate non-atomic operations bridging an external API call that has no idempotency key of its own (sendSMS call has no idempotency key passed, unlike most resend.emails.send calls elsewhere in the codebase that pass `idempotencyKey`).
- Fix: Convert the "claim" into a single atomic UPDATE before sending: `UPDATE guidebook_guest_sms_optins SET door_code_sent_at = now() WHERE id = optinId AND door_code_sent_at IS NULL RETURNING id` — only send the SMS if that update affected a row (i.e., this invocation won the race). This is the same pattern as `source_reference_id` dedup but applied to a non-owner_transactions table, which is exactly the kind of external-API-side-effect dedup CLAUDE.md's idempotency rule is meant to generalize to.

### Finding 9: More createServiceClient() outer-scope violations — work-order-vendor-assigned.ts, work-order-crew-assigned.ts, work-order-crew-completed.ts
- File: lib/inngest/functions/work-order-vendor-assigned.ts:11, lib/inngest/functions/work-order-crew-assigned.ts:9, lib/inngest/functions/work-order-crew-completed.ts:12
- Severity: High
- Issue: Same violation as Finding 7 — `const supabase = createServiceClient()` is declared at the top of the handler, before the first `step.run()` call, in all three of these work-order-* files. Combined with Finding 7's guidebook-*.ts files, this brings the total count of outer-scope `createServiceClient()` violations to 10 files: guidebook-sponsor-activated.ts, guidebook-sponsor-deactivated.ts, guidebook-daily-monitor.ts, guidebook-grace-expired-handler.ts, guidebook-sponsor-payment-recovered.ts, guidebook-guest-opted-in.ts, guidebook-stay-extension-handler.ts, work-order-vendor-assigned.ts, work-order-crew-assigned.ts, work-order-crew-completed.ts. By contrast, every other function file audited (turnover-events.ts, booking-events.ts, work-order-events.ts [NOT to be confused with the 3 files here], inventory-events.ts, build-shopping-cart.ts, kroger-connected.ts, auto-assign-turnover.ts, ownerrez/*, hostaway/initial-sync.ts, flagged-turnover-wo.ts, repuguard-batch-generate.ts) correctly instantiates `createServiceClient()` fresh inside each `step.run()` callback. This is a consistent, repeated pattern violation, not a one-off.
- Confirmed/Suspected: Confirmed via direct code read of all three files' opening lines.
- Fix: Same as Finding 7 — move the `createServiceClient()` call inside each `step.run()` callback in these three files. Given the volume (10 files now), recommend a project-wide grep-based sweep: `grep -rn "createServiceClient()" lib/inngest/functions/*.ts | grep -v "step.run\|step\.run"` won't reliably catch this via grep alone since it's about *line position relative to step.run*, but a quick manual check is: does `const supabase = createServiceClient()` (or `const admin = ...`) appear before the first `step.run(` in the function body? All 10 files above answer yes.

### Finding 10: ical-sync.ts, ownerrez/initial-sync.ts, cron/*.ts — createServiceClient correctly scoped (informational, contrast to Findings 7/9)
- File: lib/inngest/functions/ical-sync.ts, lib/inngest/functions/ownerrez/initial-sync.ts, lib/inngest/functions/cron/*.ts
- Severity: N/A
- Issue: None — spot-checked these and `createServiceClient()` is correctly called inside each `step.run()` callback, not hoisted to outer scope. This confirms Findings 7/9 are isolated to the specific files listed there rather than a codebase-wide problem, but the 10 affected files span two different feature areas (guidebook lifecycle + work-order crew/vendor assignment notifications), suggesting at least two different authors/sessions introduced the same mistake independently.
- Confirmed: yes
- Fix: N/A

Status: COMPLETE
