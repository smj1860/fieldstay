-- Follow-up to 20260720170645: keeps the hard_blocked_at column comment's
-- day count in sync with the widened grace period.
COMMENT ON COLUMN vendor_compliance_documents.hard_blocked_at IS
  'Timestamp when the document passed day 46 post-expiry and the
   hard block was enforced. Stored for audit trail purposes.';
