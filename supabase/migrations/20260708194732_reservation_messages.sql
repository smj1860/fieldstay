-- Stores inbound/outbound guest<->host conversation messages synced from
-- Hospitable's "message.created" webhook (GET /v2/reservations/{uuid}/messages
-- for the full content, since the webhook payload only carries identifiers).
-- Distinct from guest_messages_sent (dropped in 20260611000006_drop_guest_messaging_tables.sql)
-- and guest_message_templates: those were for FieldStay-authored automated
-- outbound messages built from a template. This table is a read-only mirror
-- of the actual reservation conversation thread as it exists on the OTA/PMS
-- side — both guest- and host-authored messages, verbatim, not templated.
CREATE TABLE IF NOT EXISTS public.reservation_messages (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                   uuid        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  booking_id               uuid        REFERENCES public.bookings(id) ON DELETE SET NULL,
  external_reservation_id  text        NOT NULL,
  external_source          text        NOT NULL DEFAULT 'hospitable',
  conversation_id          text,
  platform                 text,
  sender_type              text        NOT NULL CHECK (sender_type IN ('host', 'guest')),
  sender_name              text,
  content_type             text,
  body                     text        NOT NULL,
  attachments              jsonb,
  source                   text,
  message_created_at       timestamptz NOT NULL,
  -- Hospitable's message list endpoint exposes no per-message id — derived
  -- from conversation_id + created_at + sender_type + a short hash of body,
  -- computed by the Inngest sync handler, so re-processing the same webhook
  -- (or re-fetching the same reservation) never inserts a duplicate row.
  dedup_key                text        NOT NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, dedup_key)
);

CREATE INDEX IF NOT EXISTS idx_reservation_messages_org_id      ON public.reservation_messages(org_id);
CREATE INDEX IF NOT EXISTS idx_reservation_messages_booking_id  ON public.reservation_messages(booking_id);
CREATE INDEX IF NOT EXISTS idx_reservation_messages_external    ON public.reservation_messages(external_reservation_id, external_source);
CREATE INDEX IF NOT EXISTS idx_reservation_messages_conversation ON public.reservation_messages(conversation_id);

ALTER TABLE public.reservation_messages ENABLE ROW LEVEL SECURITY;

-- Read-only for org members. Writes happen exclusively through the Inngest
-- incremental-sync handler using the service-role client (RLS bypassed
-- intentionally there) — no authenticated INSERT/UPDATE/DELETE policy is
-- defined, so those operations are denied for the authenticated role.
CREATE POLICY "reservation_messages_select"
  ON public.reservation_messages FOR SELECT
  USING (org_id IN (SELECT get_user_org_ids()));

GRANT SELECT ON public.reservation_messages TO authenticated;
GRANT ALL ON public.reservation_messages TO service_role;
