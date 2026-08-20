-- reservation_messages.body: drop NOT NULL.
--
-- Hospitable sends body: null for an attachment-only message (an image or a
-- file with no accompanying text). The column was declared NOT NULL on the
-- assumption that every message has text; HospitableMessage.body was typed
-- `string` on the same assumption. Neither is true.
--
-- The failure was not "one message is skipped". The sync upserts a whole
-- reservation's messages in ONE statement, so Postgres rejected the entire
-- batch — 23502 on one row discards every good row alongside it, and the
-- Inngest step then threw and retried the identical batch to exhaustion.
-- Three production runs failed this way on 2026-08-18 and 2026-08-19
-- (system_job_runs: 'reservation_messages upsert failed: null value in
-- column "body" ... violates not-null constraint'), each taking that
-- reservation's ENTIRE conversation history down with it.
--
-- Nullable rather than DEFAULT '': an attachment-only message genuinely has
-- no body, and '' would make it indistinguishable from a message whose text
-- the provider failed to give us. Readers must render attachments in that
-- case, which they can only decide to do if the distinction survives.
--
-- dedup_key is unaffected: it is computed application-side from
-- conversation_id | created_at | sender_type | body, where a null body
-- stringifies to a stable literal. See the comment at its definition in
-- 20260708194732_reservation_messages.sql and the derivation in
-- lib/inngest/functions/hospitable/incremental-sync.ts.
ALTER TABLE public.reservation_messages
  ALTER COLUMN body DROP NOT NULL;

COMMENT ON COLUMN public.reservation_messages.body IS
  'Message text. NULL for an attachment-only message (Hospitable sends body: null); read attachments in that case.';
