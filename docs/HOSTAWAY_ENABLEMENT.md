# Hostaway Enablement

> **REVISED 2026-08-16, after Hostex shipped.** The original version of this
> plan sized Phase 2 at "3–5 days mirroring OwnerRez's 1240-line and
> Hospitable's 804-line incremental syncs." That is no longer the shape of the
> work. Hostex went live end to end in the 24 hours this was written, and in
> doing so extracted three shared modules that did not exist before:
> `shared/reservation-pipeline.ts`, `shared/property-onboarding.ts` and
> `shared/reconcile-shell.ts`. Hostex's own reservation sync is **103 lines**
> because everything after "fetch and map" is now provider-agnostic.
>
> So Hostaway is being **rebuilt on the Hostex skeleton**, not repaired. The
> 2026-07-25 implementation's four defects (below) are all consequences of
> bypassing shared writers that now exist, so going through them is the fix.
>
> One correction to the original text: it claimed Hostaway "imports properties
> with no lat/lng." That was wrong — the hand-rolled upsert did write
> `lat: listing.lat ?? null`, and Hostaway is in fact the best-supplied of the
> three providers, returning structured address fields AND coordinates. The
> claim came from a comment in `upsert-normalized.ts` about *normalizers*, and
> Hostaway had none. The real property-side defect is the invented room count.

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

All four are now built. What remains is the webhook ROUTING half (auth is
live; tenant attribution needs one real delivery body) and netting owner
revenue — which needs a live payload too, and now has a second reason to:
Hostaway documents webhook payloads as omitting data that "comes in later",
which is exactly what financial fields are, so netting has to come from an API
re-fetch regardless of what a delivery happens to contain.

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

### Phase 1 — rebuild the sync path on the shared spine ✅ DONE
- `lib/integrations/providers/hostaway.mappers.ts` — the mapping judgment,
  extracted from the old sync. Room counts nullable (no more `?? 1`),
  coordinates passed through, 0/0 rejected, blank strings normalized to null.
- `'hostaway'` added to `ReservationProvider` and `booking/confirmed.source`.
  The provider label in `reservation-pipeline.ts` became a lookup instead of a
  ternary chain — with three providers the chain's fallback would have logged
  every Hostaway sync as `[Hospitable:…]`.
- `hostaway/reservation-sync.ts` — fetch + map, then `runReservationPipeline`.
  Discriminated `HostawayFetchMode` (`window` | `ids`) so a webhook run and a
  cron run cannot be half-specified.
- `hostaway/initial-sync.ts` — rewritten, not patched: shared property writer,
  shared checklist/guidebook onboarding, `revenueMode: 'all'`, 12 months of
  history (Hostaway's endpoint defaults to 90 days).
- Tests: 39, split so the judgment is tested where it lives — pure mapper tests
  plus orchestration assertions. Six regression guards canaried by breaking
  what they protect.

**`is_block` resolved by precedent, not investigation.** It stays `false`,
documented the way Hostex documents the same absence: manually-blocked owner
time does not surface through `/reservations` at all — it lives on the calendar
endpoints — and syncing those is a later phase for both providers. This
replaces the old `⚠️ Unconfirmed` comment with a decision.

**Still open from Phase 1:** the token-expiry warning + reconnect path. No
refresh grant exists, so there is no Hostex template for it.

**Known caveat, deliberately shipped:** `actual_total_amount` is Hostaway's
`totalPrice`, which is the GUEST-FACING GROSS. Hostex nets commission off;
Hostaway's typed shape has no commission or payout field to subtract. This
overstates owner revenue by the channel's cut (~3% Airbnb, up to ~15%
Booking.com). Gross still beats the `nights * avg_nightly_rate` fallback, which
is unanchored rather than merely high — so it ships named in
`extractHostawayActualTotal()`, flagged in `events.ts`, and asserted in a test
that will fail when someone types the payout field.

### Phase 2 — keep it in sync
- `reservation-sync.ts` already handles both fetch modes, so this is the
  reconcile **cron + handler** via `shared/reconcile-shell.ts`. Reference:
  `hostex/reservation-reconcile-cron.ts` (86 lines) and its handler (141).
- Register the reconcile-by-absence pass in
  `unit/guardrails/absence-reconciliation.test.ts`. It qualifies for
  `fetch-fails-loud` as written — `hostawayFetchReservations` already throws on
  a non-ok response rather than returning `[]`, which is the exact defect that
  deactivated a Hospitable org's whole crew roster on 2026-07-18.
- No separate `incremental-sync.ts`: that file only exists for OwnerRez and
  Hospitable because they predate the shared pipeline.

### Phase 3 — webhooks

**The scoping question is settled, and the answer overturns what this doc
originally said.** It claimed Hostaway uses HMAC-SHA256 with a secret set at
registration, and flagged "per-connection secret vs platform-wide" as the open
question that decided whether a migration was needed. That came from a comment
in `hostaway.ts` which was simply wrong.

Checked against api.hostaway.com/documentation on 2026-08-17: unified webhook
registration takes **URL (mandatory), Login (optional), Password (optional)**,
and deliveries carry those in the request's authentication header. It is HTTP
Basic Auth with credentials **we choose**. Consequences:

- `ownerRezProvider.validateWebhook` is the template, near-verbatim —
  constant-time compare of a user/pass pair from env, with an optional
  source-IP allowlist in front of it.
- **No migration.** One platform-wide `HOSTAWAY_WEBHOOK_USER` /
  `HOSTAWAY_WEBHOOK_PASSWORD` covers every tenant, because the same pair is
  supplied on every registration. Both must be declared in `lib/env.ts`.
- `handleWebhookEvent` maps reservation created/modified/cancelled onto
  `syncHostawayReservations` with `fetchMode: { kind: 'ids', ... }`, which
  already exists.

