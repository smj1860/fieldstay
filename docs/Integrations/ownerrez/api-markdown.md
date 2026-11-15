# OwnerRez API

> Vacation rental management API for bookings, properties, guests, messaging, payments, and more. This file orients AI agents; the machine-readable contract is at /openapi/v2.json.

## Agent instructions

- Base URL: `https://api.ownerrez.com`. All endpoints require authentication.
- Auth: OAuth 2.0 bearer token (`Authorization: Bearer {token}`), or HTTP Basic with your OwnerRez account email as the username and your Personal Access Token (`pt_…`) as the password (`Authorization: Basic {base64(email:token)}`).
- Responses are JSON. Dates/times are ISO 8601 and UTC unless noted; booking arrival/departure dates are in the property's local time.
- Monetary amounts are decimals (e.g. `125.00`), not integer cents.
- Entity IDs are integers, unique per entity type.
- List endpoints paginate with `limit` (default 20, max 100) and an opaque `cursor`. Request the first page without `offset`, then request `next_page_url` exactly as returned until it is `null`.
- **`offset` is going away (OwnerRez notice, 2026-10-21).** Every list returns `next_page_url` as of 2026-11-16. From **2027-01-05 15:00 UTC** any list request with `offset` above 0 returns `400 offset_not_supported`, an unknown query parameter returns `400 unknown_parameter`, and a cursor that OwnerRez did not issue (or one sent with different filters) returns `400 invalid_cursor`. Brownouts return the same 400s on 2026-11-17 15:00-16:00 UTC, 2026-12-01 15:00-19:00 UTC, and 2026-12-08 15:00 UTC to 2026-12-09 15:00 UTC. FieldStay's client (`ownerrez-api.ts`) never builds an offset URL: a non-empty page with no `next_page_url` throws. Filters are every query parameter except `cursor`, `limit` and `offset`, so start a new walk when one changes.
- Per-token rate limit from 2026-11-03: 1,000 requests per 5 minutes per access token, in addition to the per-IP limit. Over either limit returns 429 with `Retry-After`.
- Where supported (e.g. bookings, messages), use `since_utc` for incremental sync and store the latest `updated_utc` you see as the next watermark.
- Errors return JSON with a `messages` array of human-readable strings. Status codes: 400 = bad request / validation, 401 = authentication, 403 = permission, 404 = not found.
- Prefer the current API (v2). Legacy versions remain documented below but should not be used for new integrations.

## Verified contract details (2026-08-13)

Pulled from `https://api.ownerrez.com/openapi/v2.json` because the orientation
notes above have no per-endpoint parameter list, and guessing filled the gap
wrongly once already. Re-verify against the spec before trusting any of this.

### Paging — every list endpoint

The response wrapper (`PageableEnumerableOf*`, used by all 22 list endpoints) is:

```
{ items: [...], limit: 100, offset: 0, next_page_url: "https://..." | null }
```

- `next_page_url` is the continuation mechanism. **Null means the collection is
  finished** — including on a full page. Absent is a different answer from null.
- There is **no `next_page_token` and no `total_count`.** `lib/integrations/types.ts`
  declared both; neither string occurs anywhere in the spec. The pager read
  `next_page_token`, got `undefined`, and stopped after one page — and since it
  also sent no `limit`, that one page was OwnerRez's default of 20. One
  production org's first sync imported exactly 20 bookings as a result.
- `limit` (default 20, max 100) and `offset` are **declared on zero operations**
  in the spec even though the response echoes both back. They work, but do not
  assume a requested `limit` was honored — prefer `next_page_url`, and compare
  short-page checks against the server-reported `page.limit`, not the one you asked for.

### GET /v2/bookings query parameters

| Param | Meaning |
|---|---|
| `property_ids` | comma-separated integers |
| `from` | bookings that **depart on or after** this date (property timezone) |
| `to` | bookings that **arrive on or before** this date (property timezone) |
| `since_utc` | created or changed since (UTC) — a **modification-time cursor, not a stay-date filter** |
| `status` | `Active` \| `Pending` \| `Canceled` |
| `include_guest`, `include_charges`, `include_tags`, `include_fields`, `include_door_codes`, `include_cancellation_policy`, `include_agreements` | booleans |

`from`/`to` together are an interval **overlap** filter, not containment: a stay
straddling a window boundary is returned by both adjacent windows. That is what
makes a progressive historical backfill possible (walk `to` backwards in fixed
steps); the boundary duplicates are harmless because bookings upsert on the
OwnerRez booking id.

## Documentation

- [OpenAPI 3.0 spec](/openapi/v2.json): the full machine-readable contract for v2.
- [Reference docs](/help/v2): human-readable, interactive API reference.
- [Operation index](/help/v2/index.md): every operation, each linked to a self-contained markdown page with enums inlined.
- [OpenAPI 3.0 spec (legacy v1)](/openapi/v1.json): the full machine-readable contract for v1.
- [Reference docs (legacy v1)](/help/v1): human-readable, interactive API reference.
- [Operation index (legacy v1)](/help/v1/index.md): every operation, each linked to a self-contained markdown page with enums inlined.
- [Guides](/help/guides): API how-to articles.

## Resources (v2)

- [Bookings](/help/v2/index.md#bookings)
- [Deposits](/help/v2/index.md#deposits)
- [Discounts](/help/v2/index.md#discounts)
- [Fees](/help/v2/index.md#fees)
- [FieldDefinitions](/help/v2/index.md#fielddefinitions)
- [Fields](/help/v2/index.md#fields)
- [Guests](/help/v2/index.md#guests)
- [Inquiries](/help/v2/index.md#inquiries)
- [ListingSites](/help/v2/index.md#listingsites)
- [Listings](/help/v2/index.md#listings)
- [Messages](/help/v2/index.md#messages)
- [Owners](/help/v2/index.md#owners)
- [Payments](/help/v2/index.md#payments)
- [Properties](/help/v2/index.md#properties)
- [PropertySearch](/help/v2/index.md#propertysearch)
- [Quotes](/help/v2/index.md#quotes)
- [Refunds](/help/v2/index.md#refunds)
- [Reviews](/help/v2/index.md#reviews)
- [SpotRates](/help/v2/index.md#spotrates)
- [Surcharges](/help/v2/index.md#surcharges)
- [TagDefinitions](/help/v2/index.md#tagdefinitions)
- [Tags](/help/v2/index.md#tags)
- [Users](/help/v2/index.md#users)
- [WebhookSubscriptions](/help/v2/index.md#webhooksubscriptions)

## Resources (legacy v1)

- [Bookings](/help/v1/index.md#bookings)
- [ExternalSites](/help/v1/index.md#externalsites)
- [Guests](/help/v1/index.md#guests)
- [Listings](/help/v1/index.md#listings)
- [Properties](/help/v1/index.md#properties)
- [Quotes](/help/v1/index.md#quotes)
- [Tags](/help/v1/index.md#tags)
- [Users](/help/v1/index.md#users)
- 
