-- Attribution for crew-flagged work orders placed from the crew Assets &
-- Maintenance page — lets the PM see "Reported by: <name>" directly on the
-- work order without a separate audit-log lookup.
ALTER TABLE public.work_orders
  ADD COLUMN IF NOT EXISTS reported_by_crew_member_id uuid REFERENCES public.crew_members(id);

CREATE INDEX IF NOT EXISTS idx_work_orders_reported_by_crew_member_id
  ON public.work_orders(reported_by_crew_member_id)
  WHERE reported_by_crew_member_id IS NOT NULL;
