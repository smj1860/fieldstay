-- Guest messaging is out of scope. comms_log / messages (crew <-> PM) are
-- separate tables and are NOT affected by this migration.
-- Verified: message_trigger / message_status are used only by these two tables.
DROP TABLE IF EXISTS public.guest_messages_sent;
DROP TABLE IF EXISTS public.guest_message_templates;

DROP TYPE IF EXISTS public.message_trigger;
DROP TYPE IF EXISTS public.message_status;
