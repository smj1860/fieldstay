# Lodgify — enablement checklist

**Status: built, held inactive.** Every part of the integration exists —
adapter, API client, mappers, initial sync, daily reconcile, webhook route and
handler — and none of it is reachable by a PM. `integration_providers.lodgify`
has `is_active = false` (`20260910143000_lodgify_integration_provider.sql`).

The reason is narrow and worth stating precisely, because "unverified" is doing
a lot of work in this document: **no Lodgify account has ever been connected to
FieldStay, and `docs.lodgify.com` refuses automated fetches** (Cloudflare
challenge), so every response shape in `lib/integrations/providers/
lodgify.types.ts` was written from Lodgify's published reference and
third-party integration guides rather than from a payload anyone has seen.

That is a weaker footing than Hostex (checked against its OpenAPI document) or
Hostaway (checked against a published field list), and the code is written for
it — see "What a wrong guess costs" below.

---

## What Lodgify gives us, and what it does not

| Capability | Lodgify | Used here |
|---|---|---|
| Properties, room types | ✅ `GET /v2/properties` | Property import |
| Bookings | ✅ `GET /v2/reservations/bookings` | Bookings, revenue, turnovers |
| One booking by id | ✅ `GET /v2/reservations/bookings/{id}` | Webhook re-read |
| Webhooks | ✅ subscribe / list / unsubscribe | Held off — see below |
| Rates & quotes | ✅ | No consumer |
| Guest messaging | ✅ | No consumer |
| Key codes | ✅ on the booking | Not yet — a real opportunity, see "Later" |
| Reviews | ❌ no such resource | — |
| Staff / teammates | ❌ no such concept | — |
| Calendar blocks | On availability endpoints, not `/bookings` | Not synced |
| Revoking an API key | ❌ **no endpoint at all** | See "Disconnect" |

**Auth** is `X-ApiKey`, an account-wide key the PM generates themselves at
**Settings → Public API** in Lodgify. No OAuth app, no partner program, no
approval, no app-level credential of ours. **Their Lodgify plan must include
Public API access** (Professional and up); a Starter customer cannot produce a
key at all, and Lodgify answers a valid key on a plan without access with a
403 — which is why `apiKeyConnectErrorMessage` gives that case its own
sentence instead of "invalid key".

---

## Before flipping `is_active`

Work these through with the first real Lodgify account. Each item names the
file that changes.

### 1. Property shape — `lodgify.types.ts`, `lodgify.mappers.ts`
- [ ] Does `GET /v2/properties` return `{ count, items }` or a bare array?
      (Both are handled; confirm which, and delete the dead branch.)
- [ ] Field names: `name` / `internal_name`, `address` / `city` / `state` /
      `zip`, `latitude` / `longitude`, `timezone_name`, `is_active`.
- [ ] Are `bedrooms` / `bathrooms` / `max_people` on the property, on
      `rooms[]`, or neither? The mapper reads both places and maps absence to
      null — confirm it is finding them.
- [ ] Are coordinates numbers or strings? (Both are accepted.)

### 2. Booking shape — same two files
- [ ] `arrival` / `departure`, or different names? Dates or timestamps?
- [ ] The exact `status` vocabulary. Documented as
      Booked / Tentative / Open / Declined. **A status the mapper does not
      recognise reports to Sentry and lands as `tentative`** — check Sentry
      after the first sync, because a mapper that disagrees with the provider
      disagrees about every booking, not one.
