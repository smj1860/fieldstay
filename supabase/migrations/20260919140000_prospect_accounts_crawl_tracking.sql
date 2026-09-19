-- Tracking columns for the admin-triggered comparent.com re-crawl
-- (lib/inngest/functions/prospecting-crawl.ts). Added on prospect_accounts
-- rather than a new table: this is per-row state about ONE thing (the last
-- fetch of that row's own comparent_url), not a log — prospect_touches
-- above is the log, and a crawl re-fetch is not a sales touch.
--
-- last_crawled_at is also the ORDERING column the crawl dispatcher uses to
-- pick its next batch (oldest-crawled-first, NULLS FIRST so a row that has
-- never been crawled always sorts ahead of one that has) — round-robin
-- coverage across repeated runs falls out of that ordering for free, with
-- no separate cursor/offset state to keep in sync.

ALTER TABLE public.prospect_accounts
  ADD COLUMN last_crawled_at timestamptz,
  ADD COLUMN crawl_status    text,
  ADD COLUMN crawl_error     text;

ALTER TABLE public.prospect_accounts
  ADD CONSTRAINT prospect_accounts_crawl_status_check
  CHECK (crawl_status IS NULL OR crawl_status IN ('ok', 'no_website', 'error'));

-- The dispatcher's candidate-selection query filters on comparent_url IS NOT
-- NULL and orders by last_crawled_at — this index covers exactly that scan.
CREATE INDEX prospect_accounts_crawl_candidates_idx
  ON public.prospect_accounts (last_crawled_at NULLS FIRST)
  WHERE comparent_url IS NOT NULL AND comparent_url <> '';

COMMENT ON COLUMN public.prospect_accounts.last_crawled_at IS
  'When comparent_url was last fetched by the admin-triggered re-crawl.
   NULL means never crawled. Drives the dispatcher''s oldest-first batch
   selection — do not repurpose for anything else without checking that.';

COMMENT ON COLUMN public.prospect_accounts.crawl_status IS
  'Outcome of the last crawl fetch: ok (extracted fine, may still be a
   comparent stub with few fields), no_website (fetched, but the profile
   names no company site), error (fetch/parse failed — see crawl_error).
   NULL means never crawled, same as last_crawled_at.';
