# Hostaway Enablement

Hostaway was built and then deliberately switched off (product decision,
2026-07-25). This is the plan to switch it on with **full feature parity** — a
Hostaway org must be able to use every FieldStay feature an OwnerRez or
Hospitable org can.

Decisions taken 2026-08-16:

1. **Auth: per-user API key + Account ID.** No partner/marketplace OAuth. The
   PM enters both from their own Hostaway dashboard.
2. **Incremental sync mirrors the other PMS integrations.** Not a new pattern.
3. **Webhooks yes, if the API allows.** OwnerRez webhooks are already live and
   are the closest template.
4. **Every feature.** Including reviews → RepuGuard.

---

## What already exists

| File | Lines | State |
|---|---|---|
| `lib/integrations/providers/hostaway.ts` | 247 | Complete and functional. Token exchange, paginated listings + reservations. Unregistered. |
| `lib/inngest/functions/hostaway/initial-sync.ts` | 319 | Functional. Properties → bookings → turnovers. Unregistered. |
| `integration_providers` row | — | Already in production: `auth_type: api_key`, `is_active: true` |
| `20260624172104_hostaway_api_key_auth_type.sql` | — | Applied |

So this is not greenfield. It is a re-enable plus the gaps below.

---

## Why it was switched off, and what else is wrong

The disable comments all name one blocker. Reading the code found three more.

**1. No `booking/confirmed` — the documented blocker.** The initial sync
imports properties and bookings and generates turnovers, but never emits the
event, so **nothing posts revenue to `owner_transactions`**. A connected org
would see bookings with no money.

Good news on cost: `booking-events.ts` maps any non-`uplisting` source to
`booking_revenue`, so this needs **no enum change and no migration** — only
adding `'hostaway'` to the `source` union in `lib/inngest/events.ts`. And
`HostawayReservation.totalPrice` means we can pass `actual_total_amount`
rather than falling back to the nights × avg-rate estimate.

**2. The property upsert is hand-rolled and bypasses `upsertNormalizedProperties()`.**
Hospitable's syncs use it; Hostaway's does a raw `.upsert()` on `properties`.
Two consequences, both silent:

- It **overwrites PM edits on every sync** — the shared helper protects
  PM-editable fields and the raw upsert does not.
- It imports properties with **no lat/lng**. `auto-assign-turnover.ts` only
  scores crew proximity when both the property and the crew member have
  coordinates, so every Hostaway property silently drops the distance signal
  and assigns on reliability + capacity alone, with nothing on screen saying
  so. The first live Hospitable org hit exactly this.

**3. The ~6-month token expires with no warning.** `integration-token-refresh.ts`
scans `OAUTH_PROVIDERS = ['hospitable','kroger']` **and** requires
`refresh_token_vault_secret_id IS NOT NULL`. Hostaway matches neither, and
there is nothing to refresh: `hostawayExchangeCredentials()` discards the API
key and only the Bearer token is stored. So this needs a **warn-and-reconnect**
path, not a refresh path. Without it, sync goes silent at month six and the
only thing that notices is `cron/watchdog.ts`.

**4. Owner-blocked calendar time is hardcoded `is_block: false`,** with an
in-code comment saying the mapping is unconfirmed. `/v1/reservations` probably
does not surface manual blocks at all — that is likely `/v1/calendar`. Getting
this wrong either creates turnovers for blocked time or misses blocks entirely.

**5. The `api_key` connect mechanism has never run in production.** Hostaway is
the only api_key provider, so `connectWithApiKey()` and the credential-modal UI
are untested paths. `connectWithApiKey` also duplicates the org-linking logic
that OAuth gets from `finalize-connection.ts` — worth consolidating while it is
being re-enabled rather than after.

---

## Provider-gated sites — the verified "every feature" inventory

Found by grepping every `'ownerrez'` / `'hospitable'` literal in `app/`,
`lib/`, `components/`. Each needs a Hostaway branch or entry.

