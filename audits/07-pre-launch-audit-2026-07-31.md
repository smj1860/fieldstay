# FieldStay Second Pre-Launch Audit — 2026-07-31

**Scope:** Deliberately aimed at code the 2026-07-30 audit did **not** read.
That pass covered `lib/inngest/**`, `lib/dexie/**`, `app/api/**`, `proxy.ts`,
recent migrations, and dashboard `page.tsx` **read** paths. This one targets the
Server Actions (39 `'use server'` files, ~197 exported actions), the
high-privilege org/billing/team surface, and the ~128 `lib/**` modules outside
inngest/dexie.

**Method:** Partitioned auditors run in parallel, each carrying the same
seven-dimension brief, each told to treat the first audit's files as out of
scope unless a trace led back in. Findings verified against source and against
the live Supabase project `vpmznjktllhmmbfnxuvk` (read-only). No files were
modified during the audit.

**Baseline:** audited at `b2decc6` — merged `main`, i.e. *after* the ~94
findings of audit 1 were remediated.

> **Status: WAVE 1 COMPLETE.** All three wave-1 dimensions reported. Wave 2
> (migration history, components/pages, integrations/emails, e2e suite quality,
> adversarial verification) is outstanding.

---

## Verdict so far: **NOT LAUNCH-READY**

No cross-tenant data leak was found in either dimension — that is a real
result, not an absence of looking. RLS is genuinely load-bearing, entitlements
are derived server-side from the Stripe price id, and no client-supplied
`org_id` appears anywhere in scope. The damage is concentrated in **flows that
have never been executed**, **privilege gaps where RLS was assumed to be the
only gate**, and **silent truncation at the scale this product targets**.

| Dimension | Verdict | High | Med | Low |
|---|---|---|---|---|
| Org / billing / team / onboarding actions | Not ready | 5 | 8 | 6 |
| maintenance / turnovers / inventory actions | Conditional go | 4 | 11 | 7 |
| `lib/**` outside inngest/dexie (124 modules, ~18.2k LOC) | Conditional go | 3 | 12 | 10 |

All three dimensions independently found **no cross-tenant read or write path**.
The `lib/**` pass verified this rather than assuming it: every exported helper
taking an `orgId` was traced to its call sites (all `membership.org_id` or an
Inngest payload), `requireOrgMember`/`requireOrgRole`/`requireCrewMember` cannot
return a membership for the wrong org, and the LLM tool surface in
`lib/support/account-tools.ts` takes zero model-supplied arguments. It also
probed `lib/security/url-guard.ts` for bypasses beyond its documented
DNS-rebinding residual and **found none**.

---

## Launch blockers

### A1 — Team invite acceptance is dead on arrival (token format mismatch)
`app/accept-invite/[token]/actions.ts:12`

```ts
token: z.string().uuid(...)
```

The live `org_invites.token` default is `encode(gen_random_bytes(32),'hex')` —
a **64-character hex string, not a UUID**. The page renders the invite form
fine (no validation there); every submit then returns *"Invite link is invalid
or expired."*

Production holds **0 `org_invites` rows**, so this path has never once been
exercised. The first real team invite at launch fails. Nothing in the test
suite, CI, or the first audit could have caught it — a flow that has never run
has no failing signal to notice.

**Fix:** `z.string().regex(/^[0-9a-f]{64}$/)`. One line.

### A2 — Door-code RPCs bypass the admin/manager write gate
`store_property_door_code` / `read_property_door_code` (live, `SECURITY DEFINER`)

`EXECUTE` is granted to `authenticated`, and the only guard inside is
`p_org_id NOT IN (SELECT get_user_org_ids())` — org **membership, any role**.
But `properties_update` RLS requires admin/manager. So a `viewer` can:

- **read the decrypted door code** — `properties/actions.ts:249`
  (`revealPropertyDoorCode`) is gated on `requireOrgMember` only; and
- **overwrite it** — in `properties/actions.ts:209` and
  `setup/details/actions.ts` the property UPDATE silently matches 0 rows (not
  an error), and the RPC then succeeds regardless.

**Fix:** change the RPC guard to
`is_org_member(p_org_id, ARRAY['admin','manager'])` (migration required) and
add `requireOrgRole` at both call sites.

### A3 — Billing actions have no role gate
`settings/actions.ts:663` (`openBillingPortal`), `:1056` (`createCheckoutSession`)

