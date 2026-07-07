
CREATE TABLE IF NOT EXISTS public.inventory_templates (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id      UUID NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.inventory_template_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID NOT NULL REFERENCES public.inventory_templates(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  category    TEXT,
  unit        TEXT,
  par_qty     INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE public.inventory_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_template_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "org members can manage inventory templates"
  ON public.inventory_templates FOR ALL
  USING (org_id IN (SELECT org_id FROM public.organization_members WHERE user_id = auth.uid()));

CREATE POLICY "org members can manage inventory template items"
  ON public.inventory_template_items FOR ALL
  USING (template_id IN (
    SELECT id FROM public.inventory_templates
    WHERE org_id IN (SELECT org_id FROM public.organization_members WHERE user_id = auth.uid())
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_templates TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.inventory_template_items TO anon, authenticated;
