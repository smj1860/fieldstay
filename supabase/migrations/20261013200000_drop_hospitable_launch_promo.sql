-- Drop the Hospitable launch promo's schema.
--
-- The promo period ended and the application side was removed in the previous
-- commit. This takes the storage with it rather than leaving two tables and
-- three functions nothing reads.
--
-- SAFE BECAUSE IT NEVER RAN. Production at drop time: 0 rows in
-- hospitable_launch_promo, both tier counters at 0, since launch on
-- 2026-07-30. No org was ever tagged, converted or awarded a lock, so nothing
-- here is a customer record and there is no history to preserve.
--
-- Two of the three functions are SECURITY DEFINER. Leaving those behind would
-- be the worse half of this cleanup: a privileged function nothing calls is
-- exactly the shape 20260801280000's authz-gate work exists to keep out of the
-- schema, and `claim_hospitable_promo_slot` writes to a counter table while
-- bypassing RLS.
--
-- Order matters only for the trigger function: the trigger goes with its table
-- under CASCADE, and set_hospitable_promo_updated_at is dropped after the
-- table it was attached to.

DROP TABLE IF EXISTS public.hospitable_launch_promo CASCADE;
DROP TABLE IF EXISTS public.promo_hospitable_launch_counter CASCADE;

DROP FUNCTION IF EXISTS public.claim_hospitable_promo_slot(uuid, text, integer);
DROP FUNCTION IF EXISTS public.tag_hospitable_trial_signup(uuid, boolean);
DROP FUNCTION IF EXISTS public.set_hospitable_promo_updated_at();
