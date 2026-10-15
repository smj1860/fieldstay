-- Per-property high-claim photo spots. Injected into every turnover checklist
-- as mandatory photo items (lib/evidence/room-photos.ts). PM-editable on the
-- property page. Seeded with DEFAULT_CLAIM_SPOTS on the property's first
-- turnover after this ships, never on property create.
CREATE TABLE IF NOT EXISTS public.property_evidence_spots (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id       uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  property_id  uuid NOT NULL REFERENCES public.properties(id)     ON DELETE CASCADE,
  section_name text NOT NULL,
  label        text NOT NULL,
  label_es     text,
  sort_order   integer NOT NULL DEFAULT 0,
  is_active    boolean NOT NULL DEFAULT true,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT property_evidence_spots_label_len CHECK (char_length(label) BETWEEN 2 AND 120),
  CONSTRAINT property_evidence_spots_unique UNIQUE (property_id, section_name, label)
);

CREATE INDEX IF NOT EXISTS property_evidence_spots_org_idx      ON public.property_evidence_spots (org_id);
CREATE INDEX IF NOT EXISTS property_evidence_spots_property_idx ON public.property_evidence_spots (property_id, is_active);

ALTER TABLE public.property_evidence_spots ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS property_evidence_spots_select ON public.property_evidence_spots;
DROP POLICY IF EXISTS property_evidence_spots_manage ON public.property_evidence_spots;

CREATE POLICY property_evidence_spots_select ON public.property_evidence_spots
  FOR SELECT TO authenticated
  USING (org_id IN (SELECT public.get_user_org_ids()));

CREATE POLICY property_evidence_spots_manage ON public.property_evidence_spots
  FOR ALL TO authenticated
  USING      (public.is_org_member(org_id, ARRAY['admin'::public.member_role, 'manager'::public.member_role]))
  WITH CHECK (public.is_org_member(org_id, ARRAY['admin'::public.member_role, 'manager'::public.member_role]));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.property_evidence_spots TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.property_evidence_spots TO service_role;

-- Standard updated_at trigger
CREATE OR REPLACE FUNCTION public.property_evidence_spots_touch_updated_at()
RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS trg_property_evidence_spots_touch ON public.property_evidence_spots;
CREATE TRIGGER trg_property_evidence_spots_touch
  BEFORE UPDATE ON public.property_evidence_spots
  FOR EACH ROW EXECUTE FUNCTION public.property_evidence_spots_touch_updated_at();
REVOKE EXECUTE ON FUNCTION public.property_evidence_spots_touch_updated_at() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.checklist_instance_items
  DROP CONSTRAINT IF EXISTS checklist_instance_items_evidence_spot_id_fkey;
ALTER TABLE public.checklist_instance_items
  ADD CONSTRAINT checklist_instance_items_evidence_spot_id_fkey
    FOREIGN KEY (evidence_spot_id) REFERENCES public.property_evidence_spots(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS checklist_instance_items_evidence_spot_idx
  ON public.checklist_instance_items (evidence_spot_id) WHERE evidence_spot_id IS NOT NULL;

COMMENT ON COLUMN public.checklist_instance_items.evidence_spot_id IS
  'The property_evidence_spots row a claim_spot item was injected from. The PM UI soft-deletes spots (is_active = false) so history keeps its link; the FK is SET NULL only as a backstop.';
