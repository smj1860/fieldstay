-- Adds the suppression-list column checked by the onboarding email drip
-- (lib/inngest/functions/onboarding-drip.tsx) before sending emails 2-4.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS email_unsubscribed_at TIMESTAMPTZ;
