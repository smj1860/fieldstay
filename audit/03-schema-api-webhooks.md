# Schema Naming / API / Webhooks Audit — Round 2

Status: IN PROGRESS
Last checkpoint: Verified Telnyx webhook ed25519 fix, OwnerRez/[provider] webhook + adapter validateWebhook implementations, wo_status cast fix, memberships/assigned_crew_id/work_order_notes/supabase.raw greps (all clean), recent migrations (20260625-20260628) cross-checked against types/database.ts (all in sync).
Next: final write-up.

## Findings

### Finding 1: Stray migration file breaks naming convention — `new asset_type_standards_rls`
- File: supabase/migrations/new asset_type_standards_rls
- Severity: Medium
- Issue: This file has no timestamp prefix (`YYYYMMDDHHMMSS_description.sql`) and no `.sql` extension at all — it's literally named `new asset_type_standards_rls` (with a space). CLAUDE.md's migration workflow section is explicit: "write a new file in `supabase/migrations/` named `YYYYMMDDHHMMSS_description.sql`". A file like this may be silently skipped by `supabase db push` (which matches on `.sql` extension) or applied out of order relative to its actual intent, since there's no timestamp to anchor it after `20260628013427_property_sync_expansion.sql`. Its content (enabling RLS + locking down INSERT/UPDATE/DELETE on `asset_type_standards`, allowing authenticated SELECT) looks correct and harmless in isolation, but the question is whether it was ever actually applied to the live DB, since `supabase db push` filename matching may reject it.
- Confirmed/Suspected: Confirmed file exists with this exact malformed name; suspected (not verified against live DB) that this causes drift — could not query live Supabase project state in this pass to confirm whether RLS is actually enabled on `asset_type_standards` live.
- Status: FIXED — the malformed file no longer exists; it has been renamed/replaced with a properly timestamped `supabase/migrations/20260629114714_asset_type_standards_rls_tracking.sql`, which follows the `YYYYMMDDHHMMSS_description.sql` convention and sits correctly in migration order after the 2026-06-28 batch.
- Fix: None needed — already applied. (Original fix recommendation retained below for historical record.) Rename to `20260629000000_asset_type_standards_rls.sql` (or appropriate timestamp) and re-apply via `supabase db push` / `apply_migration` to guarantee it's tracked, then verify live RLS state on `asset_type_standards` via `get_advisors` or `list_tables`.

