# Idempotency / Deduplication / Inngest Audit — Round 2

Status: IN PROGRESS
Last checkpoint: Verified single serve() call, all 10 round-1-flagged createServiceClient files now fixed, the guest-SMS atomic claim fix, and the repuguard counter/idempotency-key fix. Found 9 ADDITIONAL files with the same outer-scope createServiceClient() bug that round 1 missed entirely.
Next: finalize write-up, append SUMMARY.md

## Findings

### Finding 1: MISSED IN ROUND 1 — 9 more files call createServiceClient() outside step.run()
- File: lib/inngest/functions/inventory-order-email-cron.ts:22, lib/inngest/functions/ownerrez/initial-sync.ts:47, lib/inngest/functions/guidebook-sms-evening-cron.ts:21, lib/inngest/functions/cron/checklist-signals.ts:16, lib/inngest/functions/cron/work-order-ops.ts:23, lib/inngest/functions/guidebook-pre-arrival-email-cron.ts:14, lib/inngest/functions/guidebook-stay-extension-cron.ts:12, lib/inngest/functions/build-shopping-cart.ts:115 (plus correctly-scoped instances at 43/53/340 in the same file), lib/inngest/functions/guidebook-sms-morning-cron.ts:21
- Severity: High
- Issue: All 9 files declare `const supabase = createServiceClient()` (or similarly named) at the top of the handler body, before the first `step.run()` call, then close over that single instance inside every subsequent `step.run()` callback — the exact anti-pattern round 1 flagged as Finding 7/9 and that the "Fix Inngest client scoping" commit (aa3da30) targeted. That commit fixed the 10 files it named but did not do a codebase-wide sweep, leaving this pattern in at least 9 other files untouched. Notably this includes `build-shopping-cart.ts` (live Kroger cart API calls) and three guidebook SMS cron files (paid Telnyx SMS sends) and `cron/work-order-ops.ts` (auto-WO creation + PM email alerts) — all side-effect-heavy functions where stale/shared client state across step boundaries is the exact risk CLAUDE.md's rule is meant to prevent.
- Confirmed/Suspected: Confirmed via direct code read of all 9 files — `createServiceClient()` appears before the first `step.run(` token, verified by both regex byte-offset comparison and manual reading of file headers.
- Status: MISSED (round 1 audited file-by-file but apparently did not check beyond the 10 files it found in its first sweep, or these files were added/never re-checked; commit history shows none of the 9 files were touched by `aa3da30`)
- Fix: Move `const supabase = createServiceClient()` inside each individual `step.run()` callback in all 9 files, matching the corrected pattern in the round-1-fixed files (guidebook-sponsor-activated.ts, work-order-crew-assigned.ts, etc.). Recommend a follow-up grep-assisted manual sweep across the ENTIRE `lib/inngest/functions/` tree (including subdirectories) rather than spot-checking — this round found these 9 by mechanically comparing byte offsets of `createServiceClient()` calls against the first `step.run(` call in every file, which round 1's manual approach apparently missed.

### Finding 2: VERIFIED FIXED — guidebook-guest-opted-in.ts SMS race now uses atomic claim
- File: lib/inngest/functions/guidebook-guest-opted-in.ts:44-56
- Severity: N/A (informational — confirms fix)
- Issue: None remaining. The `send-door-code-sms` step now performs an atomic `UPDATE guidebook_guest_sms_optins SET door_code_sent_at = now() ... WHERE id = optinId AND door_code_sent_at IS NULL RETURNING id` before sending the SMS. If the UPDATE affects 0 rows (`claimed` is null), the function returns `{ skipped: 'already_sent' }` without sending. On SMS send failure, the claim is explicitly rolled back (`door_code_sent_at: null`) before throwing, allowing a legitimate retry. This is a correct, race-free claim pattern.
- Confirmed/Suspected: Confirmed by direct code read.
- Status: FIXED
- Fix: N/A

