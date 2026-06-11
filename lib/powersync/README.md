# PowerSync — Local-First Sync Layer

This directory contains all PowerSync configuration for FieldStay's local-first architecture.

| File | Purpose |
|---|---|
| `schema.ts` | Client-side SQLite table definitions — what columns exist in the local DB |
| `client.ts` | `SupabaseConnector` (auth + upload handler) and `getPowerSyncDb()` singleton |
| `sync_rules.yaml` | Bucket definitions — what rows from Supabase sync down to each user's device |

---

## How It Works

PowerSync maintains a local SQLite database on each crew member's device. Reads come from SQLite (zero latency, works offline). Writes go through `SupabaseConnector.uploadData()`, which routes each operation to the appropriate Supabase table or API endpoint. PowerSync then streams the server's authoritative response back down, keeping the local DB current.

```
Crew device (SQLite)
    ↕  sync rules / JWT
PowerSync Cloud
    ↕  replication
Supabase PostgreSQL (RLS enforced)
```

The JWT passed to PowerSync on connect is the user's Supabase session access token. Sync rules use `token_parameters.user_id` to scope what data each user receives.

---

## Synced Tables

### `turnovers`
**Tenant filter:** direct — `org_id IN (SELECT org_id FROM organization_members WHERE user_id = token_parameters.user_id)`

Crew members see only turnovers belonging to their organization. Contains `org_id` in the synced schema, so filtering is straightforward.

**Upload behavior:** `PUT` operations in `uploadData()` branch on status:
- `status = 'completed'` → routed to `POST /api/crew/turnovers/[id]/complete` (Route Handler) so the `turnover/completed` Inngest pipeline fires (cleaning-fee posting, PM notification, crew-duration tracking). **Never written directly to the table.**
- Any other status → direct `supabase.from('turnovers').update({ status })` call.

> **Do not add direct `status = 'completed'` writes anywhere in the crew app.** The Route Handler is the only authorized path for that transition.

---

### `checklist_instances`
**Tenant filter:** join-based — filtered via `turnovers.org_id` since `checklist_instances` has no `org_id` column in the synced schema.

**Resolved (2026-06-11):** `org_id: column.text` added to the PowerSync schema definition (`schema.ts`). The sync rule on the PowerSync Cloud dashboard still needs to be updated to filter directly by `org_id` instead of joining through `turnovers` — see `sync_rules.yaml` and the "Changing sync rules" section below.

**Upload behavior:** read-only from the crew app. Status is derived from `checklist_instance_items`. No direct writes to this table from the client.

---

### `checklist_instance_items`
**Tenant filter:** join-based — filtered via `checklist_instances → turnovers.org_id`.

**Upload behavior:** `PUT` operations update `is_completed`, `crew_notes`, and `photo_storage_path` only. No other fields are writable from the client. `photo_storage_path` is set after a successful Supabase Storage upload (the upload itself goes directly to Storage, not through PowerSync).

---

### `inventory_items`
**Tenant filter:** join-based — `property_id` links to `properties.org_id`. Direct org filtering is not yet possible via the PowerSync Cloud sync rule.

**Resolved (2026-06-11):** `org_id: column.text` added to the PowerSync schema definition (`schema.ts`). The sync rule on the PowerSync Cloud dashboard still needs to be updated to filter directly by `org_id` instead of joining through `properties` — see `sync_rules.yaml` and the "Changing sync rules" section below.

**Upload behavior:** `PUT` operations update `current_quantity` only. Crew members can adjust stock counts on-site. No other fields are writable from the client.

---

### `properties`
**Tenant filter:** join-based — joins through `powersync_crew_properties` since `org_id` is absent from the synced schema.

**Resolved (2026-06-11):** `org_id: column.text` added to the PowerSync schema definition (`schema.ts`). `properties` contains `address`, which is sensitive enough that cross-tenant leakage would be a real problem — this allows the sync rule on the PowerSync Cloud dashboard to filter directly by `org_id` once updated. See `sync_rules.yaml` and the "Changing sync rules" section below.

**Intentionally excluded columns:** `door_code`, `wifi_password`, `owner_id`, `cleaning_cost`, and all financial fields are **not** in the synced schema and must never be added. Crew members need the property name and address to navigate — nothing more.

**Upload behavior:** read-only. No client writes to this table.

---

### `crew_availability`
**Tenant filter:** direct — `org_id IN (SELECT org_id FROM organization_members WHERE user_id = token_parameters.user_id)`. Contains `org_id` in the synced schema.

**Upload behavior:** read-only from the crew turnover app. Availability is set by crew members through a dedicated availability flow that writes through a Server Action, not PowerSync.

---

