-- Adds checklist_instance_items to the supabase_realtime publication so
-- crew members working the same turnover simultaneously see each other's
-- checkmarks live via postgres_changes, rather than only on next app
-- reload. Also adds turnover_assignments and work_orders — both already
-- have client-side .on('postgres_changes', ...) subscriptions in
-- lib/dexie/context.tsx, but neither table was ever added to this
-- publication, so those existing subscriptions have been silently
-- non-functional (they .subscribe() successfully but Postgres never
-- broadcasts changes for a table outside the publication).
ALTER PUBLICATION supabase_realtime ADD TABLE public.checklist_instance_items;
ALTER PUBLICATION supabase_realtime ADD TABLE public.turnover_assignments;
ALTER PUBLICATION supabase_realtime ADD TABLE public.work_orders;
