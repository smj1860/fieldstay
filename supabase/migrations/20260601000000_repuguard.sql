-- Reviews synced from OwnerRez
CREATE TABLE IF NOT EXISTS public.reviews (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id             uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  property_id        uuid        REFERENCES properties(id) ON DELETE SET NULL,
  external_id        text        NOT NULL,
  external_source    text        NOT NULL DEFAULT 'ownerrez',
  guest_name         text,
  rating             integer     NOT NULL CHECK (rating BETWEEN 1 AND 5),
  review_text        text        NOT NULL,
  review_date        timestamptz,
  response_status    text        NOT NULL DEFAULT 'pending'
                                 CHECK (response_status IN ('pending','draft','ready','posted')),
  external_url       text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE(external_id, external_source)
);

CREATE INDEX IF NOT EXISTS idx_reviews_org_id      ON public.reviews(org_id);
CREATE INDEX IF NOT EXISTS idx_reviews_property_id ON public.reviews(property_id);
CREATE INDEX IF NOT EXISTS idx_reviews_status      ON public.reviews(response_status);

CREATE TABLE IF NOT EXISTS public.review_responses (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id          uuid        NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  org_id             uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  generated_response text,
  edited_response    text,
  word_count         integer,
  tone_used          text,
  flags              text[]      NOT NULL DEFAULT '{}',
  flag_reason        text,
  generated_at       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_review_responses_review_id
  ON public.review_responses(review_id);

ALTER TABLE public.organizations
  ADD COLUMN IF NOT EXISTS repuguard_status               text        DEFAULT 'inactive'
    CHECK (repuguard_status IN ('inactive','trial','active','cancelled')),
  ADD COLUMN IF NOT EXISTS repuguard_trial_start          timestamptz,
  ADD COLUMN IF NOT EXISTS repuguard_trial_end            timestamptz,
  ADD COLUMN IF NOT EXISTS repuguard_stripe_subscription_id text,
  ADD COLUMN IF NOT EXISTS repuguard_founding_member      boolean     NOT NULL DEFAULT false;

ALTER TABLE public.reviews         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.review_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Org members can read their reviews"
  ON public.reviews FOR SELECT
  USING (org_id IN (
    SELECT org_id FROM organization_members WHERE user_id = auth.uid()
  ));

CREATE POLICY "Org members can read their review responses"
  ON public.review_responses FOR SELECT
  USING (org_id IN (
    SELECT org_id FROM organization_members WHERE user_id = auth.uid()
  ));

GRANT SELECT, INSERT, UPDATE, DELETE ON public.reviews          TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.review_responses TO anon, authenticated;
