-- Guest PII retention: unlike communication_logs (comms_log_retention_days),
-- bookings guest_name/guest_email and guidebook_guest_sms_optins.phone_e164
-- had no retention/anonymization path and accumulate indefinitely.

ALTER TABLE organizations
  ADD COLUMN IF NOT EXISTS guest_pii_retention_days SMALLINT NOT NULL DEFAULT 730;

COMMENT ON COLUMN organizations.guest_pii_retention_days IS
  'Days after a booking''s checkout_date before guest_name/guest_email/door
   code are anonymized by the daily guest-PII retention cron. Mirrors
   comms_log_retention_days. Default 730 days (~2 years) balances guest PII
   minimization against typical tax/ownership-dispute recordkeeping windows.';

ALTER TABLE bookings
  ADD COLUMN IF NOT EXISTS guest_pii_anonymized_at TIMESTAMPTZ DEFAULT NULL;

COMMENT ON COLUMN bookings.guest_pii_anonymized_at IS
  'Set by the daily guest-PII retention cron when guest_name/guest_email/
   door code are cleared. NULL = guest PII (if any) is still present.';
