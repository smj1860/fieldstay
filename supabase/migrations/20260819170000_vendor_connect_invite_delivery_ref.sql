-- 20260819170000_vendor_connect_invite_delivery_ref.sql
-- ============================================================================
-- A DURABLE DELIVERY REFERENCE for the vendor Connect invite email.
--
-- Closes GitHub #574: "Make Stripe vendor Connect invite delivery idempotent".
--
-- ── The defect ──────────────────────────────────────────────────────────────
--
-- lib/stripe/vendor-connect-invite.ts sends the invite, then writes
-- stripe_connect_invite_sent_at. That write is deliberately non-fatal — the
-- email has already gone out, so throwing would not un-send it. But when it
-- fails, the only durable record that delivery happened is lost, and the next
-- cron tick / work-order dispatch / PM resend sees an unsent invite and sends
-- the vendor a SECOND email.
--
-- The transient claim (stripe_connect_invite_claimed_at) does not help: it is
-- released in a `finally` and goes stale after two minutes by design.
--
-- ── Why a reference rather than just a provider idempotency key ─────────────
--
-- Resend supports an Idempotency-Key header, but a key is only useful if the
-- RETRY presents the same one. Deriving it from something already on the row
-- (the vendor id) would make it stable forever — which breaks the PM's
-- "Resend" button, whose entire purpose is to deliver another email.
--
-- So the key is stored, not derived:
--
--   * the automatic path (cron, dispatch) REUSES a stored reference, so a
--     retry after a failed sent-status write presents the same key and Resend
--     rejects the duplicate;
--   * the PM resend ROTATES it, so a deliberate resend is a genuinely new
--     delivery and is not deduplicated away.
--
-- ── Retention ───────────────────────────────────────────────────────────────
--
-- The column is cleared when a send THROWS (that email was not delivered, so
-- the next attempt must be a fresh delivery, not a deduplicated no-op) and
-- rotated on each PM resend. It is otherwise kept indefinitely: it is a single
-- uuid on a row that already exists, and clearing it on success would discard
-- the only thing that makes the sent-status retry safe.
--
-- ⚠️ Resend's own idempotency window is 24 HOURS. Inside it, a stale
-- sent-status cannot produce a duplicate email at all. Outside it the key is
-- no longer recognised and the reference degrades to what it replaced. That is
-- acceptable here because the automatic senders retry on a nightly cadence, so
-- the sent-status write has a full day of attempts inside the window — but it
-- is a real bound, and it is why this is a reference rather than a guarantee.
-- ============================================================================

ALTER TABLE vendors
  ADD COLUMN IF NOT EXISTS stripe_connect_invite_delivery_ref uuid;

COMMENT ON COLUMN vendors.stripe_connect_invite_delivery_ref IS
  'Durable reference for one vendor Connect invite delivery, used as the Resend '
  'Idempotency-Key. Reused by the automatic senders so a retry after a failed '
  'stripe_connect_invite_sent_at write cannot deliver a second email; rotated by '
  'the PM resend so a deliberate resend is not deduplicated. Cleared when a send '
  'throws. See lib/stripe/vendor-connect-invite.ts and GitHub #574.';
