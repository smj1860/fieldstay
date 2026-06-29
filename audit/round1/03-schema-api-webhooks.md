# Schema Naming / API / Webhooks Audit

Status: COMPLETE
Last checkpoint: reviewed all app/api/**/route.ts handlers, all webhook handlers, OAuth connect/callback flow, token-based public vendor/work-order routes, GDPR/account-delete routes, asset export routes, and cross-checked types/database.ts against the three most recent migrations (property_sync_expansion, crew_feedback, vendor_stripe_connect) plus enum usage for txn_category/txn_type/source/wo_status across lib/inngest/functions and app/(dashboard) actions.
Next: none — audit complete

## Findings

### Finding 1: Telnyx webhook has no signature verification
- File: app/api/webhooks/telnyx/route.ts:6-9
- Severity: High
- Issue: The handler has an explicit TODO admitting it does not verify the Telnyx ed25519 webhook signature before processing the request body. Anyone who knows (or guesses) the webhook URL can POST arbitrary STOP/START/UNSUBSCRIBE payloads with any `phone_number`, flipping SMS consent (`guidebook_guest_sms_optins.is_active`) for any phone number in the system without proving the request came from Telnyx.
- Confirmed: Code comment is explicit: `// TODO: verify Telnyx webhook signature (ed25519) before processing — deferred for this session per CLAUDE_55_2 scope.`
- Fix: Implement ed25519 signature verification using Telnyx's `telnyx-signature-ed25519` and `telnyx-timestamp` headers before parsing/acting on the body, consistent with the Stripe webhook pattern (`constructEvent` + fail-closed 400 on bad signature) used elsewhere in this codebase.

### Finding 2: `[provider]` webhook handler (OwnerRez) has no signature/HMAC verification of its own — delegates entirely to `providerAdapter.validateWebhook()`
- File: app/api/webhooks/[provider]/route.ts:48-63
- Severity: Low
- Issue: This is not a bug in the route itself — it correctly fails closed (401) if `validateWebhook()` throws or returns false, and the comment block documents OwnerRez's HTTP Basic Auth scheme. However, the actual validation logic lives in the provider adapter (`lib/integrations/*`), which was outside this read; if any future provider adapter is added to the registry without implementing `validateWebhook()` correctly (e.g. always returning `true`), this route would silently accept unauthenticated webhooks. Flagging as a watch item, not a confirmed defect.
- Confirmed/Suspected: Suspected — the route's own logic is sound; risk is contingent on adapter implementations not reviewed in this pass.
- Fix: When auditing `lib/integrations/registry.ts` and individual provider adapters, verify every adapter's `validateWebhook()` does real cryptographic/credential verification (not a stub returning true).

### Finding 3: `wo_status` narrowing cast in vendor-portal completion route silently excludes `quote_requested`
- File: app/api/work-orders/[token]/complete/route.ts:181
- Severity: Low
- Issue: `status_from: workOrder.status as 'pending' | 'assigned' | 'in_progress'` casts to a 3-value subset of the 6-value `wo_status` enum (missing `quote_requested`, `completed`, `cancelled`). This is currently safe at runtime because the preceding atomic update on line 93-102 only claims rows `.in('status', ['pending', 'assigned', 'in_progress'])`, so `workOrder.status` can never actually be `quote_requested` by the time this cast executes. Purely a type-safety smell, not a runtime bug today — but if the claimable-status list on line 102 is ever widened (e.g. to allow completing directly from `quote_requested`), this cast would silently mask a real type mismatch instead of failing the build.
- Confirmed: Confirmed as written; not exploitable today because of the line-102 guard.
- Fix: Use the shared `WoStatus` type (`types/database.ts`) for this cast instead of a hand-rolled literal union, so future widening of the claim filter is caught by the type checker.

## Clean / Verified (no issues found)

The following areas were specifically audited per the assignment brief and found correct:

