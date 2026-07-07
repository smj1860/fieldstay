
ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS assigned_crew_member_id UUID REFERENCES public.crew_members(id) ON DELETE SET NULL;