**Shipped 2026-08-18: the AUTH half.** `hostawayProvider.validateWebhook` is
live, on a `validateBasicAuthWebhook` helper now shared with OwnerRez (extracted
rather than copied — it is ~30 lines of security code where a copy is a place
for one half of a credential pair to drift). `HOSTAWAY_WEBHOOK_USER` /
`_PASSWORD` / `_IP_CIDRS` are declared in `lib/env.ts`. 14 tests, with the two
rules that pass a naive test canaried: the first-colon parse (a `split(':', 2)`
truncates a colon-containing password and then compares equal against its own
prefix) and the empty-allowlist default (empty must mean "no IP restriction",
never "reject everything").

**Still blocked: which TENANT a delivery belongs to.** The generic route
attributes by `payload.user_id` / `payload.account_id` / `payload.data.user.id`
— all snake_case, while Hostaway's API is uniformly camelCase, so none is
likely to match. Guessing is not a small risk here: falling back to an
arbitrary active connection is the cross-tenant misattribution
`hospitable-owner.ts` exists to prevent. **One real delivery body settles it.**

Two things Hostaway's own notes settle in the meantime (2026-08-18):

- Payloads are INCOMPLETE BY DESIGN — "data that come in later are not
  provided" — and Hostaway explicitly recommends calling the API afterward for
  details not in the webhook. Our `fetchMode: { kind: 'ids' }` re-fetch is
  therefore the correct shape, not merely a convenient one.
- Only events ticked in the webhook configuration fire, so registration must
  select the reservation events.

**RESOLVED 2026-08-18 — webhooks are dropped, and replaced by something
better.** Chased to a conclusion against Hostaway's own docs source
(github.com/Hostaway/api, the Slate repo api.hostaway.com/documentation is
built from):

- Webhooks are real and per-account — created from the dashboard or "a public
  API request", not a partner feature. But the API reference documents **no
  unified-webhook endpoint and no payload schema**; the only webhook page in
  the entire reference is a conversation-message delivery LOG. Without a
  payload shape there is no way to know which field identifies the ACCOUNT,
  and guessing that is a cross-tenant misattribution risk.
- The same reference DOES document `latestActivityStart` / `latestActivityEnd`
  plus `sortOrder=updatedOn` on GET /reservations — a genuine changed-since
  filter.

So an hourly incremental sweep replaces the webhook, and is arguably the
better answer regardless: Hostaway documents webhook payloads as INCOMPLETE
("data that come in later are not provided") and tells consumers to re-read
through the API, so the API read was always going to be the source of truth.
See `hostaway/incremental-sync-cron.ts` (hourly, deterministic per-connection
jitter) and `incremental-sync-handler.ts` (cursor by activity date).

**A real defect fell out of the chase.** Every Hostaway reservation fetch was
sending `dateFrom`, which is NOT a parameter GET /reservations accepts — the
documented filters are `arrivalStartDate`, `departureStartDate` and
`latestActivityStart`. An unrecognised query parameter is ignored rather than
rejected, so the initial sync's "12 months of history" and the reconcile's
"1 month back" were both fictions and the reconcile re-read the whole account
daily. Nothing broke visibly because the error direction was MORE data than
asked for — until MAX_PAGES, where it becomes a hard failure on a large
account. Fixed to the documented names.

Sync latency without webhooks is now ~1 hour, not the 24 hours this section
previously assumed.

### Phase 4 — re-enable
Work the 16-row table above. Add `RLS`-irrelevant; all UI/registry edits.

### Phase 5 — reviews → RepuGuard ✅ DONE

Unblocked by the `GET /v1/reviews` reference. `hostawayFetchReviews` +
`hostawayReviewToNormalized` + `hostaway/reviews-sync.ts`, wired into both the
initial sync and the daily reconcile, firing `repuguard/batch_generate.requested`
from inside the sync so a third caller cannot forget it.

Simpler than the Hostex equivalent in two ways: a Hostaway review has a real
`id` (so `external_id` is that id, where Hostex has to key on
`(reservation_code, property_id)`), and carries `guestName` directly (where
Hostex back-fills it by joining bookings on property + check-in + check-out).

**The mapper drops most of what comes back, and that is the normal case.**
`reviews.rating` and `reviews.review_text` are both NOT NULL, and Hostaway
returns a row from the moment a review is SCHEDULED — status `awaiting`, rating
and `publicReview` both null. Storing those needs invented values, and a
fabricated 0-star review with empty text would then be handed to RepuGuard to
draft a public reply to. So the guard is on CONTENT, not on the status name: a
status allowlist would have to be guessed and would silently start dropping real
reviews the first time Hostaway added one.

Also dropped: `host-to-guest` (that is us reviewing the guest — importing it
would ask RepuGuard to reply to ourselves) and cancelled reviews.

One naming trap worth knowing: reviews say **`listingMapId`** where
`/reservations` says **`listingId`**. Same listing, inconsistent API.

### Netting owner revenue (task #21)

`extractHostawayActualTotal` returns `totalPrice`, the guest-facing GROSS, and
the caveat in `events.ts` says the typed shape carries nothing to net against.
That is now only half true: the API changelog names `hostChannelFee`,
`guestChannelFee`, `otaPaymentProcessingFee`, `paymentServiceProcessingFee`,
`cancellationPayout` and `airbnbPayoutSum`. The NAMES are confirmed; their exact
semantics are not, and an owner statement is the wrong place to guess which
subset makes up the host's net. Type them against a live reservation payload,
then subtract — the test in `unit/integrations/hostaway-mappers.test.ts` pins
the current gross behaviour and will fail when that happens, which is the
point.

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
