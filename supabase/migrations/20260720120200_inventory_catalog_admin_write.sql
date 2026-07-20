-- inventory_catalog (the 115-item global seed catalog every org's inventory
-- template picker reads from) has only ever had a public-read policy
-- ("Anyone can read inventory catalog") — no INSERT/UPDATE/DELETE policy
-- exists anywhere, so nobody can edit it today. Adds write access gated to
-- platform admins, for the new admin catalog editor.

GRANT INSERT, UPDATE, DELETE ON TABLE public.inventory_catalog TO authenticated;
GRANT INSERT, UPDATE, DELETE ON TABLE public.inventory_catalog TO service_role;

CREATE POLICY "inventory_catalog_admin_manage"
  ON public.inventory_catalog FOR INSERT
  WITH CHECK (is_platform_staff_admin());

CREATE POLICY "inventory_catalog_admin_update"
  ON public.inventory_catalog FOR UPDATE
  USING      (is_platform_staff_admin())
  WITH CHECK (is_platform_staff_admin());

CREATE POLICY "inventory_catalog_admin_delete"
  ON public.inventory_catalog FOR DELETE
  USING (is_platform_staff_admin());