### `messages`
**Tenant filter:** direct — `org_id IN (SELECT org_id FROM organization_members WHERE user_id = token_parameters.user_id)`. Contains `org_id` in the synced schema.

Additional filter: only messages where `sender_id = token_parameters.user_id OR recipient_id = token_parameters.user_id` should be synced — crew members should not see messages between other crew members and the PM.

**Upload behavior:** crew members send messages through a Server Action. Incoming messages are read from local SQLite via `usePowerSyncQuery`.

---

## Columns Intentionally Excluded From Sync

The following column categories exist in Supabase but are **never** added to `schema.ts`. Adding any of these requires explicit architectural review and sign-off.

| Category | Examples | Reason |
|---|---|---|
| Access credentials | `door_code`, `wifi_password`, `gate_code` | Security — crew gets these verbally or via a separate secure channel |
| Financial data | `cleaning_cost`, `avg_nightly_rate`, `owner_payout` | Crew has no need for financials |
| Owner PII | `owner_id`, `owner_email`, `owner_phone` | Not relevant to crew operations |
| Service role artifacts | `stripe_customer_id`, `vault_secret_id` | Must never leave the server |
| Vendor compliance | `coi_expiry`, `license_number` | PM-only data |
| Audit fields | `audit_events.*` | Server-only |

---

## Write Path Rules

`uploadData()` in `client.ts` is the only place client-originated writes are processed. The rules are:

1. **`checklist_instance_items` PUT** → direct Supabase update, fields `is_completed`, `crew_notes`, `photo_storage_path` only.
2. **`turnovers` PUT, `status = 'completed'`** → Route Handler `POST /api/crew/turnovers/[id]/complete` only. Never a direct table write.
3. **`turnovers` PUT, any other status** → direct Supabase update, field `status` only.
4. **`inventory_items` PUT** → direct Supabase update, field `current_quantity` only.
5. **Any other table or operation type** → currently ignored (no `uploadData` handler). If you add a new writable table, add an explicit handler here. Never add a catch-all.

---

## Sync Rules File (`sync_rules.yaml`)

`sync_rules.yaml` is the source-of-truth for what data syncs to each device. It lives in this directory for version control but is applied by uploading to the PowerSync Cloud dashboard for the project (`NEXT_PUBLIC_POWERSYNC_URL`).

**Any change to `sync_rules.yaml` must be applied to the dashboard manually after merging.** There is currently no automated deployment of sync rules. A comment at the top of the file records the last-applied date.

### Changing sync rules

Before adding a table or column to `schema.ts`:

1. Determine the tenant filter for the new table. Direct (`org_id` column present) is strongly preferred over join-based.
2. Write the bucket definition in `sync_rules.yaml` and have it reviewed in the PR.
3. Verify the filter is correct — a mistake here syncs data cross-tenant to every crew device on the platform with no server-side protection (PowerSync local SQLite has no RLS).
4. After the PR merges, apply the updated `sync_rules.yaml` to the PowerSync Cloud dashboard.
5. Test on a real device that a crew member in Org A cannot see data from Org B.

### Changing upload behavior

Before adding a new writable table or field to `uploadData()`:

1. Confirm the write does not need to trigger any Inngest workflow. If it does, route through a Route Handler (see `turnovers` → `completed` as the pattern), not a direct table write.
2. Confirm the field being written is safe to accept from a client-controlled source. Server Actions and Route Handlers enforce `requireCrewMember()` and derive `org_id` server-side. Direct Supabase writes from `uploadData()` rely entirely on RLS being correct.
3. Add the handler explicitly in `uploadData()`. Never use a catch-all.

---

## Open Findings

These are known gaps tracked for remediation. Do not close them by working around them — fix them properly.

| Finding | Description | Fix |
|---|---|---|
| `properties` sync rule still join-based | `org_id: column.text` added to `schema.ts` (2026-06-11), but the PowerSync Cloud dashboard sync rule still joins through `powersync_crew_properties`. Cross-tenant address leakage possible if bucket is misconfigured. | Update `sync_rules.yaml` and the PowerSync Cloud dashboard to filter `properties` directly by `org_id`. |
| `checklist_instances` sync rule still join-based | `org_id: column.text` added to `schema.ts` (2026-06-11), but the sync rule still joins through `turnovers`. | Update `sync_rules.yaml` and the PowerSync Cloud dashboard to filter `checklist_instances` directly by `org_id`. |
| `inventory_items` sync rule still join-based | `org_id: column.text` added to `schema.ts` (2026-06-11), but the sync rule still joins through `properties`. | Update `sync_rules.yaml` and the PowerSync Cloud dashboard to filter `inventory_items` directly by `org_id`. |
