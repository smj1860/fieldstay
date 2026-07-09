# Future Remediation

Known gaps identified during self-audits that have **not** been fixed yet —
either lower priority than what was in progress at the time, or needing a
bit more design than a one-line change. Each entry has enough context to
pick back up without re-deriving the finding from scratch.

---

## 1. `checklist_instances_crew_update` RLS policy isn't column-scoped

**File:** `supabase/migrations/20260708234410_checklist_inventory_confirmation.sql`

The crew `UPDATE` policy on `checklist_instances` is gated only on
`turnover_id` (via `turnover_assignments` → `crew_members` → `auth.uid()`).
It was added so crew could write `completed_at`/`completed_by_crew_id` for
"Confirm Checklist Complete", but Postgres RLS is row-level, not
column-level — a crew session calling Supabase directly (outside the app's
own UI, which does allowlist the fields it sends in
`lib/dexie/syncService.ts`) could legally overwrite any column on a row
it's allowed to touch, including `org_id`, `template_id`, `template_snapshot`,
or `status`.

This mirrors the pre-existing `checklist_instance_items` crew policy's
shape exactly, so it's consistent with established precedent, not a new
deviation — but it's a real gap worth closing.

**Suggested fix:** a `BEFORE UPDATE` trigger (`SECURITY DEFINER`, same
pattern already used in this migration for
`set_checklist_instance_started_at`) that rejects or reverts changes to
protected columns when the acting role is a crew member and not a PM.

---

## 2. `ensureVendorConnectInvited` has a TOCTOU race across its three callers

**File:** `lib/stripe/vendor-connect-invite.ts`

> **Update:** the single-invocation partial-failure case (a Resend failure
> orphaning the just-created Stripe account, because `stripe_connect_account_id`
> was only persisted *after* the email send, in a combined update with
> `stripe_connect_invite_sent_at`) has been fixed — the account id is now
> persisted immediately after creation, and the completion check is based
> solely on `stripe_connect_invite_sent_at`, so a retry reuses the existing
> account instead of creating a second one. The **concurrent-invocation**
> race described below is still open.

Re-reads the vendor row fresh before acting, but there's no lock between
that read and the `stripe.accounts.create()` + email send + `UPDATE`. It's
now called from three independent triggers:
- the nightly cron (`lib/inngest/functions/cron/vendor-connect-onboarding.ts`)
- work order dispatch (`lib/inngest/functions/work-order-dispatch.ts`)
- indirectly, the "Resend Payment Setup Email" button
  (`resendVendorConnectInvite` in `app/(dashboard)/vendors/actions.ts`,
  which shares the same read-then-act shape without the guard at all)

A vendor added and immediately dispatched a work order in the same window
the cron also picks them up — or a PM clicking "Resend" right as dispatch's
auto-invite fires — can create two Stripe Express accounts and send two
invite emails, with one account silently orphaned (last `UPDATE` wins on
`stripe_connect_account_id`).

**Suggested fix:** a partial unique index on `vendors` (e.g. on
`stripe_connect_account_id` where not null) won't prevent the double
`accounts.create()` call itself — better to serialize via
`SELECT ... FOR UPDATE` inside a transaction, or a Postgres advisory lock
keyed on `vendor_id`, wrapping the check-and-act in `ensureVendorConnectInvited`
and `resendVendorConnectInvite` both.

---

## 3. `DexieProvider`'s `useEffect` closure is doing too much (structural)

**File:** `lib/dexie/context.tsx`

Eight async helpers (`syncAssignedTurnovers`, `pullChecklistsForTurnovers`,
`pullTurnoversOnly`, `refreshChecklistSubscription`, `syncWorkOrders`,
`syncMessages`, `syncCrewAvailability`, `run`) are all declared inside one
`useEffect(() => {...}, [userId])`, now ~350 lines. No single function
exceeds nesting depth 4 or an obvious complexity ceiling, but a couple of
the `.on('postgres_changes', ..., () => {...})` callbacks inside
`refreshChecklistSubscription` sit at exactly 4 levels of function nesting
(`DexieProvider → useEffect → refreshChecklistSubscription → .on callback`).

**Suggested fix:** lift these to module-level functions taking
`(supabase, userId)` as params — improves readability and makes them
unit-testable without mounting the provider.

---

## 4. `SyncEngine.uploadOne()` growing via flat if-chains

**File:** `lib/dexie/syncService.ts`

Dispatches on 6 `table === '...'` branches (one, `checklist_instances`,
added most recently). Each branch is simple and non-nested — no individual
complexity/depth violation — but the function is trending toward the point
where a per-table handler map (`Record<string, (mutation) => Promise<void>>`)
would read more cleanly than sequential early-return `if`s. Not urgent;
worth doing the next time a 7th table is added.

---

## 5. Dev-mode CSP blocks Turbopack hydration — browser testing is broken repo-wide

**File:** `next.config.ts`

The `Content-Security-Policy` header (`script-src 'self' 'wasm-unsafe-eval'`,
no `'unsafe-inline'` or nonce) blocks Turbopack's inline hydration scripts
entirely in dev mode, producing
`PAGEERROR: Invariant: Expected a request ID to be defined for the document via self.__next_r`
and React never mounting. Confirmed by temporarily patching `headers()` to
return `[]` when `NODE_ENV !== 'production'` — the page mounted and worked
once that header was removed — then reverting the patch since it was only
for local verification, not a real fix to ship.

This means **no one can currently exercise the app in a browser against
`next dev`** without disabling the CSP locally first. Production is
unaffected (this is a dev-only symptom of the same header applying in both
modes).

**Suggested fix:** either add a nonce-based `script-src` that Turbopack's
dev-mode hydration script can use, or conditionally relax `script-src` to
include `'unsafe-inline'` only when `NODE_ENV !== 'production'`.

---

## 6. Vendor/compliance mutation actions don't check role, only org membership

**Files:** `app/(dashboard)/vendors/actions.ts` (all exports),
`app/(dashboard)/maintenance/actions.ts`, `app/(dashboard)/maintenance/work-order-actions.ts`

Every server action here starts with `requireOrgMember()`, which confirms
org membership but not role — so a `viewer` role member can currently call
`resendVendorConnectInvite`, `deleteComplianceDocument`,
`verifyComplianceDocument`, `bulkUpdateWorkOrderStatus`, etc., the same as
an `admin`/`manager`. This is a long-standing, app-wide pattern (not
introduced by any of the recent vendor-payment work) — flagging it here
because it came up while auditing those same files, not because it's new.

**Suggested fix:** decide whether `viewer` should be read-only across the
app and, if so, add an `is_org_member(org_id, ARRAY['admin','manager'])`-style
role check (matching the RLS convention already used at the DB layer) to
each mutating action — probably worth doing as one pass across the whole
`app/(dashboard)` actions surface rather than file-by-file.
