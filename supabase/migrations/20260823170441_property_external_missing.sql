-- A property whose PMS listing the provider no longer recognises.
--
-- WHY THIS EXISTS
--
-- On 2026-08-19 a Hospitable incremental sync created a second `properties`
-- row for one org — same name, a different `external_id`, zero bookings and
-- zero turnovers. Hospitable stopped returning that uuid shortly afterwards,
-- and from 2026-08-22 the daily calendar cron dispatched a sync for it every
-- morning, got 404 "No result found.", exhausted its retries, and raised a
-- Sentry error. Every day. Nothing in the system could ever resolve it,
-- because nothing recorded that the listing was gone.
--
-- WHY A 404 AND NOT ABSENCE FROM THE LIST
--
-- The obvious fix — deactivate any property missing from the provider's
-- property list — is the exact shape that deactivated an org's entire crew
-- roster on 2026-07-18 (see the `absence-reconciliation` guardrail). A
-- truncated page, a filtered response or a transient error makes every row
-- absent at once, and properties are the highest-consequence thing in the
-- schema to switch off: bookings, turnovers and calendar sync all hang from
-- them.
--
-- A 404 on `GET /properties/{uuid}/calendar` is different in kind. It is
-- POSITIVE, PER-PROPERTY evidence about one id that the provider was asked
-- about directly. It cannot be manufactured by truncation, and it says nothing
-- about any other property. That is what makes it safe to act on where absence
-- is not.
--
-- WHAT IT DOES AND DELIBERATELY DOES NOT DO
--
-- Setting this PAUSES the property's calendar sync and tells the PM. It does
-- NOT set `is_active = false`: a property carrying real bookings and turnovers
-- must not be switched off by a provider hiccup, and the PM is the one who
-- decides whether a vanished listing means "delisted" or "relisted under a new
-- id". The column is cleared automatically the moment any sync sees the
-- external_id again, so a provider outage self-heals with no intervention.

ALTER TABLE properties
  ADD COLUMN IF NOT EXISTS external_missing_since timestamptz;

COMMENT ON COLUMN properties.external_missing_since IS
  'When the PMS first returned 404 for this external_id. Set by a provider sync handler, cleared automatically when the provider lists the property again. Pauses per-property provider polling; deliberately does NOT deactivate the property.';