### Finding 2: `TELNYX_WEBHOOK_PUBLIC_KEY` undocumented in `.env.example`
- File: .env.example (missing entry); referenced in app/api/webhooks/telnyx/route.ts:15
- Severity: Low
- Issue: The new Telnyx signature verification depends on `process.env.TELNYX_WEBHOOK_PUBLIC_KEY`, but `.env.example` only documents `KROGER_CLIENT_ID`/`KROGER_CLIENT_SECRET` (per CLAUDE.md's required-env list) and has no Telnyx section at all. If unset in any environment, `verifyTelnyxSignature()` returns `false` unconditionally (safe failure — no legitimate webhooks get silently accepted), but the webhook will appear broken with no documentation pointing at the missing var.
- Confirmed/Suspected: Confirmed via grep — zero Telnyx entries in `.env.example`.
- Status: FIXED — `.env.example:136-146` now has a full "TELNYX" section documenting `TELNYX_API_KEY`, `TELNYX_MESSAGING_PROFILE_ID`, `TELNYX_FROM_NUMBER`, and `TELNYX_WEBHOOK_PUBLIC_KEY`, with a comment explaining that inbound webhook signature verification fails closed without the public key set.
- Fix: None needed — already applied. (Original fix recommendation retained below for historical record.) Add `TELNYX_WEBHOOK_PUBLIC_KEY=` (and ideally `TELNYX_API_KEY` if used elsewhere in `lib/sms/telnyx.ts` for outbound sends) to `.env.example` with a comment pointing to Telnyx Portal → API Keys → Ed25519 Public Key, matching the comment already in the route file.

### Finding 3 (informational — re-flagging round-1 watch item, now resolved): Provider adapter `validateWebhook()` stubs fail closed correctly
- File: lib/integrations/providers/hostaway.ts:67-73, lib/integrations/providers/kroger.ts:80-82, lib/integrations/providers/ownerrez.ts:141-163
- Severity: Low (no actual issue — documenting verification)
- Issue: Round 1 flagged this as a "watch item" — risk that a future provider adapter might stub `validateWebhook()` to always return `true`. Checked all three current adapters: Hostaway and Kroger both explicitly `return false` (fail closed, webhooks not yet supported), and OwnerRez does real HTTP Basic Auth verification with `timingSafeEqual()` constant-time comparison against `OWNERREZ_WEBHOOK_USER`/`OWNERREZ_WEBHOOK_PASSWORD`, throwing (caught by the route, mapped to 401) if those env vars are unset. No stub returns `true`.
- Confirmed/Suspected: Confirmed — read all three provider files in full.
- Status: STILL OPEN as a structural risk (nothing enforces this contract at compile time — a future adapter could still stub `true`), but no current instance of the bug exists.
- Fix: Same as round 1 — no code change needed today; consider a lint rule or code-review checklist item for new adapters.

## Round 1 Verification

### Round 1 Finding 1: Telnyx webhook has no signature verification
- File: app/api/webhooks/telnyx/route.ts:6-9 (now lines 1-41 in current file)
- Status: **FIXED**
- Evidence: Current code (read in full) implements `verifyTelnyxSignature()` using `createVerify('ed25519')` over `${timestamp}|${rawBody}` (matches Telnyx's documented signed-payload format), reads headers `telnyx-signature-ed25519` and `telnyx-timestamp` (correct header names per Telnyx docs), reads the raw body via `req.text()` BEFORE any parsing (critical — signature must be computed over exact bytes, and this is done correctly), fails closed returning 401 if verification fails or `TELNYX_WEBHOOK_PUBLIC_KEY`/signature/timestamp are missing, and only parses JSON after the signature check passes. This is functionally equivalent in rigor to the Stripe `constructEvent()` pattern referenced as the standard in CLAUDE.md. No regressions found — STOP/START handling logic downstream is unchanged and still correctly scoped by `phone_e164` + `is_active` guard conditions to prevent duplicate audit log writes.
- Minor gap (see Finding 2 above): the required `TELNYX_WEBHOOK_PUBLIC_KEY` env var isn't documented in `.env.example`.

### Round 1 Finding 2: `[provider]` webhook handler delegates validation to adapters — watch item
- File: app/api/webhooks/[provider]/route.ts:48-63
- Status: **STILL OPEN as documented watch item, but verified no current defect** (see Finding 3 above). The route's own fail-closed logic (try/catch wrapping `validateWebhook()`, 401 on throw or `false`) is unchanged and correct. All three current adapters fail closed correctly.

### Round 1 Finding 3: `wo_status` narrowing cast in vendor-portal completion route
- File: app/api/work-orders/[token]/complete/route.ts:181 (now line 182)
- Status: **FIXED**
- Evidence: Current code imports `WoStatus` from `@/types/database` (line 4) and casts `status_from: workOrder.status as WoStatus` (line 182) — the full 6-value enum type, not the previous hand-rolled 3-value union (`'pending' | 'assigned' | 'in_progress'`). This means if the claimable-status filter on line 103 (`.in('status', ['pending', 'assigned', 'in_progress'])`) is ever widened, the type checker will no longer silently mask a mismatch, exactly per round 1's recommended fix.

## Areas Re-Verified Clean (no new issues)

- **`.from('memberships')`**: Zero occurrences (grepped `--include="*.ts" --include="*.tsx"` across entire repo).
- **`assigned_crew_id` in app code**: Zero occurrences in `app/` or `lib/` (still only present in deprecated DB column / schema_reference.sql / generated types, as in round 1).
- **`work_order_notes`**: Zero occurrences anywhere.
- **`supabase.raw()` / `.modify()`**: Zero occurrences in `app/` or `lib/`.
- **Recent migrations vs types/database.ts**: Spot-checked all migrations from `20260625000001_communication_logs_dedup_key.sql` through `20260628013427_property_sync_expansion.sql` (6 migrations, the most recent batch since round 1's last check). Every new column/table is present and correctly typed in `types/database.ts`:
  - `communication_logs.dedup_key` → present (line 954)
  - `property_owners.share_capital_plan`, `property_assets.replacement_status` → present (lines 175, 1223)
  - `guidebook_configurations`, `guidebook_sponsors`, `guidebook_property_configs`, `guidebook_guest_sms_optins` tables + `bookings.guidebook_token` → all present (lines 227-228, 1094-1200+, Database type entries 1378-1381)
  - `guidebook_sponsors.offer_type/offer_value/offer_item` → present (lines 1146-1149)
  - `crew_feedback` table → present (line 268)
  - `bookings.guidebook_pre_arrival_email_sent_at` → present (line 228)
  - `properties.house_manual/checkout_instructions/amenities/smoking_allowed/pets_allowed/max_pets/events_allowed/min_renter_age` → all present (lines 154-161)
- **Stripe webhooks**: Not re-read line-by-line this pass given no flagged regression risk and no related commit in this round's changelist; round 1's verification stands.
- **OAuth CSRF / token-based portal routes**: No changes detected relevant to this domain since round 1; spot check of `app/api/work-orders/[token]/complete/route.ts` (read in full above) confirms the vendor-org cross-check (lines 49-59) and atomic claim-on-status (.in() filter, lines 94-103) are both still intact.

Status: COMPLETE