| # | Site | What breaks without it |
|---|---|---|
| 1 | `lib/inngest/events.ts:39` — `booking/confirmed.source` union | **Compile error.** Typed union; this is the gate. |
| 2 | `lib/integrations/registry.ts` | Provider unresolvable; connect 404s |
| 3 | `app/api/inngest/route.ts` | Sync function never runs |
| 4 | `settings/integrations/actions.ts` — `connectWithApiKey` body | Cannot connect at all |
| 5 | `settings/integrations/actions.ts` — `triggerResync` case | "Trigger Resync" silently no-ops |
| 6 | `integrations-client.tsx` — `HIDDEN_PROVIDER_IDS` | Tile not rendered |
| 7 | `integrations-client.tsx` — credential field config + help text | Modal has no inputs |
| 8 | `integrations-client.tsx:424` — provider `href` | "Manage" link wrong |
| 9 | `setup/pms/page.tsx` — `PMS_PROVIDER_IDS` | Absent from onboarding PMS step |
| 10 | `app/onboarding/onboarding-form.tsx` | Absent from signup PMS picker |
| 11 | `ops/page.tsx` — `REVENUE_AUTOMATION_PROVIDER_IDS` | Ops nudge misreports revenue coverage |
| 12 | `bookings/bookings-calendar.tsx:58` + `bookings-client.tsx:125` | Bookings show unlabeled source |
| 13 | `reviews/reviews-client.tsx:61` | Reviews show unlabeled source |
| 14 | `lib/integrations/refresh-lock.ts` — `RefreshLockProvider` | Reconnect flow cannot take a lock |
| 15 | `lib/inngest/functions/email-trial-lifecycle.tsx:80` | Trial emails misjudge "has connected a PMS" |
| 16 | `components/pricing/PricingSection.tsx` + a `components/hostaway/` page | No Hostaway marketing landing page |

`SAFE_DETAIL_PROVIDERS` in the OAuth callback route is **not** needed —
Hostaway has no browser redirect.

---

## Phases

Phase 4 is deliberately last: every surface it re-enables is a way for a
customer to reach Phases 1–3.

### Phase 1 — make the existing sync correct
- Add `'hostaway'` to `booking/confirmed.source`
- Emit `booking/confirmed`, batched (see `ownerrez/initial-sync.ts` for the
  chunk sizing) with a revenue mode (`hospitable/reservation-sync.ts` already
  solved `'all' | 'new-only'`), passing `actual_total_amount` from `totalPrice`
- Replace the hand-rolled property upsert with `upsertNormalizedProperties()`
- Resolve `is_block` against Hostaway's calendar endpoint
- Token-expiry warning + reconnect email (no refresh is possible)

### Phase 2 — keep it in sync
- `incremental-sync.ts` using Hostaway's `updatedAt` filter. Reference sizes:
  OwnerRez 1240 lines, Hospitable 804. Hostaway's should be smaller.
- Reconciliation cron + handler (OwnerRez ~290, Hospitable ~210 lines)
- Register the reconcile-by-absence pass in
  `unit/guardrails/absence-reconciliation.test.ts`. It qualifies for
  `fetch-fails-loud` as written — `hostawayFetchReservations` already throws on
  a non-ok response rather than returning `[]`, which is the exact defect that
  deactivated a Hospitable org's whole crew roster on 2026-07-18.

### Phase 3 — webhooks
`validateWebhook()` currently rejects everything (`fail('no webhook signing
secret registered yet')`). Hostaway unified webhooks use HMAC-SHA256 with a
secret set at registration.

**Design question to settle against Hostaway's docs first:** OwnerRez verifies
with a single platform-wide credential from env
(`OWNERREZ_WEBHOOK_USER`/`PASSWORD`) plus an IP CIDR allowlist, because we
register one endpoint for one OAuth app. Hostaway registers per account, using
that account's own token. If Hostaway lets us choose the secret at
registration, we can use one platform-wide `HOSTAWAY_WEBHOOK_SECRET` and
**Phase 3 needs no migration at all**. If the secret is server-generated per
webhook, it needs a column → migration → `types/database.ts` in the same commit
→ and applying to the E2E project in the same sitting, or `check-type-drift`
fails looking like a types problem.

Not shipping Phase 3 is survivable: sync latency then equals the cron interval,
which is what OwnerRez lives with today.

### Phase 4 — re-enable
Work the 16-row table above. Add `RLS`-irrelevant; all UI/registry edits.

### Phase 5 — reviews → RepuGuard
Mirror `ownerrez-reviews-sync.ts`. Required by "every feature".

---

## Gates that will fire

- **`absence-reconciliation`** — Phase 2 registration, above.
- **`unbounded-select`** (`lib/inngest/**`) — every new read needs
  `fetchAllRows()`, `.limit()`, or a head-count aggregate.
- **`inngest-insert-idempotency`** — any `.insert()` inside a `step.run` needs
  a dedup story.
- **`inngest-nested-steps`** — no `sendEvent`/`sleep` inside a `step.run`
  callback, including via a helper closing over `step`.
- **`external-fetch-timeout`** — already satisfied; the provider uses
  `PMS_API_TIMEOUT_MS`.
- **`env-schema-coverage`** — any new `HOSTAWAY_*` env var must be declared in
  `lib/env.ts`'s `ENV_SPEC` with a tier and a one-line `why`.
- **Migration lockstep** — if Phase 3 needs a column, apply to production AND
  the E2E project (`syhthijeqlnltufdawyb`) in the same sitting.
