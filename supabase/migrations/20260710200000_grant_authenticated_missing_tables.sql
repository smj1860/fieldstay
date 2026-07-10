-- guidebook_property_configs and work_order_invoices were created without
-- the standard GRANT to authenticated/anon that every other client-readable
-- table has (e.g. properties, bookings) — RLS was correctly enabled and
-- policies were correctly written for both, but the missing base GRANT
-- meant every authenticated-role query failed with "permission denied for
-- table X" before RLS was ever evaluated. Confirmed live in Postgres logs
-- 2026-07-10: this is why the Guidebook admin page got stuck on
-- "Loading…" for every property (not a data issue, as an earlier
-- investigation into duplicate rows had suggested — that investigation
-- used a service-role client, which bypasses grants and RLS alike, so it
-- never could have surfaced this), and why the vendor-invoices-paid
-- section on the property/vendor/maintenance/invoice detail pages has
-- never actually returned any rows.
--
-- guidebook_configurations and guidebook_sponsors have the exact same gap
-- from the same migration but no live bug yet, since every current call
-- site happens to use the service-role client — granted here too,
-- preventively, before a future authenticated-role read hits the same
-- wall. RLS on all four tables already correctly scopes access by
-- org_id/role, so this grant doesn't widen what anyone can actually see or
-- write — it only unblocks the base privilege layer RLS sits on top of.
GRANT SELECT, INSERT, UPDATE, DELETE ON guidebook_property_configs TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON work_order_invoices        TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON guidebook_configurations   TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON guidebook_sponsors         TO authenticated, anon;