Both use `requireOrgMember()` only. Any org member — including a `viewer` —
can open the Stripe billing portal and cancel or downgrade the subscription,
replace the payment method, and read invoice history (billing-address PII).
The neighbouring `disconnectIntegration:200` is correctly owner/admin-gated,
so this is drift, not a missing convention.

**Fix:** `requireOrgRole(['admin'])`. One line each.

### A4 — Checklist broadcast is silently broken, and its target is never org-verified
`lib/inngest/functions/checklist-broadcast.ts:70-75`,
`setup/checklist/actions.ts:191,206`

The upsert uses `onConflict: 'property_id,org_id'`, but **no unique index on
`checklist_templates(property_id, org_id)` exists** in the live DB (verified —
only the pkey and two plain btrees). PostgREST returns `42P10`, the step
returns false, and `broadcast` is 0 — while the action returns
`{ broadcast: targetPropertyIds.length }` *before* Inngest has run, so the PM
is told it worked.

Critically, `broadcastChecklistTemplate` never verifies that
`targetPropertyIds` belong to the caller's org. The source read *is*
org-scoped, so nothing exfiltrates today — but **adding the missing unique
index without also adding that ownership check converts a dead feature into a
live cross-tenant write.**

**Fix:** add the unique index **and** an
`.in('id', targetPropertyIds).eq('org_id', …)` check, and report the real
count.

### A5 — Two of three work-order completion paths never post the owner expense
`maintenance/actions.ts:1434-1443` (`bulkUpdateWorkOrderStatus`),
`maintenance/work-order-actions.ts:130-146` (`markWorkVerified`)

Only the single-WO path (`updateWorkOrderStatus:490-504`) fires
`work-order/completed`, which is what upserts the `owner_transactions`
maintenance expense and calls `advanceScheduleAfterCompletion`. The bulk path
and the WO-detail "verify" button do not.

A PM bulk-completing 10 recurring work orders at month end leaves the owner
P&L short 10 maintenance expenses **with no error anywhere**, and every source
schedule stays on its old `next_due_date` — so the cron re-creates the same
work order. `bulkUpdateWorkOrderStatus` additionally never sets
`completed_date` and never writes a `work_order_updates` row.

**Fix:** extract the completion side effects into one helper called by all
three paths; have the bulk path `.select()` the completed rows back and fan out
one event each.

### A6 — `max_rows = 1000` silent truncation in dashboard actions
Audit 1 identified this as its highest-impact systemic finding but swept only
`lib/inngest/**`. Three live sites remain:

- `inventory/actions.ts:400-404` (`applyTemplateToProperties`) — the
  existing-items dedupe set is built from a truncated read, so at 50 properties
  × 115 items (5,750 rows) **duplicate inventory items are inserted** into
  every property past the first 1,000, silently, on every template apply.
- `maintenance/actions.ts:1715-1720` (`broadcastMaintenanceTemplate`) — same
  shape for the `property_id::name` skip-set; past 1,000 rows it re-creates
  schedules that already exist, and there is no unique constraint to catch it.
- `inventory/actions.ts:586-591` (`generateAggregatedPurchaseList`) —
  `.limit(2000)` carrying the comment *"well above any real org's inventory"*.
  CLAUDE.md's own target user (10–50 properties × 115 catalog items) exceeds it.

**Fix:** `fetchAllRows()` from `lib/inngest/paginate.ts` is already exported and
usable here; or move the dedupe onto a partial-unique index with
`ignoreDuplicates`.

### A7 — The quote-request flow routes around the vendor hard-block
`maintenance/actions.ts:161-163`, `:811-880`, `:896-949`

`isVendorHardBlocked` is checked **only** when `!request_quotes`. In quote
mode, `quote_vendor_ids` is passed to `sendQuoteRequestEmails` with no org
check and no compliance check; `sendQuoteRequests` never validates the vendor
ids either; and `approveQuoteRequest` — the point where the vendor is actually
assigned, `portal_enabled` set and a completion token minted — **never calls
`isVendorHardBlocked` at all**.

So: RFQ a vendor whose COI expired 46+ days ago → they quote → approve →
assigned and dispatched. `lib/vendors/compliance.ts`'s own header states every
assignment path must check this.