### Finding 3: VERIFIED FIXED — repuguard-batch-generate.ts counter and idempotency-key issues resolved
- File: lib/inngest/functions/repuguard-batch-generate.ts:46, 113-114, 121-122, 128, 144
- Severity: N/A (informational — confirms fix)
- Issue: None remaining. `generated`/`skipped` counts are now derived from `results: Array<{ generated: boolean }>` populated by each step.run's return value (pushed at line 114, outside the step.run callback), then tallied via `.filter()` at lines 121-122 — eliminating the prior in-callback outer-counter-mutation hazard. The notify-pm email's idempotency key now includes `batchRunId` (`reviews[0]?.id`) in addition to org_id and date (line 144: `repuguard-batch-${org_id}-${date}-${batchRunId}`), so a second same-day batch run with a different first-review-id will notify independently instead of being silently deduped by Resend.
- Confirmed/Suspected: Confirmed by direct code read.
- Status: FIXED
- Fix: N/A

### Finding 4: Informational — step.sleep/step.run nesting and for-of return-vs-continue clean across codebase
- File: lib/inngest/functions/*.ts and subdirectories (ownerrez/, hostaway/, cron/)
- Severity: N/A
- Issue: None found. Surveyed all files containing `step.sleep` (email-subscriber-checkin.ts, repuguard-batch-generate.ts, turnover-events.ts, work-order-events.ts, ownerrez/incremental-sync.ts, ownerrez/ownerrez-reviews-sync.ts, cron/vendor-connect-onboarding.ts) — in every case `step.sleep`/`step.sleepUntil` is called at the top level of the function body or a for-of loop body, never nested inside a `step.run()` callback. Spot-checked `ownerrez-reviews-sync.ts:51` specifically since it sits inside a try/catch following a `step.run()` call — confirmed the `step.sleep` is in the catch block at the top level, not inside the failed step.run's callback. No `for...of` loop inside a `step.run()` callback was found using bare `return` to skip an iteration (the loops that do exist inside step.run bodies, e.g. hostaway/initial-sync.ts:96, only build in-memory maps/arrays and don't use return/continue at all).
- Confirmed: yes
- Status: STILL OPEN — N/A, this is a clean-bill finding, no remediation needed.
- Fix: N/A

### Finding 5: Informational — single serve() call and event registration intact
- File: app/api/inngest/route.ts, lib/inngest/events.ts
- Severity: N/A
- Issue: None. Exactly one `export const { GET, POST, PUT } = serve({...})` call exists in route.ts, with all ~70 functions registered in its array, including the 12 guidebook functions and all 3 previously-flagged work-order-* files. Cross-referenced every `event: '...'` trigger string in `lib/inngest/functions/**/*.ts` against `lib/inngest/events.ts` — all are registered except the built-in Inngest system event `inngest/function.failed` (expected, not user-defined, used by on-failure.ts as a dead-letter handler). Cross-referenced every `inngest.send({ name: '...' })` call site against events.ts — all registered, including `integration/connection.revoked` which only appears in a commented-out line (app/api/webhooks/[provider]/route.ts:125) and is not actually sent anywhere live.
- Confirmed: yes
- Status: STILL OPEN — N/A, clean.
- Fix: N/A

### Finding 6: Informational — owner_transactions upserts remain consistently correct
- File: lib/inngest/functions/turnover-events.ts:239-258, work-order-events.ts:184-214, inventory-events.ts:1-35, booking-events.ts:48-65/115-130
- Severity: N/A
- Issue: None. Every `owner_transactions` write across all 4 financial-automation functions uses `.upsert(..., { onConflict: 'source_reference_id,source', ignoreDuplicates: true })`. This matches CLAUDE.md's idempotency rule exactly and is consistent with round 1's Finding 1 reference pattern — no regressions found in this area.
- Confirmed: yes
- Status: STILL OPEN — N/A, clean.
- Fix: N/A

### Finding 7: Informational — purchase_order creation idempotency intact, Hostaway/OwnerRez O(n²)/N+1 fixes verified
- File: lib/inngest/functions/inventory-events.ts:140-183, lib/inngest/functions/hostaway/initial-sync.ts:86-99
- Severity: N/A
- Issue: None. `create-purchase-order` step checks `source_count_id` for an existing PO before inserting (lines 143-149), correctly skipping duplicate PO + purchase_order_items creation on retry. Separately verified the "Hostaway O(n²) lookup" fix mentioned in the commit history: hostaway/initial-sync.ts:93 now builds a `Map` (`listingById`) for O(1) lookups instead of a `.find()` inside a loop — the for-of loop at line 96 only populates an in-memory id map (no return/continue concern, not a DB write). Properties upsert at line 77 correctly uses `onConflict: 'external_id,external_source'`.
- Confirmed: yes
- Status: STILL OPEN — N/A, clean / fix verified.
- Fix: N/A

Status: COMPLETE

## Round 1 Verification

| Round 1 Finding | File(s) | Status Now | Evidence |
|---|---|---|---|
| Finding 1 (informational — upsert pattern) | turnover-events.ts, booking-events.ts | Still correct | Confirmed in Finding 6 above — pattern unchanged and still consistently applied. |
| Finding 3 (informational — WO completion guard) | work-order-events.ts:184-214, 258-260 | Still correct | Re-read the file; the `actual_cost`-only posting and the comment explaining why `handleWorkOrderCompletedViaPortal` does not double-post are both still present and correct. |
| Finding 4 (Medium — repuguard outer-scope counters) | repuguard-batch-generate.ts | **FIXED** | Counters now derived from `results` array of step.run return values (lines 46, 113-114, 121-122), not mutated inside callbacks. See Finding 3 above. |
| Finding 5 (Low — repuguard notify-pm idempotency key keyed only by date) | repuguard-batch-generate.ts:130-133 (orig) | **FIXED** | Idempotency key now includes `batchRunId` (`reviews[0].id`), line 144. See Finding 3 above. |
| Finding 6 (informational — clean patterns) | build-shopping-cart.ts, kroger-connected.ts, auto-assign-turnover.ts | Still correct, BUT build-shopping-cart.ts itself has the createServiceClient outer-scope bug (see Finding 1 above) — round 1 praised this file's idempotency pattern (org_milestones runId guard) without noticing the separate client-scoping violation at line 115. | Partially missed — the specific idempotency guard praised is still correct and present, but round 1 did not flag this file under Finding 7/9 despite the bug being present. |
| Finding 7 (High — createServiceClient outer scope, 7 guidebook files) | guidebook-sponsor-activated.ts, guidebook-sponsor-deactivated.ts, guidebook-daily-monitor.ts, guidebook-grace-expired-handler.ts, guidebook-sponsor-payment-recovered.ts, guidebook-guest-opted-in.ts, guidebook-stay-extension-handler.ts | **FIXED** — all 7 now call createServiceClient() inside each step.run() callback. | Verified via grep on all 7 files; createServiceClient lines all appear after/inside step.run( lines. |
| Finding 8 (Medium — guest-SMS check-then-act race) | guidebook-guest-opted-in.ts:38-62 (orig) | **FIXED** | See Finding 2 above — atomic UPDATE...WHERE...IS NULL claim now in place with rollback on send failure. |
| Finding 9 (High — createServiceClient outer scope, 3 work-order files) | work-order-vendor-assigned.ts, work-order-crew-assigned.ts, work-order-crew-completed.ts | **FIXED** — all 3 now call createServiceClient() inside step.run() callbacks. | Verified via grep; consistent with Finding 7 fix. |
| Finding 10 (informational — ical-sync/ownerrez/cron correctly scoped) | ical-sync.ts, ownerrez/initial-sync.ts, cron/*.ts | **PARTIALLY WRONG / MISLEADING** — round 1 claimed these were "correctly scoped" as a contrast case, but this round found `ownerrez/initial-sync.ts:47`, `cron/checklist-signals.ts:16`, and `cron/work-order-ops.ts:23` (all three explicitly named in round 1's "spot-checked, confirmed clean" list) actually DO have createServiceClient() outside step.run(). Round 1's spot-check of these specific files was incorrect. | See Finding 1 above — same files round 1 said were clean. |

**Net summary:** Round 1's 3 substantive bugs (repuguard counters, repuguard idempotency key, guest-SMS race) are confirmed fixed. The 10-file createServiceClient sweep was correctly fixed for the 10 files it identified, but round 1's own "contrast/clean" spot-check (Finding 10) was wrong for at least 3 of the files it named as clean (ownerrez/initial-sync.ts, cron/checklist-signals.ts, cron/work-order-ops.ts), and 6 additional files with the same bug were never identified at all in round 1 (inventory-order-email-cron.ts, guidebook-sms-evening-cron.ts, guidebook-pre-arrival-email-cron.ts, guidebook-stay-extension-cron.ts, build-shopping-cart.ts, guidebook-sms-morning-cron.ts). This round's Finding 1 supersedes round 1's Finding 10.
