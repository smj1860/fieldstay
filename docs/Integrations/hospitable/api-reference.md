# Hospitable API Reference — FieldStay Integration

**Base URL:** `https://public.api.hospitable.com/v2`
**Auth:** `Authorization: Bearer {oauth_access_token}`
**Token expiry:** Access tokens 12 hours · Refresh tokens 90 days
**Pagination:** `meta.last_page` (page-number based) · `per_page` max 100
**Webhook IP range:** `38.80.170.0/24` — whitelist only this range
**Webhook signature:** `Signature` header — raw SHA-256 HMAC hex (no prefix)
**Rate limit (general API):** ~60 requests/minute per vendor — ⚠️ sourced from a search AI Overview summary, not confirmed against Hospitable's own developer docs; treat as a working assumption. `/exchange` (OAuth token) is a separate, much higher-limit endpoint (~300 req/min) and is intentionally NOT covered by the limiter below. Messages endpoint has its own documented limit — see the Messaging section.

---

## Rate Limiting & Request Optimization

**Batching (✅ already optimized):** `hospFetchProperties`, `hospFetchReservations`, and `hospFetchTeammates` each make one paginated call, not one call per property/reservation. `hospFetchReservations` scopes by a batched `properties[]` filter rather than looping per property. The incremental sync's single-property/reservation/review refetch is correctly 1:1 with its triggering webhook event, not a batch operation.