- **`.from('memberships')` bug**: Zero occurrences in app/lib source. Already fully remediated (confirmed by grep and corroborated by prior audit docs `audits/00-SUMMARY.md`, `audits/01-security-multitenant-isolation.md`).
- **`assigned_crew_id` vs `assigned_crew_member_id`**: The deprecated column does NOT actually exist in `types/database.ts`'s `WorkOrder` interface as checked here — grep only found it in `types/database.generated.ts` (the read-only reference snapshot, not imported anywhere) and in `supabase/schema_reference.sql`/migrations (where it legitimately still exists as a deprecated-but-present DB column per the schema comment "work_orders has BOTH assigned_crew_id (deprecated, FK retained...) and assigned_crew_member_id"). No application code reads/writes `assigned_crew_id`. (Note: sibling audit `audits/04-business-logic-tech-debt.md` from a prior session flagged this differently — worth reconciling, but in the current `types/database.ts` and `app/` as of this pass, `assigned_crew_id` is not referenced in app code.)
- **`inventory_count_draft_items` vs `inventory_count_items` column naming**: Both tables are used correctly and consistently in their respective code paths — `app/api/crew/inventory-count/route.ts` uses `item_id`/`counted_qty` for drafts and `inventory_item_id`/`quantity_counted` for the legacy direct-commit path; `app/(dashboard)/inventory/actions.ts` likewise uses `inventory_item_id`/`quantity_counted` for `inventory_count_items`. No cross-contamination found.
- **`work_order_notes` non-existent table**: Zero occurrences anywhere in source; all status-log writes correctly use `work_order_updates`.
- **`supabase.raw()` / `.modify()`**: Zero occurrences anywhere in `app/` or `lib/`.
- **Stripe webhook signature verification**: Both `app/api/webhooks/stripe/route.ts` and `app/api/webhooks/stripe-connect/route.ts` correctly call `stripe.webhooks.constructEvent()` with the appropriate secret (`STRIPE_WEBHOOK_SECRET` vs `STRIPE_CONNECT_WEBHOOK_SECRET`) and fail closed with 400 on verification failure, before touching the DB. Both dedupe via `stripe_processed_events` (keyed `connect:${event.id}` for the Connect webhook to avoid ID collision with the platform webhook).
- **OAuth CSRF state verification**: `app/api/integrations/[provider]/connect/route.ts` and `.../callback/route.ts` implement a solid double-layered CSRF defense — a DB-backed one-time `oauth_states` row (validated, expiry-checked, and deleted immediately on use) plus a belt-and-suspenders httpOnly cookie. Open-redirect guard on `return_to` (`safePath.startsWith('/')`) is present.
- **Token-based public vendor/work-order portal routes** (`vendor-connect/[token]/onboard`, `work-orders/[token]/complete`, `work-orders/[token]/quote`): All validate the token against the DB, check expiry, check `portal_enabled`/`status` state, and use atomic conditional updates (`.eq('status', 'pending')` style claims) to prevent double-submission races. The WO completion route additionally cross-checks that the assigned vendor's `org_id` matches the work order's `org_id` before creating an invoice — good defense against a stale/cross-tenant vendor_id.
- **`txn_category`/`txn_type`/`owner_transactions.source` enum usage**: All usages across `lib/inngest/functions/{inventory,work-order,turnover,booking}-events.ts`, `app/(dashboard)/bookings/actions.ts`, `app/(dashboard)/maintenance/actions.ts`, and `app/api/webhooks/stripe/route.ts` use exact canonical enum values (`restock`, `maintenance`, `cleaning_fee`, `booking_revenue`, `wo_completion`, `inventory_purchase`). The `uplisting_booking` source value (initially appeared unused in a narrow grep) is in fact correctly wired in `lib/inngest/functions/booking-events.ts:16` (`source === 'uplisting' ? 'uplisting_booking' : 'booking_revenue'`).
- **Recent migration → types/database.ts sync**: Spot-checked the 3 most recent schema-changing migrations (`20260628013427_property_sync_expansion.sql` adding 8 columns to `properties`; `20260628000000_crew_feedback.sql` creating `crew_feedback`; `20260626142311_vendor_stripe_connect.sql` adding 5 `stripe_connect_*` columns to `vendors` plus `work_order_line_items.vendor_submitted`). All new columns/tables are present in `types/database.ts` with correct nullability.
- **GDPR export, account deletion, asset CapEx/CPA export routes**: All correctly call `requireOrgMember()` or equivalent session check first, scope every query by `org_id`/`user.id`, and never leak the service role key or raw DB errors to the client.
- **Crew PWA API routes** (`crew/inventory-count`, `crew/issue-reports`, `crew/feedback`, `crew/turnovers/[id]/complete`, `crew/work-orders/[id]/complete`, `crew/push-subscribe`): All follow the documented inline auth pattern (`supabase.auth.getUser()` → `crew_members` lookup by `user_id` → 403 if not found), and all subsequent queries are scoped by `org_id` derived server-side, never trusting client-supplied org/property IDs without a server-side ownership check.


