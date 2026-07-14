-- property_assets.replaced_by_asset_id had no ON DELETE clause (defaults to
-- RESTRICT), so deleting a replacement asset would error instead of nulling
-- out the pointer on the asset it superseded. Not a tenant-isolation issue,
-- just a lifecycle footgun.

ALTER TABLE public.property_assets
  DROP CONSTRAINT IF EXISTS property_assets_replaced_by_asset_id_fkey;

ALTER TABLE public.property_assets
  ADD CONSTRAINT property_assets_replaced_by_asset_id_fkey
  FOREIGN KEY (replaced_by_asset_id) REFERENCES public.property_assets(id) ON DELETE SET NULL;
