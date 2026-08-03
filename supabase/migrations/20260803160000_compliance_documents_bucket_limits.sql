-- compliance-documents was the ONLY storage bucket with no file_size_limit and
-- no allowed_mime_types — every other bucket carries both (5–10 MB plus an
-- explicit type list). That mattered more here than the NULLs suggest: the
-- upload at app/(dashboard)/vendors/[id]/compliance-section.tsx:65 goes
-- browser → Supabase Storage directly and never traverses our Next.js server,
-- so no route handler, no proxy limiter and no checkLimit() sits in that path.
-- The `accept=".pdf,.jpg,.jpeg,.png,.webp"` attribute on the file input is a
-- picker hint only; it is trivially bypassed and enforces nothing.
--
-- The bucket therefore accepted arbitrary content types at arbitrary size from
-- any admin/manager/owner in any org, bounded only by the project-wide upload
-- ceiling. Bucket-level limits are the only enforcement point that path has.
--
-- Size limit matches the sibling private buckets (turnover-photos,
-- work-order-photos: 10 MB). PDF leads the type list because COIs and licenses
-- are overwhelmingly PDFs; the image types cover a photographed certificate.
--
-- HEIC is deliberately OMITTED even though every other bucket here allows it.
-- Those buckets hold crew photo streams rendered inside the app; this one
-- holds documents a PM opens in a browser tab to read and verify. Chrome,
-- Firefox and Edge do not render HEIC — only Safari does — so allowing it
-- would let a vendor submit a certificate their reviewer cannot open. The
-- client refuses it at selection time instead
-- (app/(dashboard)/vendors/[id]/compliance-section.tsx), and
-- unit/guardrails/compliance-upload-mime-parity.test.ts keeps the two lists
-- identical.

UPDATE storage.buckets
SET file_size_limit    = 10485760,  -- 10 MB, same as turnover-photos/work-order-photos
    allowed_mime_types = ARRAY[
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp'
    ]
WHERE id = 'compliance-documents';
