
-- Tracks how many times a response has been regenerated after initial generation.
-- Limit: 2 for auto-synced reviews, 0 for manually-pasted reviews.
-- The initial generation (creating the response) does not count toward this limit.
ALTER TABLE review_responses
  ADD COLUMN IF NOT EXISTS regeneration_count INTEGER NOT NULL DEFAULT 0;

-- Index for quick lookups on the generate route
CREATE INDEX IF NOT EXISTS idx_review_responses_review_id
  ON review_responses(review_id);
