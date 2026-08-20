-- reservation_messages.external_reservation_id: drop NOT NULL.
--
-- A Hospitable message webhook captured 2026-08-20 carries
-- "reservation_id": null — and that is CORRECT, not a missing field. The
-- message is a pre-booking INQUIRY: a guest asking about a property that has
-- no reservation yet. Hospitable's own thread key is conversation_id, which is
-- always present; reservation_id is an optional attribute a thread acquires
-- once it turns into a booking.
--
-- The column being NOT NULL is what forced the old design to treat a
-- reservation as the identity of a message thread, which is why it fetched
-- GET /reservations/{uuid}/messages, and why it could store nothing at all for
-- an inquiry. Inquiries are the half of the inbox a PM most needs to answer.
--
-- The table name stays. Renaming it to `guest_messages` would be a truer
-- description now, but it is referenced across the app, lib/demo/seed.ts and
-- the RLS policies, and a rename buys accuracy in one place at the cost of a
-- migration touching all of them. Noted rather than done.
ALTER TABLE public.reservation_messages
  ALTER COLUMN external_reservation_id DROP NOT NULL;

COMMENT ON COLUMN public.reservation_messages.external_reservation_id IS
  'Provider reservation id, or NULL for a pre-booking inquiry thread that has no reservation yet. conversation_id is the thread key; this is an attribute.';

-- Threads are read and rendered by conversation. The existing index on
-- conversation_id alone is not org-scoped, so every such read has to filter
-- after the index rather than inside it.
CREATE INDEX IF NOT EXISTS idx_reservation_messages_org_conversation
  ON public.reservation_messages (org_id, conversation_id, message_created_at);
