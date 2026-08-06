-- ============================================================================
-- One vendor per email address per org.
--
-- dispatchWorkOrderToVendor is about to start CREATING a vendor when the PM
-- types an email that is not in the address book — the "one-off contractor"
-- case the dispatch dialog has always offered. Without a uniqueness rule, two
-- dispatches to the same new address (a double-click, a retry after a slow
-- response, two PMs working the same crew flag) each insert their own vendor
-- row. That is not merely untidy: every vendor row gets its own
-- stripe_connect_token, so each one earns a SEPARATE Stripe Connect account
-- and a separate onboarding email to the same contractor, and only one of them
-- can ever be paid for a given work order.
--
-- lower(email) rather than email: the resolve path matches case-insensitively
-- (ILIKE), so a constraint on the raw column would let Bob@x.com and
-- bob@x.com coexist while the lookup treats them as the same vendor — the
-- exact ambiguity that makes "which row do we pay?" unanswerable.
--
-- Partial on email IS NOT NULL: a vendor with no email on file is legitimate
-- (a phone-only contractor the PM tracks manually), and there can be many.
--
-- Safe to add as-is: production holds 12 vendors with 12 distinct emails, so
-- nothing violates it today.
-- ============================================================================

CREATE UNIQUE INDEX IF NOT EXISTS vendors_org_id_lower_email_key
  ON public.vendors (org_id, lower(email))
  WHERE email IS NOT NULL;

NOTIFY pgrst, 'reload schema';
