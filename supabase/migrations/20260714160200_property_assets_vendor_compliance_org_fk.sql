-- Fix: property_assets.org_id and vendor_compliance_documents.org_id had no
-- FK to organizations, and nothing enforced that the value actually matches
-- the org of the property/vendor the row is attached to. RLS on both tables
-- trusts org_id alone (org_id IN get_user_org_ids()), so a divergence
-- (application bug, bad Inngest event payload) would be a silent
-- cross-tenant visibility bug in either direction. Deletion doesn't
-- currently orphan rows (both cascade transitively via property_id/vendor_id
-- -> properties/vendors -> organizations CASCADE), but there was no direct
-- guarantee.

ALTER TABLE public.property_assets
  ADD CONSTRAINT property_assets_org_id_fkey
  FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.vendor_compliance_documents
  ADD CONSTRAINT vendor_compliance_documents_org_id_fkey
  FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON DELETE CASCADE;

-- Belt-and-suspenders: reject any insert/update whose org_id doesn't match
-- the org_id of the property/vendor it's attached to, rather than relying
-- solely on application code to keep the two in sync.

CREATE OR REPLACE FUNCTION public.check_property_assets_org_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM (SELECT org_id FROM properties WHERE id = NEW.property_id) THEN
    RAISE EXCEPTION 'property_assets.org_id (%) does not match properties.org_id for property_id %',
      NEW.org_id, NEW.property_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_property_assets_org_id_check ON public.property_assets;
CREATE TRIGGER trg_property_assets_org_id_check
  BEFORE INSERT OR UPDATE OF org_id, property_id ON public.property_assets
  FOR EACH ROW
  EXECUTE FUNCTION public.check_property_assets_org_id();

CREATE OR REPLACE FUNCTION public.check_vendor_compliance_documents_org_id()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM (SELECT org_id FROM vendors WHERE id = NEW.vendor_id) THEN
    RAISE EXCEPTION 'vendor_compliance_documents.org_id (%) does not match vendors.org_id for vendor_id %',
      NEW.org_id, NEW.vendor_id
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_vendor_compliance_documents_org_id_check ON public.vendor_compliance_documents;
CREATE TRIGGER trg_vendor_compliance_documents_org_id_check
  BEFORE INSERT OR UPDATE OF org_id, vendor_id ON public.vendor_compliance_documents
  FOR EACH ROW
  EXECUTE FUNCTION public.check_vendor_compliance_documents_org_id();
