-- Service/repair manual links for assets, keyed by (org_id, asset_type, make,
-- model) rather than per-asset-instance — the same appliance model shows up
-- across many properties in an org, so one lookup covers all of them. We
-- store a LINK to the manufacturer's own manual/support page, not a copy of
-- the file itself: avoids a file-storage/redistribution pipeline entirely,
-- always reflects the manufacturer's latest revision, and a field tech can
-- save/print the manufacturer's own page however they want. The tradeoff
-- (link rot over an appliance's 10-20 year life) is cheaper to solve later
-- with a periodic link-health-check cron than the storage pipeline would be
-- to build now.
CREATE TABLE IF NOT EXISTS asset_manuals (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  asset_type  asset_type NOT NULL,
  make        text NOT NULL,
  model       text NOT NULL,
  -- NULL source_url means a lookup was attempted and found nothing (still
  -- recorded so repeated asset saves with the same make/model don't
  -- re-trigger an LLM lookup every time — see asset-manual-lookup.ts).
  source_url  text,
  found_via   text CHECK (found_via IN ('search')),
  verified_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, asset_type, make, model)
);

CREATE TRIGGER asset_manuals_updated_at
  BEFORE UPDATE ON asset_manuals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE asset_manuals ENABLE ROW LEVEL SECURITY;

CREATE POLICY "asset_manuals_select"
  ON asset_manuals FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

CREATE POLICY "asset_manuals_manage"
  ON asset_manuals FOR ALL
  USING    (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]))
  WITH CHECK (is_org_member(org_id, ARRAY['admin'::member_role, 'manager'::member_role]));

-- Explicit base grant — some tables created via migration this project have
-- been found missing this entirely (see FUTURE_REMEDIATION history,
-- guidebook_property_configs/work_order_invoices), which silently breaks
-- every authenticated-role query with "permission denied for table X"
-- regardless of how correct the RLS policies above are. Always include this.
GRANT SELECT, INSERT, UPDATE, DELETE ON asset_manuals TO authenticated, anon;
