-- Item 2 (dashboard walkthrough): PM-side message threads never updated live.
-- Root cause: public.messages was never added to the supabase_realtime
-- publication, so postgres_changes subscriptions in messages-client.tsx
-- never received INSERT/UPDATE events. Existing RLS SELECT policy
-- (sender_id = auth.uid() OR recipient_id = auth.uid()) is compatible with
-- per-row Realtime delivery for this 1:1 thread model — no policy change needed.

alter publication supabase_realtime add table public.messages;