**Rate limiting (`lib/integrations/providers/hospitable.ts`'s `hospitableFetch()`):** every call to `/properties`, `/reservations`, and `/teammates` (not the OAuth endpoints) goes through this shared wrapper, which applies two layers, mirroring the pattern already established for OwnerRez in `lib/integrations/providers/ownerrez-api.ts`:
1. **Proactive** — `hospitableApiLimiter` (`lib/rate-limit.ts`), a sliding window of 54/60 requests per minute (10% headroom under the assumed 60/min limit), shared across every org syncing Hospitable concurrently (all tenants share one Vercel deployment's outbound identity). Throws our own `RateLimitError` before Hospitable would actually 429 us.
2. **Reactive** — a real 429 is still handled as a fallback: parses `Retry-After` and throws `RateLimitError` with that exact wait time.

`RateLimitError` propagates up through Inngest's own step-level `retries` (2 for initial sync, 3 for incremental) rather than a custom `step.sleep()` backoff — appropriate here because, unlike OwnerRez's cron job (which loops over every connected org within a single execution and needs an explicit sleep so one tenant's burst doesn't block the next), each Hospitable sync is its own Inngest function invocation per org/event; Inngest's step retry (with memoized/skipped completed steps) is sufficient. `translateSyncError(err, 'Hospitable')` turns it into a PM-facing message ("Hospitable sync paused due to rate limiting — will retry automatically") written to `integration_connections.metadata.last_sync_error` in `initial-sync.ts`'s failure handler. `translateSyncError()` itself was generalized from OwnerRez-only (hardcoded "OwnerRez" in every message) to accept a `providerLabel` parameter, defaulting to `'OwnerRez'` so existing call sites are unaffected.

## Confidence Key

- ✅ **Confirmed** — verified from live API response or Vercel logs
- 📄 **Spec** — from Hospitable developer documentation (may differ from live behavior)
- ⚠️ **Unconfirmed** — inferred from naming conventions; verify before building

---

## Current OAuth Scopes

| Scope | Status | Purpose |
|---|---|---|
| `property:read` | ✅ Live | Properties, details, listings |
| `reservation:read` | ✅ Live | All reservation data |
| `listing:read` | ✅ Live | Channel listing details |
| `reviews:read` | ✅ Live | Guest reviews and responses |
| `teammate:read` | ✅ Live | Crew/teammate sync |
| `message:read` | ✅ Live | Guest/host reservation conversation sync — confirmed 2026-07-09 that this has been granted all along; the earlier "not yet granted" flag on this scope below was stale, not the actual account status. Was simply unused until reservation_messages sync was built. |
| `financials:read` | ✅ Live | Per-reservation revenue (`financials.host.revenue`) — confirmed live 2026-07-10 against a real test reservation; `bookings.actual_total_amount` populated with the exact correct dollar amount and flowed through to `owner_transactions`. Previously listed below as "to request" — that was stale, not the actual account status, same pattern as `message:read` above. |
| `calendar:read` | ✅ Live | Manually-blocked calendar dates — confirmed live 2026-07-10 against a real block added in the test account; see the "Calendar / Availability" section below. Previously listed below as "to request" — same stale-doc pattern already seen twice above; it turns out to have been granted all along. |

## Scopes to Request from Patrick

| Scope | Required For | Justification |
|---|---|---|
| `task:read` + `task:write` | Friction Forecaster | Read Hospitable task state nightly; push corrected task assignments when Forecaster detects same-day flip risk |
| `devices:read` | Crew app access codes, guidebook door codes | Surface smart lock codes to crew at checkout time without PM copy-paste |
| `devices:write` | Future: remote crew unlock | Provision operation smartlock codes for arriving crew |
| `knowledge_hub:read` + `knowledge_hub:write` | Guidebook sync | Bidirectional sync with Hospitable Knowledge Hub to eliminate duplicate data entry |

---

## Endpoints

### Properties

#### `GET /properties`
**Scope:** `property:read` · **Paginate:** `page` + `meta.last_page`
**Used by:** Initial sync, incremental sync

```
per_page: 100
include:  "listings"  (requires listing:read)
include:  "details"   (no additional scope — see confirmed shape below)
```

**✅ Confirmed live (2026-07-06) top-level keys with `include=details`:**
```
id, name, public_name, picture, address, timezone, listed, currency,
summary, description, checkin, checkout, amenities, capacity,
room_details, property_type, room_type, tags, house_rules, details,
calendar_restricted, parent_child
```

**FieldStay field mapping (✅ confirmed live):**

| Hospitable field | FieldStay column | Notes |
|---|---|---|
| `id` | `properties.external_id` | UUID |
| `name` / `public_name` | `properties.name` | Prefer `public_name` |
| `address.number` + `address.street` | `properties.address` | ✅ Confirmed live — `address` is a flat top-level object (`HospitableAddress`), NOT nested under `details` and NOT an array. Fields are `number`/`street`/`city`/`state`/`country`/`postcode` — NOT `street1`/`postal_code` |
| `address.city` | `properties.city` | |
| `address.state` | `properties.state` | 2-letter abbrev |
| `address.postcode` | `properties.zip` | |
| `capacity.bedrooms` | `properties.bedrooms` | ✅ Confirmed live — `capacity` is top-level, not nested under `details` |
| `capacity.max` | `properties.max_guests` | |
| `checkin` | `properties.checkin_time` | ✅ Confirmed live — plain `"HH:MM"` string. ⚠️ NOT `check-in` (hyphenated) — that key does not exist in the response. Every sync before this fix silently fell back to the `'15:00'` default instead of the real time |
| `checkout` | `properties.checkout_time` | ✅ Confirmed live — plain `"HH:MM"` string. Same `check-out` correction as above |
| `timezone` | `properties.timezone` | ⚠️ Returns UTC offset (`-0500`), NOT IANA — use `resolveHospitableTimezone(prop.timezone, addr.state)` |
| `listed` | — | DO NOT use for `is_active` — listed = published to channels, not in PM's portfolio. Always set `is_active: true`. The incremental-sync webhook handler previously set `is_active: prop.listed` on every `property.changed` update, silently deactivating a property the moment it was unlisted from a channel — fixed to leave `is_active` untouched on updates; only the 404 (property deleted from Hospitable) branch may deactivate |

**✅ Confirmed live — additional `include=details` fields:**
`amenities` (string[], e.g. `['ac', 'dishwasher', 'wireless_internet', ...]`), `currency` (e.g. `'USD'`), `description` / `summary` (empty string `''` when unset, NOT `null`), `house_rules` (`{pets_allowed, smoking_allowed, events_allowed}`), `capacity.bathrooms`.

**⚠️ Unconfirmed — not yet inspected:** `picture`, `tags`, `calendar_restricted`, `parent_child` (likely multi-unit/parent-listing linkage).

**✅ Confirmed live (2026-07-06) — the top-level `details` object.** Naming collision to watch for: this is unrelated to the `details.addresses[...]`/`details.capacity` notation this doc previously (incorrectly) used — `address` and `capacity` are their own top-level fields. The real `details` object contains free-text and WiFi credential fields:
```
details.space_overview
details.guest_access
details.house_manual            — credential-adjacent, often embeds the WiFi password as free text
details.other_details
details.additional_rules
details.neighborhood_description
details.getting_around
details.wifi_name                — NOT wifi_network as first assumed before live verification
details.wifi_password            — credential
```
**✅ Wired (2026-07-06) — `include=details` now maps into a DB upsert via a shared normalization layer** (`lib/properties/normalize.ts` + `lib/properties/upsert-normalized.ts`). `hospitablePropertyToNormalized()` in `hospitable.ts` is a pure mapper (`HospitableProperty → NormalizedProperty`, no I/O); `upsertNormalizedProperties()` writes it. The PMS is always the source of truth — every sync overwrites every field, **including** `wifi_name`/`wifi_password`/`access_instructions`/`house_manual`, which a PM can also hand-edit directly (`app/(dashboard)/properties/[id]/setup/details/actions.ts`). Rather than blocking that overwrite, the writer logs a `property.content.overwritten_by_sync` audit event (`audit_events` table) whenever it's about to replace an existing, different, non-null value for one of those four fields — recoverability, not prevention. `wifi_password`'s actual value is never written to the audit log, only that it changed. OwnerRez's fan-out detail-fetch architecture doesn't fit this writer's single-pass shape (see below), but shares the same `NormalizedProperty` target type and audit behavior as a future follow-up.

| Hospitable field | `properties` staging column | Notes |
|---|---|---|
| `details.wifi_name` | `wifi_name` | |
| `details.wifi_password` | `wifi_password` | Credential — see security note below |
| `details.guest_access` | `access_instructions` | Best semantic match — no dedicated Hospitable "check-in instructions" field exists |
| `details.house_manual` | `house_manual` | Often embeds the WiFi password as free text |
| `amenities` (string[]) | `amenities` (`Record<string, boolean>`) | Converted via `normalizeHospitableAmenities()` — Hospitable slugs are already clean snake_case, no title normalization needed unlike OwnerRez's `normalizeAmenities()` |
| `house_rules.smoking_allowed` / `.pets_allowed` / `.events_allowed` | `smoking_allowed` / `pets_allowed` / `events_allowed` | Direct mapping |
| `capacity.bathrooms` | `bathrooms` | Previously hardcoded to `1` with a comment claiming "Hospitable v2 has no bathroom count" — that was wrong; fixed alongside this change |

**Not mapped — no dedicated destination column exists:** `details.space_overview`, `details.other_details`, `details.additional_rules`, `details.neighborhood_description`, `details.getting_around`, `checkout_instructions` (no Hospitable source field). `properties.checkout_instructions` and these five `details` fields are left untouched; a future schema change would be needed to surface them.

`properties` is a **staging layer**, not the guest-facing record — `lib/guidebook/sync.ts`'s `syncGuidebookConfigsFromProperty()` copies these columns into `guidebook_property_configs` (`wifi_network`, `wifi_password`, `check_in_instructions`, `house_rules`, `check_out_instructions`) **only when the guidebook field is currently empty**, so a PM's own edits in the *guidebook* are never overwritten — a different, additional layer of protection from the audit-on-overwrite behavior on `properties` itself described above. `createGuidebookPropertyConfigsForProperties()` auto-creates a blank, unpublished (`is_published: false`) config with a unique slug for any active property lacking one, and `ensureGuidebookConfiguration()` starts the org's 30-day guidebook trial (idempotent — never resets an existing trial). All three run in both `hospitable/initial-sync.ts` and `hospitable/incremental-sync.ts`.

**✅ Wired (2026-07-06) — amenity-confirmed appliances seed `property_assets`.** `lib/asset-discovery/seed-from-amenities.ts`'s `seedPresentAssetsFromAmenities()` creates a bare-stub, active `property_assets` row (no make/model — `is_na: false`, so crew is still prompted to capture full details during the next turnover) for asset types Hospitable's `amenities` confirm are present:

| Asset type | Hospitable amenity slug(s) |
|---|---|
| `washer` | `washer` |
| `dryer` | `dryer` |
| `dishwasher` | `dishwasher` |
| `microwave` | `microwave` |
| `refrigerator` | `refrigerator` |
| `oven_range` | `oven` OR `stove` (either present → one asset, not two) |
| `fire_extinguisher` | `fire_extinguisher` |

**Intentionally excluded** — amenity presence doesn't confirm a discrete, inspectable unit: `ac`/`heating` → `hvac` (could be a space heater or window unit), `hot_water` → `water_heater`, `wireless_internet` → `wifi_router`, `coffee_maker` → `coffee_station`. Revisit if a future need justifies the ambiguity.

Never duplicates or overwrites an existing active `property_assets` row for the same type. Runs in both `hospitable/initial-sync.ts` (all synced properties) and `hospitable/incremental-sync.ts` (the single updated property). Wired into OwnerRez's sync too, for parity.

**✅ Wired (2026-07-06) — absent-optional-asset seeding, for parity with OwnerRez.** `seedAbsentOptionalAssetsFromAmenities()` marks `pool_pump`, `hot_tub`, `well_pump`, `solar_inverter`, `whole_home_water_filter`, `heated_tile_system`, `coffee_station`, and `toaster_oven` as confirmed absent (`is_na: true`) when none of `OPTIONAL_ASSET_AMENITY_MAP`'s trigger slugs are present — dropping them from the crew's discovery queue. ⚠️ **Unconfirmed for Hospitable:** that trigger map was built for OwnerRez's free-text amenity titles (many synonym variants per type); Hospitable's amenities are a fixed, standardized slug set and we haven't seen a live Hospitable property with a pool/hot tub/solar/etc. to confirm its slugs match. A mismatch is harmless — it only means no extra signal for that property, since this exclusively marks *absence*, never a false claim of presence.

**🔒 Security note — `wifi_password` / `house_manual`:** These are credentials (or credential-adjacent free text). Storing them on `properties` mirrors the existing OwnerRez convention and is scoped by that table's RLS to org members — never expose them in any public-facing query. Never log `wifi_name`, `wifi_password`, or `house_manual` without redacting to presence/length first.

**Known quirks:**
- `prop.timezone` is a UTC offset string like `-0500`. Node's `Intl` API requires IANA identifiers. Derive timezone from `addr.state` using `resolveHospitableTimezone()` in `lib/integrations/providers/hospitable.ts`.
- `details.addresses` is an array — find `is_default: true` or use index 0.

**📄 Spec only — `bookings` (pricing rules/policies), wired ahead of verification (2026-07-10).** Per Hospitable's own published example response, `bookings` sits at the top level of the property object alongside `details`/`house_rules`:
```
bookings.booking_policies.cancellation      string[]
bookings.booking_policies.payment_terms     { status, description[], grace_period }
bookings.listing_markups                    [{ platform, type, value }]
bookings.security_deposits                  [{ name, type, value: { amount, formatted } }]
bookings.occupancy_based_rules              { guests_included, extra_guest_fee, pet_fee }
bookings.fees                               [{ name, type, value }]   — e.g. name: "cleaning_fee"
bookings.discounts                          [{ name, type, value }]
bookings.site_urls                          string[]
```
**Not yet confirmed:**
- Whether a bare `include=details` call returns this object, or whether it needs its own `include=bookings` — the published example bundles every field group together for illustration, and this exact endpoint already fooled us once before on `check-in`/`check-out` (spec says hyphenated; live reality is `checkin`/`checkout`, no hyphen — see above). `hospFetchProperties()`/the single-property fetch now request `include=details,bookings` speculatively; harmless if Hospitable ignores the unrecognized include.
- Whether `fees[].name` is really the literal string `"cleaning_fee"` for every account, or a per-account slug.
- Money values are assumed integer cents (`12345` → `"$123.45"`) per Hospitable's convention elsewhere — unconfirmed for this specific field.

**FieldStay mapping (📄 speculative — not yet verified live):** `bookings.fees[name=cleaning_fee].value.amount` → `properties.cleaning_cost`, via `extractHospitableCleaningFee()` in `hospitable.ts`. Deliberately NOT part of the always-overwrite property sync — only backfills a currently-`null` `cleaning_cost`, since a PM's own entry (what FieldStay actually pays a cleaner) can legitimately differ from what the PMS charges guests. See `backfillCleaningCost()` in `lib/properties/upsert-normalized.ts`.

---

#### `GET /properties/{uuid}`
**Scope:** `property:read`
**Used by:** Incremental sync when `property.changed` webhook fires — fetch full single property detail.

---

#### `GET /properties/{uuid}/devices`
**Scope:** `devices:read` *(not yet granted)*
**Used by:** Crew app door codes, guest guidebook access codes

Returns smart locks and thermostats. Filter: `?device_type=smartlock`

**Key fields:**
| Field | Type | Notes |
|---|---|---|
| `id` | UUID | Use in lock/unlock control endpoints |
| `device_type` | `smartlock` \| `thermostat` | |
| `state.locked` | boolean | Current lock state |
| `state.battery.status` | string | |
| `state.battery.percentage` | integer | |

---

### Reservations

#### `GET /reservations`
**Scope:** `reservation:read` + `property:read` (for `include=properties`)
**Paginate:** `page` + `meta.last_page`
**Used by:** Initial sync, incremental sync

```
properties[]: [uuid1, uuid2]    REQUIRED — array format
start_date:   YYYY-MM-DD        defaults to next 2 weeks if omitted
date_query:   "checkin"         or "checkout"
status[]:     ["accepted", "request", "cancelled"]   optional
per_page:     100
include:      "guest,properties"
```

**⚠️ IMPORTANT — `include` format:** Use comma-separated string (`include=guest,properties`), NOT array format. Both are accepted per spec but comma-separated is the documented default.

**✅ Confirmed accepted `status[]` values (from a live 400 response):** `not_accepted`, `request`, `accepted`, `cancelled`, `checkpoint` — note the underscore in `not_accepted` (the *response* field `reservation_status.current.category` uses a space, `"not accepted"`, but the filter value does not). `unknown` is a valid response category but is **not** a valid `status[]` filter value and will 400 if sent.

**⚠️ CONFIRMED — reservations tied to an unlisted/inactive listing are excluded from this endpoint entirely.** A reservation created manually via Hospitable's Calendar ("Add Reservation", with real guest/dates/status — a genuine Reservation object, not a Block) will not appear in `GET /reservations` — with any combination of `status[]`, `date_query`, or lookback window — if the property's listing is unlisted/not published to a channel (e.g. Airbnb). Confirmed via a `200 OK` response with real pagination metadata (`meta.total: 0`) for a property with a reservation visible in the Calendar UI, ruling out a request/parameter bug. If bookings aren't syncing for a property, check whether its listing is active/published before assuming a FieldStay sync bug — `properties.listed` (see the Properties section above) is the relevant flag on our side, though note we deliberately ignore it for our own `is_active` and it isn't currently checked before attempting a reservation sync.

**ReservationFull base fields (✅ confirmed from live developer docs):**

| Field | Type | Example | Notes |
|---|---|---|---|
| `id` | UUID string | `6f58fd0a-...` | Use as `external_id` |
| `conversation_id` | UUID string | | |
| `platform` | string enum | `airbnb` | ✅ Enum: `airbnb`, `homeaway`, `booking`, `direct`, `manual` |
| `platform_id` | string | `ABC123` | Visible reservation code |
| `booking_date` | date-time | `2019-01-01T12:00:00Z` | |
| `arrival_date` | date-time | `2019-01-03T00:00:00-05:00` | ⚠️ Date-only at midnight — use `.split('T')[0]` for date column |
| `departure_date` | date-time | `2019-01-05T00:00:00-05:00` | ⚠️ Same — use `.split('T')[0]` |
| `nights` | integer | `2` | |
| `check_in` | date-time | `2019-01-03T13:00:00-05:00` | ⚠️ Actual check-in TIME — use `extractHospitableTime()` for time column |
| `check_out` | date-time | `2019-01-05T11:00:00-05:00` | ⚠️ Actual check-out TIME — use `extractHospitableTime()` |
| `last_message_at` | date-time | | |
| `status` | string | `booking` | ⚠️ DEPRECATED — use `reservation_status` |
| `reservation_status.current.category` | string enum | `accepted` | ✅ Canonical status field |
| `reservation_status.current.sub_category` | string | `pending verification` | |
| `guests` | object | `{total, adult_count, child_count, infant_count, pet_count}` | ⚠️ Guest COUNTS not names |
| `guests.total` | integer | `1` | |
| `guests.adult_count` | integer | `1` | |
| `guests.child_count` | integer | `0` | |
| `guests.infant_count` | integer | `0` | |
| `guests.pet_count` | integer | `0` | |
| `stay_type` | string | `guest_stay` \| `owner_stay` | |
| `issue_alert` | string or null | `Broken AC` | |
| `note` | string | | Internal conversation notes |

**Included fields (via `include=` parameter):**

| Include name | Response key | Scope | Notes |
|---|---|---|---|
| `guest` | `guest` (singular object) | `reservation:read` | ✅ Guest name info |
| `properties` | ⚠️ **UNCONFIRMED KEY NAME** | `property:read` | 📄 Spec says `property` (singular) but may be `properties` (plural) — use defensive lookup |
| `financials` | `financials` | `financials:read` ⏳ | Revenue data |
| `review` | `review` | `reviews:read` | |
| `tasks` | `tasks` | `task:read` ⏳ | |

**📄 Spec — `financials`, wired ahead of the scope grant.** `financials:read` was not yet granted as of this writing, so this has never been observed in a real response for our own account. Updated 2026-07-10 with the real documented shape from Hospitable's own published spec — confirmed identical across **both** `GET /reservations/{id}` (Get Reservation — the actual read endpoint our single-reservation fetch calls) **and** `PUT /reservations/{id}` (Update Reservation)'s example responses, which is stronger evidence than a write-endpoint example alone (the original version of this section guessed top-level `host_payout`/`payout`/`total` keys with no reference material at all — wrong, corrected below). Still not directly confirmed: whether the bulk list endpoint (`GET /reservations`, used by `hospFetchReservations()` for sync) returns the identical shape — very likely given API consistency, but not the same doc page:
```
financials.host.revenue        { amount, formatted, label: "Gross Revenue", category }   — primary field
financials.host.accommodation  { amount, formatted, label, category }
financials.host.accommodation_breakdown  [{ amount, formatted, label, category }]  — per-night
financials.host.guest_fees / host_fees / discounts / adjustments / taxes  [{ amount, formatted, label, category }]
financials.guest.total_price   { amount, formatted, label: "Guest Total Price", category }   — fallback field
financials.guest.accommodation / fees / discounts / taxes / adjustments  [{ amount, formatted, label, category }]
financials.currency             string
```
**Still not confirmed:** whether `GET /reservations?include=financials` returns the identical shape to the `PUT` response above (likely, since Hospitable's docs consistently reuse the same `financials` structure across reservation endpoints, but not directly verified) — and whether every field is always present or some are omitted when zero/not-applicable.

`hospFetchReservations()` and the single-reservation fetch request `include=guest,properties,financials` speculatively. `extractHospitableActualTotal()` in `hospitable.ts` reads `financials.host.revenue` first (the actual owner/PM revenue figure — matches what `owner_transactions` needs), falling back to `financials.guest.total_price` (what the guest paid overall, which can include host-passthrough fees/taxes that don't belong in a revenue figure, but is still a real number rather than nothing) if `host.revenue` is ever absent. Returns `null` on anything malformed — never posts a fabricated number.

**FieldStay mapping:** the extracted amount → `bookings.actual_total_amount`, then flows into `booking/confirmed`'s `actual_total_amount` field (`lib/inngest/events.ts`), which `handleBookingConfirmed` (`lib/inngest/functions/booking-events.ts`) prefers over the `avg_nightly_rate` estimate when posting to `owner_transactions`. This is also the first time `booking/confirmed` has ever had a producer — Hospitable's initial and incremental sync now emit it for confirmed, non-block, guest-stay reservations; OwnerRez/Uplisting still don't emit this event today (a separate, pre-existing gap, not addressed here). **Verify against a real GET response for our own account before fully trusting the posted revenue figure** — the shape above is a real Hospitable spec now, not a blind guess, but still unconfirmed for this specific endpoint/include combination.

**`guest` include fields:**
```
guest.first_name:    string | null
guest.last_name:     string | null
guest.email:         string | null
guest.phone_numbers: string[] | null
```

**`property` include — ⚠️ KEY NAME UNCONFIRMED:**
```
id:          UUID    ← used for propertyIdMap lookup
name:        string
public_name: string
```
Defensive lookup pattern in code:
```typescript
const raw = res as Record<string, unknown>
const propertyExternalId =
  res.property?.id                                          ??
  (raw['properties'] as { id?: string } | null)?.id        ??
  (raw['properties'] as { id?: string }[] | null)?.[0]?.id ??
  null
```

**FieldStay field mapping:**

| Hospitable field | FieldStay column | Transform |
|---|---|---|
| `id` | `bookings.external_id` | Direct |
| `platform` | `bookings.source` | `mapHospitableChannel()` |
| `arrival_date` | `bookings.checkin_date` | `.split('T')[0]` |
| `departure_date` | `bookings.checkout_date` | `.split('T')[0]` |
| `check_in` | `bookings.checkin_time` | `extractHospitableTime(val, '15:00')` |
| `check_out` | `bookings.checkout_time` | `extractHospitableTime(val, '11:00')` |
| `reservation_status.current.category` | `bookings.status` | `mapHospitableStatus()` |
| `guest.first_name` + `guest.last_name` | `bookings.guest_name` | Join with space |
| `property.id` (unconfirmed key) | lookup in `propertyIdMap` | Defensive lookup |

**Platform → source enum mapping:**
| Hospitable `platform` | FieldStay `source` |
|---|---|
| `airbnb` | `airbnb` |
| `homeaway` | `vrbo` |
| `booking` | `booking_com` |
| `direct` | `direct` |
| `manual` | `direct` |
| `agoda` | `other` |
| `ical` | `other` |

**Status → FieldStay status mapping:**
| `reservation_status.current.category` | FieldStay |
|---|---|
| `accepted` | active booking |
| `request` | pending |
| `cancelled` | cancelled |
| `not_accepted` | cancelled |

---

#### `GET /reservations/{identifier}`
**Scope:** `reservation:read`
**Used by:** Incremental sync — fetch single reservation after webhook fires.
`identifier` = UUID or reservation code.

---

### Calendar / Availability — ✅ Confirmed live, implemented

#### `GET /properties/{uuid}/calendar`
**Scopes:** `property:read` + `calendar:read` ✅ *(confirmed live 2026-07-10 — turned out to have been granted all along, same stale-doc pattern as `message:read`/`financials:read` above)*
**Rate limit:** 1000 req/min per vendor/PAT user (much higher than the general ~60/min limit)
**Query params:** `start_date`, `end_date` (both `YYYY-MM-DD`)
**Used by:** `lib/inngest/functions/hospitable/calendar-sync-cron.ts` (daily fan-out, one event per active Hospitable property) → `calendar-sync-handler.ts` (fetch + `consolidateHospitableBlocks()` + reconcile into `bookings`). `hospFetchCalendar()` in `lib/integrations/providers/hospitable.ts` is the raw fetch.

**Response shape** (✅ confirmed against a real payload, a property with both a guest reservation and a manual block in range):
```
data.listing_id            string (deprecated)
data.provider               string (deprecated)
data.start_date / end_date  string (YYYY-MM-DD)
data.days[]:
  date                  string (YYYY-MM-DD)
  day                   string — e.g. "SUNDAY"
  min_stay              number
  note                  string | null
  status.reason         string — confirmed values: "AVAILABLE" | "RESERVED" | "BLOCKED"
  status.source_type    string — confirmed values: "PLATFORM" (channel-driven, e.g. still bookable) | "RESERVATION" (a real guest stay) | "USER" (a PM-set manual block)
  status.source         string | null — e.g. "airbnb" for PLATFORM/RESERVATION days, null for USER-blocked days
  status.available      boolean
  price.amount / currency / formatted
  closed_for_checkin    boolean — true for BLOCKED days
  closed_for_checkout   boolean — true for BLOCKED days
```

**Manual block detection (✅ confirmed, see `consolidateHospitableBlocks()`):** a day is a PM-set block when `status.available === false && status.source_type === 'USER'` — a real guest reservation instead reports `status.source_type === 'RESERVATION'`, so the two are never ambiguous and no cross-reference against `/reservations` or the existing `bookings` table is needed to tell them apart. Consecutive blocked days are merged into a single range per contiguous run.

**Reconciliation:** each block range upserts as a synthetic `bookings` row (`is_block: true`, `status: 'blocked'`, `external_id: `hospitable-block:{hospitable_property_id}:{checkin_date}`\`, `source: 'other'`). A block lifted by the PM simply stops reappearing in a later day; the handler cancels (`status: 'cancelled'`) any existing block row whose range overlapped the freshly-fetched window but isn't in the current set. No turnover regeneration call is needed — `generateTurnoversForProperty()` already excludes `is_block: true` rows from its query entirely, so a block's presence or absence never changes what it produces; the value here is purely making the block visible as "Blocked" on the bookings/calendar UI and excluded from owner-portal/guidebook-email/inventory triggers, same as every other `is_block` consumer in the codebase.

---

### Teammates / Crew

#### `GET /teammates`
**Scope:** `teammate:read` *(✅ live)*
**Paginate:** `page` + `meta.last_page` · `per_page` max 100

```
service_id:  1-8   (optional filter)
property_id: UUID  (optional filter)
include:     "properties"
per_page:    100
```

**Fields (✅ confirmed from spec):**
```
id:            UUID string            → crew_members.external_id
name:          string | null          → crew_members.name (combined first+last)
first_name:    string | null
last_name:     string | null
is_company:    boolean
company_name:  string | null          → fallback for name when is_company=true
email:         string | null          → crew_members.email
phone_number:  string | null          → crew_members.phone  ⚠️ NOT "phone"
all_services:  boolean
all_properties: boolean
services:      [{id: integer, label: string}]   → role + specialty
```

**Service label → FieldStay crew role:**
| Hospitable label | FieldStay `crew_role` |
|---|---|
| Cleaning | `cleaning` |
| Laundry | `cleaning` |
| Maintenance | `maintenance` |
| Check-in | `crew` |
| Check-out | `crew` |
| Concierge | `general` |
| Manager | `manager` |
| Owner | `owner` |

---

### Reviews

#### `GET /reviews`
**Scope:** `reviews:read`
**Used by:** RepuGuard — review sync and AI response drafting

```
properties[]: [uuid1, uuid2]   REQUIRED
include:      "guest,reservation"
```

**Key fields:**
```
id:                   string
rating:               integer (1-5)
public.review:        string
public.response:      string | null   (null = not yet responded)
can_respond:          boolean
reviewed_at:          date-time
guest.first_name:     string
guest.last_name:      string
reservation.id:       UUID
reservation.check_in: date-time
reservation.check_out: date-time
```

---

### Tasks (Friction Forecaster — pending `task:read`)

#### `GET /tasks`
**Scope:** `task:read` *(⏳ not yet granted)*
**Used by:** Friction Forecaster — real-time task state

```
properties[]: [uuid1, uuid2]   REQUIRED
start_date:   YYYY-MM-DD       defaults to today
end_date:     YYYY-MM-DD
include:      "marketplace"
per_page:     100
```

**✅ IMPORTANT:** Task `timezone` field returns a REAL IANA identifier (e.g., `America/Chicago`) unlike `prop.timezone` which returns a UTC offset. Use task `timezone` directly with `Intl.DateTimeFormat`.

**Key fields:**
```
id:               UUID
task_type:        string    (cleaning, check_in, check_out, maintenance, etc.)
start_date:       ISO datetime (in property local timezone)
end_date:         ISO datetime (in property local timezone)
timezone:         string    ✅ REAL IANA identifier — use directly
status:           string
teammate.id:      UUID
property_id:      UUID
reservation_uuid: UUID | null
```

#### `GET /tasks/{id}?include=checklist`
**Scope:** `task:read`
**Note:** Checklist only available on single-task endpoint — too expensive for list.

#### `POST /tasks` / `PATCH /tasks/{id}` / `DELETE /tasks/{id}`
**Scope:** `task:write` *(⏳ not yet granted)*
**Used by:** Friction Forecaster smart fix — push corrected assignments to Hospitable

---

### Smart Locks

#### `GET /properties/{uuid}/devices`
**Scope:** `devices:read` *(⏳ not yet granted)*

#### `POST /locks/{lock_id}/lock` · `POST /locks/{lock_id}/unlock`
**Scope:** `devices:write` *(⏳ not yet granted)*
**Account entitlement:** `smart-devices` required (separate from scope)

---

### Messaging

#### `GET /reservations/{identifier}/messages`
**Scope:** `message:read` ✅ Live
**Rate limit:** 2 req/min per reservation
**Used by:** `hospIncrementalSync`'s `message` entity branch (`lib/inngest/functions/hospitable/incremental-sync.ts`) — fetches and upserts into `reservation_messages` on `message.created`/`message.updated` webhooks. Not yet used by RepuGuard, which is a plausible future consumer of the same data.

#### `GET /reservations/{identifier}/scheduled-messages`
**Scope:** `message:read` ✅ Live
**Used by:** Not yet called anywhere in the codebase — potential future use for RepuGuard to understand what automated messages already sent, but no code path exists today.

---

## Webhooks

**Endpoint:** `https://app.fieldstay.app/api/webhooks/hospitable`
**Verify:** `Signature` header — HMAC-SHA256 of raw body, secret from Partner Portal. Sanity-checked byte-for-byte against Hospitable's own worked example (`HMAC-SHA256({"foo": "bar"}, "123456")` → `cc99bf59...`) — confirms `hospitableProvider.validateWebhook()` uses the raw body bytes, not a re-serialized JSON string, which matters because re-serializing (different whitespace/key order) would silently break every signature check.
**IP allowlist:** ✅ Enforced (`lib/integrations/webhook-verification.ts`'s `isIpInCidr()`) — as Vendors (not per-customer Hosts), our secret is one Partner-Portal-managed value, not the per-host-email-derived secret the docs describe for direct Host integrations. Checked ahead of the signature, since it's the cheaper rejection.
**Retry:** 5x with backoff: 1s → 5s → 10s → 1hr → 6hr
**Dedup:** `id` (ULID) stored in `processed_webhooks` table

**Payload shape:**
```json
{
  "id":      "01GTKD6ZYFVQMR0RWP4HBBHNZC",
  "action":  "reservation.created",
  "data":    {},
  "created": "2023-10-01T09:35:24Z",
  "version": "1.0"
}
```
`data` shape = same as GET response for that resource type — **except reservation.changed**, see below.

**⚠️ CONFIRMED — `reservation.changed` sends a PARTIAL payload, not the full reservation.** Per Hospitable's own docs example, a check-in-time-only change delivers `data: { "check_in": "2019-01-03T16:30:00-05:00" }` — just the changed field(s), with no `id` on `data` at all. The reservation's own id is on the **top-level `payload.id`** for this event instead (differs from `review.created`, where the top-level `id` is the webhook's own ULID and the entity id is nested under `data.id` — the two events use `id` for different things). `handleWebhookEvent()` checks `data.id` first (for `reservation.created`, which may send the fuller object) and falls back to the top-level `payload.id`. Before this fix, any `reservation.changed` webhook carrying only a partial diff had no way to identify which reservation to re-fetch and was silently dropped.

**`triggers` array — now wired.** Present on reservation webhooks (and per Hospitable, "some property/message" webhooks — not yet confirmed which ones). Full confirmed value list for reservations:
```
status_changed  dates_changed  guests_changed  listing_changed
checkin_changed  checkout_changed  notes_changed  financials_changed  guest_issue_detected
```
`hospitableProvider.handleWebhookEvent()` passes `triggers` through on the fired event; `hospIncrementalSync` skips the re-fetch entirely when every trigger present is one FieldStay stores nothing for (`guests_changed`, `notes_changed`, `financials_changed`, `guest_issue_detected` — see `IRRELEVANT_RESERVATION_TRIGGERS` in `incremental-sync.ts`). `listing_changed` is deliberately NOT treated as skippable — it could mean the reservation moved to a different property, so it still triggers a re-fetch and re-resolve. This is purely an efficiency skip: once a fetch does happen, what actually changed is still decided by comparing before/after dates in our own DB, never by trusting Hospitable's trigger label alone.

### Active Webhook Events

| Action | Status | FieldStay Handler |
|---|---|---|
| `reservation.created` | ✅ Confirmed from Vercel logs | `hospIncrementalSync` → upsert booking, generate turnovers |
| `reservation.changed` | 📄 Spec (payload shape ✅ confirmed — see partial-payload note above) | `hospIncrementalSync` → update booking, regenerate turnovers |
| `reservation.cancelled` | 📄 Spec | `hospIncrementalSync` → set status cancelled |
| `integration.disconnected` | 📄 Spec | Mark revoked, send PM reconnect email |

### Unconfirmed Webhook Events (action names not yet verified from live delivery)

| Action (unconfirmed) | Trigger | FieldStay Use | Scope |
|---|---|---|---|
| `property.changed` | Property updated | Update property record | `property:read` ✅ |
| `property.created` | New property added | Add property, apply checklist | `property:read` ✅ |
| `review.created` | Guest review posted | RepuGuard draft trigger | `reviews:read` ✅ |
| `review.changed` | Review updated | RepuGuard sync | `reviews:read` ✅ |
| `task.created` | Task created | Friction Forecaster | `task:read` ⏳ |
| `task.changed` | Task updated/completed | Friction Forecaster | `task:read` ⏳ |
| `task.deleted` | Task removed | Friction Forecaster | `task:read` ⏳ |

**⚠️ To confirm property webhook action strings:** After `task:read` is granted, update one Hospitable property and check Vercel logs for the exact `action` value before adding to the switch statement in `lib/integrations/providers/hospitable.ts`.

---

## Authentication Flow

```
1. Auth URL:    https://auth.hospitable.com/oauth/authorize
   Params:      client_id, response_type=code
   Note:        scopes are configured in Partner Portal, NOT in URL params

2. Token URL:   https://auth.hospitable.com/oauth/token
   Method:      POST
   Body:        JSON (not form-encoded)
   Fields:      client_id, client_secret, grant_type=authorization_code, code

3. Refresh:     Same token URL
   Fields:      client_id, client_secret, grant_type=refresh_token, refresh_token
   Note:        Both access_token AND refresh_token rotate on each refresh
   ⚠️ Keep previous refresh token for 60 min fallback — revoked tokens remain valid briefly

4. Expiry:      access_token = 12 hours · refresh_token = 90 days
```

**Token storage:** Both stored in Supabase Vault. `expires_at` updated in `integration_connections`.

---

## FieldStay Implementation Notes

**`extractHospitableTime(value, fallback)`** — strips HH:MM from ISO datetime strings. Use for all time columns. Located at `lib/integrations/providers/hospitable.ts`.

**`resolveHospitableTimezone(hospTimezone, state)`** — converts UTC offset to IANA identifier using US state. `prop.timezone` returns offsets, not IANA. Located at `lib/integrations/providers/hospitable.ts`.

**`mapHospitableChannel(platform)`** — maps platform string to `bookings.source` enum.

**`mapHospitableTeammateRole(services)`** — maps service labels to `crew_members.role` enum.

**Token refresh cron:** `integration-token-refresh-cron` runs every 2 hours, refreshes tokens expiring within 60 minutes. Covers Hospitable and Kroger. Located at `lib/inngest/functions/cron/integration-token-refresh.ts`.

**Teammate resync cron:** Hospitable has no `teammate.*` webhook, so `hospTeammateSyncCron` (`lib/inngest/functions/hospitable/teammate-sync-cron.ts`) runs once daily at 09:00 UTC, dispatching one `integration/hospitable.teammate_sync.requested` event per active connection. `hospTeammateSyncHandler` (`teammate-sync-handler.ts`) re-fetches `/teammates`, upserts via the shared `hospitableTeammatesToCrewRows()` mapper (also used by initial sync), and deactivates (`is_active: false`) any previously-synced crew member no longer in the fetch — the only path that catches teammates removed in Hospitable.

---

## Confirmed Webhook Payload Structures

### `review.created` ✅ Confirmed from Hospitable developer docs

**Trigger:** New review received — Airbnb and direct bookings only (not homeaway, booking, agoda)
**Scope required:** `reviews:read`
**Includes:** `property` and `listing` are added **automatically** if those scopes are active — NOT via include parameter

```json
{
  "id":      "ULID string",
  "action":  "review.created",
  "created": "2024-10-08T07:03:34Z",
  "version": "v2",
  "data": {
    "id":           "550e8400-e29b-41d4-a716-446655440000",
    "platform":     "airbnb",
    "public": {
      "rating":   5,
      "review":   "Great stay!",
      "response": null
    },
    "private": {
      "feedback":        "...",
      "detailed_ratings": []
    },
    "responded_at": null,
    "reviewed_at":  "2024-03-19T10:00:00Z",
    "can_respond":  true,
    "guest":        { "first_name": "...", "last_name": "..." },
    "reservation":  { "id": "UUID", "check_in": "...", "check_out": "..." },
    "property":     { "id": "UUID", "name": "...", "public_name": "..." },
    "listing":      { "platform": "airbnb", "platform_id": "..." }
  }
}
```

**`platform` enum for reviews:** `airbnb` | `direct` — only these two sources generate reviews via Hospitable.

**FieldStay handler:** On `review.created`, trigger RepuGuard AI draft pipeline.
Extract `data.id` as `external_id`, `data.platform`, `data.public.rating`, `data.public.review`,
`data.can_respond`, `data.reservation.id`, `data.property.id`.

---

### `property.changed` ✅ Confirmed from Hospitable developer docs

**Trigger:** Property created OR updated (both use the same action string), including when listings change due to a merge
**Scope:** `property:read`
**⚠️ Critical:** There is NO separate `property.created` webhook — creates and updates both fire `property.changed`. Always upsert, never insert-only.

`data` shape = same as `GET /properties/{uuid}` full response.

**FieldStay handler:** Upsert property record — `onConflict: 'external_id,external_source'`.

---

### `property.merged` ✅ Confirmed from Hospitable developer docs

**Trigger:** Two properties are merged in Hospitable — the old property is deleted, the new property absorbs its listings.
**Scope:** `property:read`

**⚠️ No `property.deleted` webhook exists.** Deletions via merge are handled exclusively through `property.merged`. A `property.changed` for the surviving property fires alongside this.

**Payload structure:**
```json
{
  "id":      "ULID string",
  "action":  "property.merged",
  "created": "2024-10-08T07:03:34Z",
  "version": "v2",
  "data": {
    "previous_id": "550e8400-e29b-41d4-a716-446655440000",
    "new_id":      "660f9511-f3ac-52e5-b827-557b267gg8cc"
  }
}
```

**FieldStay handler — critical ID remapping required:**
```typescript
// When property.merged fires:
// 1. Find FieldStay property with external_id = previous_id
// 2. Update its external_id to new_id
// 3. All child records (bookings, turnovers, work_orders) via FK cascade stay intact
// 4. Mark old property as inactive or delete depending on PM preference

await supabase
  .from('properties')
  .update({ external_id: data.new_id })
  .eq('external_id',     data.previous_id)
  .eq('external_source', 'hospitable')
  .eq('org_id', 
