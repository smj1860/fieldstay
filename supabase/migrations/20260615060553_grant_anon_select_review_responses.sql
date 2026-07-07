-- review_responses: restore anon SELECT grant that was unintentionally removed.
-- RepuGuard review display reads from this table.
GRANT SELECT ON public.review_responses TO anon;
