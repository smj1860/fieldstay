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
-- Limits chosen to match the sibling private buckets (turnover-photos,
-- work-order-photos: 10 MB) and to carry the document types the UI actually
-- offers. PDF is included because COIs and licenses are overwhelmingly PDFs;
-- the image types mirror the accept list so a phone photo of a certificate
-- still works.

UPDATE storage.buckets
SET file_size_limit    = 10485760,  -- 10 MB, same as turnover-photos/work-order-photos
    allowed_mime_types = ARRAY[
      'application/pdf',
      'image/jpeg',
      'image/png',
      'image/webp',
      'image/heic'
    ]
WHERE id = 'compliance-documents';