### A8 — `clonePropertySetup` destroys target data non-atomically
`properties/clone-actions.ts:37-56, 90-93, 114-135, 156-177`

Deactivates all of the target's inventory items, then inserts — **and never
captures the insert's error**. Deletes the target's checklist sections, then
re-creates them one at a time with `if (sErr || !newSection) continue`. Same
shape for maintenance schedules. Any failure after the destructive step leaves
the target property wiped, and the action still returns `{ success: true }`.

---

## `lib/**` — highest-severity items

Full detail in the dimension report; these are the ones with real blast radius.

### B1 — Kroger token refresh has no mutual exclusion, unlike Hospitable
`lib/integrations/providers/kroger-token.ts:22-99`

`hospitable-token.ts:88-156` added `acquireRefreshLock()` explicitly because
*"refresh-token rotation makes concurrent refreshes for the SAME user unsafe:
the loser's now-superseded refresh token is what ends up in Vault."*
`refreshKrogerToken()` has the identical shape — reads the refresh token,
exchanges it, conditionally writes back a rotated one — and **no lock at all**.
Both the proactive refresh cron and reactive `getValidKrogerToken()` can enter
it concurrently for one user.

Two concurrent cart builds → the loser's superseded refresh token lands in
Vault → the next refresh fails → the PM's Kroger connection is dead until they
manually reconnect, surfacing as an unrelated `NonRetriableError` at cart-build
time. **Fix:** reuse the Hospitable lock keyed `kroger:refresh-lock:${userId}`.

### B2 — Token rotation is two non-atomic writes (both providers)
`hospitable-token.ts:227-240`, `kroger-token.ts:81-97`

`storeIntegrationToken()` then `storeIntegrationRefreshToken()` are separate
RPCs. If the first succeeds and the second fails, Vault holds the **new** access
token and the **old** refresh token — which the provider has already rotated
away. Hospitable's 60-minute grace hides it for an hour, then the connection is
permanently broken. The retry loop at `:201-213` retries only the *exchange*,
not the write, so the documented mitigation doesn't cover this. **Fix:** one RPC
writing both secrets in a single transaction.

### B3 — Door and lockbox codes are written verbatim into `audit_events.metadata`
`lib/properties/normalize.ts:70`, `lib/properties/upsert-normalized.ts:181`

```ts
export const REDACTED_CONTENT_FIELDS: ReadonlySet<string> = new Set(['wifi_password'])
// "Other content fields are plain text and safe to log."
```

`access_instructions` is the check-in field — it is where door codes and lockbox
combinations live. Every PMS sync that changes it persists **both old and new
values** into `audit_events.metadata`, alongside `house_manual`.

This contradicts CLAUDE.md's "Never put PII or secrets in the `metadata` field",
and the codebase elsewhere treats these as maximally sensitive: `lib/sms/
telnyx.ts:239` redacts SMS bodies *specifically because* "bodies can contain
door codes", and there is a dedicated `property.door_code.viewed` audit action.
Mitigating: `audit_events_select` is owner-only, same-org — so this is durable
plaintext secrets at rest, not a cross-tenant leak. **Fix:** add
`access_instructions` and `house_manual` to `REDACTED_CONTENT_FIELDS`.

### B4 — `lib/audit.ts` writes fail silently — the try/catch cannot catch them
`lib/audit.ts:189-212`

```ts
try { await admin.from('audit_events').insert(entries.map(...)) } catch (err) { … }
```

PostgREST returns errors in the resolved `{ error }` object; it does not throw.
The `try/catch` catches only transport failures. A rejected insert — grant
regression, constraint violation, malformed metadata — is a **no-op with zero
signal**, on the append-only log whose entire purpose is answering "what
happened" during an incident.

### B5 — `resendVendorConnectInvite` orphans a live Stripe Express account
`lib/stripe/vendor-connect-invite.ts:203-241`

