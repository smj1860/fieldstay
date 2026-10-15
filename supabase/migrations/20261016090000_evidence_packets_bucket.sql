-- Evidence phase 3 — the `evidence-packets` bucket: generated claim packet PDFs.
--
-- PRIVATE, org-scoped, mirroring `inspection-photos` (20260822194607). Every
-- object MUST be `${orgId}/...`, produced by orgScopedStoragePath(); the policies
-- read the first path segment via public.storage_org_prefix().
--
-- Who may do what:
--   SELECT: any member of the owning org.
--   INSERT/UPDATE/DELETE: NO authenticated policy, on purpose. A packet is
--   written only by the evidence-packet Inngest function on the service role,
--   after it has rendered and hashed the document. A PM cannot upload, replace
--   or delete a packet through the Storage API: the packet is an evidentiary
--   artifact, and its sha256 is recorded in the append-only evidence ledger.
--   Deleting the owning org or property removes it with the tenant.

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'evidence-packets',
  'evidence-packets',
  false,
  52428800,                                    -- 50MB: up to MAX_PACKET_PHOTOS compressed photos
  ARRAY['application/pdf']
)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "evidence_packets_select" ON storage.objects;

CREATE POLICY "evidence_packets_select"
  ON storage.objects FOR SELECT
  TO authenticated
  USING (
    bucket_id = 'evidence-packets'
    AND public.storage_org_prefix(name) IN (SELECT public.get_user_org_ids())
  );
