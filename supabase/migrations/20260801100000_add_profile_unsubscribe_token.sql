-- ============================================================================
-- BLOCKER (CAN-SPAM): commercial email had no opt-out mechanism at all.
--
-- 20260707145406 added profiles.email_unsubscribed_at, and onboarding-drip
-- READS it to suppress emails 2 and 3 — but a grep of the whole repo shows
-- NOTHING ever WRITES it: no route, no server action, no Resend webhook. And
-- no email template contained an unsubscribe link. So the suppression check
-- was permanently dead code and the promotional sequences (welcome drip,
-- guidebook feature announcement, re-engagement, price-lock) shipped with no
-- way for a recipient to opt out.
--
-- This adds the per-profile token the public unsubscribe route resolves. Same
-- shape and generation as org_invites.token — encode(gen_random_bytes(32),
-- 'hex'), a 64-char hex string — deliberately NOT a uuid: gen_random_uuid()
-- is only 122 bits and is not designed to be unguessable, and this token is
-- the sole credential on an unauthenticated route.
--
-- A stored token rather than an HMAC of the user id because the signing-secret
-- alternative would need a new production env var (a deploy that fails closed
-- until someone sets it), and because CLAUDE.md confines
-- SUPABASE_SERVICE_ROLE_KEY to lib/supabase/server.ts — enforced by both an
-- ESLint rule and a semgrep chokepoint sitting at 0 findings — so deriving a
-- subkey from it at a call site is not available either.
--
-- No RLS policy change: profiles' existing policies stay as they are. The
-- unsubscribe route is unauthenticated by necessity (CAN-SPAM forbids
-- requiring a login to opt out), so it resolves the token with the service
-- client and validates in-file, the same publicSurface pattern the owner
-- portal uses.
-- ============================================================================

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS unsubscribe_token TEXT;

-- Backfill every existing row before the NOT NULL/UNIQUE work below. Existing
-- profiles predate the column, and a profile with a NULL token can never be
-- given a working unsubscribe link.
UPDATE public.profiles
   SET unsubscribe_token = encode(gen_random_bytes(32), 'hex')
 WHERE unsubscribe_token IS NULL;

ALTER TABLE public.profiles
  ALTER COLUMN unsubscribe_token SET DEFAULT encode(gen_random_bytes(32), 'hex');

ALTER TABLE public.profiles
  ALTER COLUMN unsubscribe_token SET NOT NULL;

-- UNIQUE because the token is looked up on its own to identify a profile; a
-- duplicate would make that lookup ambiguous. Also satisfies the DB invariant
-- gate's rule that token-ish columns be backed by a real unique index.
CREATE UNIQUE INDEX IF NOT EXISTS profiles_unsubscribe_token_uniq
  ON public.profiles (unsubscribe_token);

NOTIFY pgrst, 'reload schema';
