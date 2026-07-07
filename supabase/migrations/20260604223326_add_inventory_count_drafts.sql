
CREATE TABLE IF NOT EXISTS public.inventory_count_drafts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id UUID NOT NULL REFERENCES public.properties(id) ON DELETE CASCADE,
  org_id      UUID NOT NULL,
  submitted_by UUID,
  status      TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.inventory_count_draft_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id    UUID NOT NULL REFERENCES public.inventory_count_drafts(id) ON DELETE CASCADE,
  item_id     UUID NOT NULL REFERENCES public.inventory_items(id) ON DELETE CASCADE,
  counted_qty INTEGER NOT NULL DEFAULT 0,
  note        TEXT
);

ALTER TABLE public.inventory_count_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_count_draft_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members can manage inventory count drafts"
  ON public.inventory_count_drafts FOR ALL
  USING (org_id IN (SELECT org_id FROM public.organization_members WHERE user_id = auth.uid()));

CREATE POLICY "org members can manage inventory count draft items"
  ON public.inventory_count_draft_items FOR ALL
  USING (draft_id IN (
    SELECT id FROM public.inventory_count_drafts
    WHERE org_id IN (SELECT org_id FROM public.organization_members WHERE user_id = auth.uid())
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_count_drafts TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_count_draft_items TO anon, authenticated;
