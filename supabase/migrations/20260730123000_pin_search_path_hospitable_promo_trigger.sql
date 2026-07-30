-- The Supabase security advisor flagged set_hospitable_promo_updated_at()
-- (from 20260727150000_hospitable_launch_promo.sql) with a role-mutable
-- search_path. The function body references no relations, so an empty pinned
-- search_path is safe and silences the advisor the standard way.
ALTER FUNCTION public.set_hospitable_promo_updated_at() SET search_path = '';
