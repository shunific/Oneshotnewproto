-- REVIEW DRAFT ONLY. No existing public receipt URLs are revoked by this file.
-- Coordinate customer booking references and trusted staff access before rollout.
-- Reapply only through the atomic bundle: the later staff guard must be restored
-- in the same transaction before this owner-only base policy can become visible.
-- SET oneshot.private_receipts_cutover = 'reviewed' is an explicit rollout gate.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DO $$
BEGIN
  IF current_setting('oneshot.private_receipts_cutover', true) IS DISTINCT FROM 'reviewed' THEN
    RAISE EXCEPTION 'Stop: deploy and verify private receipt callers and booking ownership checks first';
  END IF;
  IF to_regprocedure('oneshot_private.verified_customer()') IS NULL THEN
    RAISE EXCEPTION 'Stop: apply the reviewed customer identity guard first';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='storage.objects'::regclass AND relrowsecurity) THEN
    RAISE EXCEPTION 'Stop: storage.objects must already have RLS enabled';
  END IF;
  IF EXISTS (SELECT 1 FROM storage.buckets WHERE id='oneshot-receipts' AND public) THEN
    RAISE EXCEPTION 'Stop: existing public oneshot-receipts requires a separate leakage/migration review';
  END IF;
END $$;

INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
VALUES ('oneshot-receipts','oneshot-receipts',false,5242880,ARRAY['image/jpeg','image/png'])
ON CONFLICT (id) DO UPDATE SET file_size_limit=EXCLUDED.file_size_limit,
  allowed_mime_types=EXCLUDED.allowed_mime_types;

CREATE SCHEMA IF NOT EXISTS oneshot_private;
REVOKE ALL ON SCHEMA oneshot_private FROM PUBLIC,anon;
GRANT USAGE ON SCHEMA oneshot_private TO anon,authenticated;

-- Only checks the calling user's own verified status. Never accepts an arbitrary UUID.
-- auth.users is intentionally not exposed to customer SELECT privileges.
CREATE OR REPLACE FUNCTION oneshot_private.verified_receipt_customer()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT oneshot_private.verified_customer();
$$;
REVOKE ALL ON FUNCTION oneshot_private.verified_receipt_customer() FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION oneshot_private.verified_receipt_customer() TO anon,authenticated;

DROP POLICY IF EXISTS receipt_owner_insert ON storage.objects;
CREATE POLICY receipt_owner_insert ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id='oneshot-receipts');
DROP POLICY IF EXISTS receipt_owner_read ON storage.objects;
CREATE POLICY receipt_owner_read ON storage.objects FOR SELECT TO authenticated
USING (bucket_id='oneshot-receipts');

-- Restrictive guards AND with every permissive policy, including legacy PUBLIC policies.
-- Existing policies on other buckets keep their existing behavior.
DROP POLICY IF EXISTS receipt_insert_guard ON storage.objects;
CREATE POLICY receipt_insert_guard ON storage.objects AS RESTRICTIVE FOR INSERT TO PUBLIC
WITH CHECK (bucket_id <> 'oneshot-receipts' OR (
  (SELECT auth.uid()) IS NOT NULL
  AND (SELECT oneshot_private.verified_receipt_customer())
  AND owner_id=(SELECT auth.uid())::text
  AND name ~ ('^' || (SELECT auth.uid())::text || '/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$')
));
DROP POLICY IF EXISTS receipt_read_guard ON storage.objects;
CREATE POLICY receipt_read_guard ON storage.objects AS RESTRICTIVE FOR SELECT TO PUBLIC
USING (bucket_id <> 'oneshot-receipts' OR (
  (SELECT auth.uid()) IS NOT NULL
  AND (SELECT oneshot_private.verified_receipt_customer())
  AND owner_id=(SELECT auth.uid())::text
  AND split_part(name,'/',1)=(SELECT auth.uid())::text
));
DROP POLICY IF EXISTS receipt_update_guard ON storage.objects;
CREATE POLICY receipt_update_guard ON storage.objects AS RESTRICTIVE FOR UPDATE TO PUBLIC
USING (bucket_id <> 'oneshot-receipts') WITH CHECK (bucket_id <> 'oneshot-receipts');
DROP POLICY IF EXISTS receipt_delete_guard ON storage.objects;
CREATE POLICY receipt_delete_guard ON storage.objects AS RESTRICTIVE FOR DELETE TO PUBLIC
USING (bucket_id <> 'oneshot-receipts');
COMMIT;

-- No customer UPDATE/DELETE/upsert grants and no staff reads are introduced.
-- Local POS users are NOT trusted Supabase memberships. Add a separately reviewed
-- staff gateway/membership policy before staff receipt review can be released.
-- Storage API enforces bucket limits. Header checks are only client defense in depth;
-- server content inspection/malware scanning and owner-scoped orphan cleanup remain gates.
-- Do not require metadata.size here: Storage authorizeUpload probes INSERT permission
-- with metadata.contentLength before it persists the final object metadata. Bucket
-- allowed_mime_types/file_size_limit are the server MIME/size boundary, not this RLS.