- [ ] `total_amount` — is it gross, and in the property's currency?
- [ ] **The money breakdown.** Nothing currently nets a channel commission out
      of the total (see `lodgifyBookingToNormalized`'s doc comment). Once the
      breakdown is confirmed, net it there — every owner ledger improves
      without another file changing.
- [ ] Is there a real owner-block / owner-stay flag? `is_owner_stay` is a
      guess; absence is treated as a paying stay.
- [ ] What does the bookings list do with cancelled bookings — omit them, or
      return them with `is_deleted` / `canceled_at`?

### 3. The bookings query — `lodgify-api.ts`
- [ ] `stayFilter=DateRange` + `stayFilterDateFrom` / `stayFilterDateTo` is
      what the client sends. Confirm those parameter names, and confirm the
      filter is on the STAY window rather than the booking-creation date.
- [ ] `page` / `size`, 1-based, max 50. Confirm, and confirm what a page
      beyond the end returns.

### 4. Rate limits — `lib/rate-limit.ts`
- [ ] `lodgifyApiLimiter` is set at **60/min per connection**, far under the
      ~750/min published figure. That is deliberate under-spend while the real
      ceiling is unverified. Read the response headers on a full backfill and
      raise it to 90% of the true limit.

### 5. Webhooks — the actual open question
- [ ] **Does a delivery carry ANY authentication?** A signature header, a
      shared secret, a token echoed back? Nothing is documented. If one
      exists, add the check to
      `app/api/webhooks/lodgify/[token]/route.ts` — it sits on top of the URL
      token, it does not replace it.
- [ ] What does a real payload look like? Specifically: **what is the booking
      id field called?** `extractBookingId` tries `booking_id`, `id`,
      `booking.id`. If none matches, every delivery falls back to a window
      sweep — correct, but wasteful, and the handler logs a line saying so.
- [ ] Exact event names. `LODGIFY_BOOKING_EVENTS` subscribes
      `booking_new_any_status`, `booking_change`, `booking_status_change`.
- [ ] Does Lodgify retry a failed delivery, and what is the ack timeout?
      (The handler assumes no retries — the safe assumption.)
- [ ] Does `POST /v2/webhooks/subscribe` take `{ event, target_url }`?
- [ ] Then set `LODGIFY_WEBHOOKS_ENABLED=true`. **Until that is set,
      registration never fires** — the one operation that writes to the PM's
      own Lodgify account stays off, and the org syncs daily instead.

### 6. Connect flow
- [ ] Connect with a real key, confirm properties and bookings import, confirm
      `booking/confirmed` posts revenue to owner ledgers.
- [ ] Then, in one commit: `UPDATE integration_providers SET is_active = true
      WHERE id = 'lodgify';` (exactly as `20260816122829_activate_hostex_provider.sql`
      did for Hostex).

---

## Disconnect — the honest version

Lodgify has **no endpoint that invalidates an API key**. Disconnecting deletes
FieldStay's copy from Vault and unsubscribes our webhooks; the key itself stays
live in the PM's Lodgify account until they rotate it there. Every other
provider here can actually hang up.

`lodgifyProvider` therefore does not implement `revokeAccessToken` at all — a
no-op implementation would report a revocation that did not happen — and the
Settings copy tells the PM to rotate the key in Lodgify if they want it dead
immediately.

The raw key is also what sits in Vault, unlike Hostaway (where the key is
traded once for a Bearer token and never stored). There is nothing to trade it
for; this is a property of Lodgify's API, not a shortcut.

---

## What a wrong guess costs

The code is written so that every plausible mistake in this document degrades
rather than corrupts:

| If this guess is wrong | What happens |
|---|---|
| A list response shape | `lodgifyExtractItems` **throws and reports the keys it saw**. It never returns `[]` — that would read as "this account is empty" and would arm any reconcile-by-absence pass. |
| A booking status value | Reported to Sentry, mapped to `tentative` (no turnover dispatched, no revenue posted on a stay we are unsure about). |
| A room count field | Maps to `null`, so FieldStay's own default applies once at creation and never overwrites the PM's correction. |
| The webhook id field | Falls back to a short window sweep; the change is still picked up. Logged. |
| Webhook auth exists and we ignore it | Nothing breaks — we authenticate on our own URL token, which is strictly stronger than trusting an unverified header. |
| A money field | `null` rather than a wrong number; `booking-events.ts` falls back to its nights × rate estimate. |

The one thing that is NOT degraded gracefully is a wrong booking-window
parameter name: Lodgify would ignore it and return its own default slice. That
is why item 3 above exists, and why the first sync's property/booking counts
should be checked against the PM's own Lodgify dashboard.

---

## Later, once it is live

- **Key codes.** Lodgify exposes door codes on the booking, and no other PMS
  here does. FieldStay already delivers codes by SMS (`lib/sms/telnyx.ts`);
  wiring Lodgify's would remove a manual step no competitor's integration can.
- **Calendar blocks**, from the availability endpoints — same phase Hostex and
  Hostaway are both still waiting on.
- **Quotes**, if per-property cleaning fees turn out to be readable there.