`ensureVendorConnectInvited` was fixed for exactly this (`:133-137`: *"Persisted
immediately — independent of whether the email send below succeeds"*). **The
resend twin was not.** It holds `accountId` in a local, sends the email, and
only persists afterwards — so a Resend failure throws past the persist, leaving
a real Stripe Express account with `metadata.vendor_id` that FieldStay has no
record of. Every subsequent resend creates another one. CLAUDE.md cites this
file as a *closed* example of the orphan-on-email-failure mode; half of it
still is.

### B6 — Guidebook slugs are globally unique, racy, and the failure is swallowed
`lib/guidebook/slug.ts:30-34,66-69`, `lib/guidebook/sync.ts:57-68`

`guidebook_property_configs_slug_key` is a **globally unique** index (verified
live). Slug generation does an unfiltered cross-tenant `SELECT slug` and picks
the first free one — read-then-write, no lock. The subsequent upsert uses
`onConflict: 'org_id,property_id'`, which does **not** absorb a `slug` unique
violation, and its error is discarded.

Two orgs onboarding a property named "Lake House" concurrently both compute
`lake-house`; the loser's whole batch is rejected with 23505 and **none** of
that org's guidebook configs are created. The PM sees an empty Guidebook tab
with nothing logged.

### B7 — Silent-failure cluster on exactly the surfaces that report problems
- `lib/integrations/health.ts:73-86` — all three reads destructure `{ data }`
  only, so an outage renders as "no integrations", indistinguishable from a
  healthy account with none connected — on the one surface whose job is
  reporting whether data sources are broken.
- `lib/ical/conflict-detection.ts:35-41,60-67` — the bookings read and both
  flag-writes discard errors, so a failed read returns `[]` → zero conflicts →
  the PM is never told two guests are booked into the same property on the same
  night. "The query broke" and "no conflicts" are the same value.
- `lib/turnovers/generator.ts:517-522,573` — both checklist inserts discard
  errors. The comment at `:552-560` documents a real past incident where this
  exact batch insert failed wholesale. The fix for the cause shipped; the
  detection did not.

### B8 — Scale items
- `lib/integrations/providers/hospitable-owner.ts:81-88` — platform-wide
  unbounded `integration_connections` select. Past 1,000 active connections,
  `resolveHospitableOwner()` never sees #1001, the webhook is dropped with a
  200, and that tenant's bookings silently stop arriving.
- `lib/turnovers/generator.ts:114-129,187-222,502-573` — ~7 sequential round
  trips per turnover. A property with 150 future bookings issues ~1,050 serial
  queries on first import; a 50-property org's first sync is tens of thousands.
- `lib/support/account-tools.ts:239-252`, `lib/notifications.ts:193-198` —
  below-par filters applied in JS to a capped, **unordered** page (300 / 200).
  A 1,000-item org gets an arbitrary slice, so the support bot answers "3 items
  below par" when the answer is 40. Wrong, not slow.

---

## The systemic finding: a 0-row UPDATE is not an error

`orgs_update` is admin-only. A manager's UPDATE therefore matches zero rows —
which PostgREST reports as success. So a manager saves org settings, sees
"Saved", and nothing changed: `settings/actions.ts:39` (`updateOrgSettings`),
`:82` (`updateSlackWebhook`), `:959`, `:994`, `:1027`.

This is the same mechanism that makes A2 exploitable quietly, and it is the
highest-value systemic fix in this audit: `.select('id').maybeSingle()` on
these writes, treating `null` as a permission error.

---

## Medium (abridged — full detail in the agent reports)

**Concurrency / correctness**
- `bulkUpdateTurnoverStatus` (`turnovers/actions.ts:680-718`) still has the
  exact race fixed in its single-turnover sibling, whose comment at `:314-325`
  documents both the bug and the fix.
- `updateWorkOrderStatus` TOCTOU (`maintenance/actions.ts:453-504`) — double
  completion advances `next_due_date` two cycles.
- Inventory count approval applies quantities **before** claiming the draft,
  with no `.eq('status','pending')` guard (`inventory/actions.ts:492-527`).
- `removeCrewFromTurnover` read-then-write race leaves a turnover `assigned`
  with zero crew, off the needs-assignment board.
- Crew activation race orphans an `auth.users` row with no `crew_members` link.
- `approveQuoteRequest` has no rollback: a failed WO update leaves the work
  order unassigned with every quote closed.

**Privilege / validation**
- `anonymizeGuestData` (`settings/privacy/actions.ts:18-24`) is service-role
  with **no role gate** — any member can irreversibly scrub guest PII org-wide.
- Mass assignment: client object spread straight into three writes
  (`maintenance/actions.ts:1880-1884`, `:2064-2074`,
  `work-order-actions.ts:22-27`). TS types are not runtime validation.
- `assigned_crew_member_id` never verified in-org (`maintenance/actions.ts:131,
  179, 292-299`); the live `work_orders_select` policy has a crew branch, so a
  foreign crew UUID makes that WO readable by another tenant's crew user.
- `changePassword` (`settings/actions.ts:114`) never verifies the current
  password — session theft becomes account takeover.
- No rate limit on any email-sending action (`inviteTeamMember`,
  `generatePortalToken`, `resendVendorConnectInvite`, `inviteAllUninvitedCrew`).
  `checkLimit` is already the house pattern; three are one line each.

**Data integrity**
- Regenerating an owner portal token doesn't clear `revoked_at`
  (`owners/actions.ts:88`), so revoke→regenerate emails a permanently dead link.
- `createCheckoutSession` doesn't check for an existing active subscription →
  two subscriptions on one customer, org billed twice.
- Per-item UPDATE loops whose errors are discarded entirely
  (`inventory/actions.ts:211-222`, `:508-519`) — also an N+1 that evades the
  guardrail only because `.map(` here isn't `.map(async`.
- No unique index on `quote_requests(work_order_id, vendor_id)` → a double
  click sends one vendor two RFQs with two live tokens.

**PII in audit metadata** (CLAUDE.md forbids it): `owners/actions.ts:141`
(`owner_email`), `crew-invite/[token]/actions.ts` (`email`),
`owners/actions.ts:268` (`amount`) — while `owners/actions.ts:436`
deliberately omits email with a comment saying why.

---

## Suggested guardrail additions

Per the repo's meta-rule, each of these classes is mechanically checkable and
would have caught a finding above:

1. **Extend `unbounded-select.test.ts` beyond `lib/inngest/**` to
   `app/(dashboard)/**/actions.ts`.** This alone catches all of A6.
2. **`onConflict` targets must have a matching unique index.** A4 was a dead
   feature for exactly this reason, and the check is a join between the source
   text and `pg_index`.
3. **Zod token schemas must match the column's live default shape.** A1 is a
   format mismatch between a `z.string().uuid()` and a hex column default.
4. **Every `SECURITY DEFINER` RPC granted to `authenticated` must guard with
   `is_org_member(...)`, not bare `get_user_org_ids()`,** when the table it
   writes requires a role. That is A2 exactly.
5. **Widen the two existing guardrails from one directory to `lib/`**, with a
   shrink-only baseline (same ratchet as `tailwind-color-ratchet`):
   `unbounded-select.test.ts:102` scans `['lib/inngest']` only — B8's Hospitable
   truncation is the direct consequence — and `service-role-org-scope.test.ts:94`
   scans `['app/(dashboard)']` only, leaving ~45 `createServiceClient()` sites in
   `lib/**` with no mechanical org-scope check.
6. **`try/catch` around a Supabase call is not error handling.** B4 is the
   canonical case: PostgREST resolves with `{ error }` rather than throwing, so
   the catch block is dead code. This is checkable — a `try` whose body
   `await`s a `.from(...)` chain without destructuring `error`.

### A guardrail that can be silenced by refactoring

`n-plus-one-loops.test.ts:50` matches `.from('table')…select|insert`
**textually inside the loop body**. B8's turnover generator evades it simply by
calling named helpers (`insertStandaloneTurnover`, `snapshotChecklist`) — and
the account-deletion refactor's own EXCEPTIONS comment notes it did the same
thing deliberately. A guardrail that extraction defeats will drift back open
without anyone noticing. Worth reworking to follow one level of local call
indirection, or at minimum documenting the limitation in the file.

---

## What this audit says about the first one

Every finding here sits in code the first pass never read. The first audit's
conclusion — *"drift, not absence: the correct implementation already exists
and the defect is the second call site"* — holds again, and more sharply:

- A5's correct implementation is `updateWorkOrderStatus`, in the same file.
- A6's is `fetchAllRows()`, already written and exported.
- A7's is `isVendorHardBlocked`, called correctly on the non-quote branch
  twenty lines away.
- A3's is `disconnectIntegration`, correctly role-gated in the same file.
- The bulk-turnover race's fix is documented in a comment in the same file.

The recurring shape is not ignorance of the right pattern. It is that nothing
mechanically forces the second call site to adopt it — which is the argument
for the guardrails above rather than for another round of manual fixes.
