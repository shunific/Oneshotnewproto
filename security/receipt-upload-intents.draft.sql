-- REVIEW CANDIDATE ONLY. Apply after the coordinated customer/private/staff cutover.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='10s';
DO $$ BEGIN
  IF current_setting('oneshot.secure_gateway_cutover',true) IS DISTINCT FROM 'reviewed'
    OR current_setting('oneshot.private_receipts_cutover',true) IS DISTINCT FROM 'reviewed' THEN
    RAISE EXCEPTION 'Stop: review coordinated receipt upload intent cutover first';
  END IF;
  IF to_regprocedure('oneshot_private.verified_customer()') IS NULL
    OR to_regprocedure('storage.allow_only_operation(text)') IS NULL
    OR to_regclass('public.reservations') IS NULL
    OR NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id='oneshot-receipts' AND NOT public
      AND file_size_limit=5242880 AND allowed_mime_types=ARRAY['image/jpeg','image/png']::text[])
    OR NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='storage.objects'::regclass AND polname='receipt_insert_guard' AND NOT polpermissive) THEN
    RAISE EXCEPTION 'Stop: reviewed private receipt identity, bucket and owner guard required';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS oneshot_private.receipt_upload_intents (
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  request_id uuid NOT NULL,
  payload jsonb NOT NULL,
  path text NOT NULL UNIQUE,
  declared_mime text NOT NULL CHECK(declared_mime IN ('image/jpeg','image/png')),
  declared_size integer NOT NULL CHECK(declared_size BETWEEN 1 AND 5242880),
  sha256 text NOT NULL CHECK(sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY(owner_user_id,request_id),
  CHECK(expires_at=created_at+interval '15 minutes'),
  CHECK(path ~ ('^'||owner_user_id::text||'/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png)$'))
);
ALTER TABLE oneshot_private.receipt_upload_intents ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE oneshot_private.receipt_upload_intents FROM PUBLIC,anon,authenticated;
CREATE INDEX IF NOT EXISTS receipt_upload_intents_owner_created_idx
  ON oneshot_private.receipt_upload_intents(owner_user_id,created_at);

CREATE OR REPLACE FUNCTION oneshot_private.receipt_upload_intent(p jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
  uid uuid := auth.uid(); req uuid; clock_time timestamptz := statement_timestamp();
  item oneshot_private.receipt_upload_intents%rowtype; replay boolean := false;
  mime text; declared_bytes integer;
BEGIN
  -- Revoked/banned accounts may not recover even an old successful request.
  IF NOT oneshot_private.verified_customer() THEN
    RAISE EXCEPTION 'VERIFIED_ACCOUNT_REQUIRED' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>2048
    OR EXISTS (SELECT 1 FROM jsonb_object_keys(p) k WHERE NOT(k=ANY(ARRAY['requestId','expectedCustomerId','contentType','byteSize','sha256']))) THEN
    RAISE EXCEPTION 'INVALID_RECEIPT_INTENT';
  END IF;
  IF p->>'expectedCustomerId' IS DISTINCT FROM uid::text THEN
    RAISE EXCEPTION 'ACCOUNT_CHANGED' USING ERRCODE='42501';
  END IF;
  IF jsonb_typeof(p->'requestId') IS DISTINCT FROM 'string'
    OR p->>'requestId' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    OR jsonb_typeof(p->'contentType') IS DISTINCT FROM 'string'
    OR p->>'contentType' NOT IN ('image/jpeg','image/png')
    OR jsonb_typeof(p->'byteSize') IS DISTINCT FROM 'number'
    OR p->>'byteSize' !~ '^[0-9]{1,7}$'
    OR jsonb_typeof(p->'sha256') IS DISTINCT FROM 'string'
    OR p->>'sha256' !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'INVALID_RECEIPT_INTENT';
  END IF;
  req:=(p->>'requestId')::uuid; mime:=p->>'contentType'; declared_bytes:=(p->>'byteSize')::integer;
  IF declared_bytes NOT BETWEEN 1 AND 5242880 THEN RAISE EXCEPTION 'INVALID_RECEIPT_INTENT'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('oneshot:receipt-intents:'||uid::text,0));
  clock_time:=clock_timestamp();
  IF NOT oneshot_private.verified_customer() THEN
    RAISE EXCEPTION 'VERIFIED_ACCOUNT_REQUIRED' USING ERRCODE='42501';
  END IF;
  SELECT * INTO item FROM oneshot_private.receipt_upload_intents WHERE owner_user_id=uid AND request_id=req;
  IF FOUND THEN
    IF item.payload<>p THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
    replay:=true;
  ELSE
    -- Every issued unlinked path reserves a slot, including expired unused ones.
    -- Storage permission probes can roll back before a superuser final write;
    -- neither intent expiry nor object visibility safely proves an upload ended.
    IF (SELECT count(*) FROM oneshot_private.receipt_upload_intents AS i
      WHERE i.owner_user_id=uid
        AND NOT EXISTS (SELECT 1 FROM public.reservations AS r WHERE r."receiptImg"=i.path))>=5 THEN
      RAISE EXCEPTION 'RECEIPT_UNLINKED_LIMIT';
    END IF;
    IF (SELECT count(*) FROM oneshot_private.receipt_upload_intents WHERE owner_user_id=uid
      AND created_at>clock_time-interval '15 minutes')>=5 THEN
      RAISE EXCEPTION 'RECEIPT_UPLOAD_LIMIT';
    END IF;
    INSERT INTO oneshot_private.receipt_upload_intents(owner_user_id,request_id,payload,path,declared_mime,declared_size,sha256,created_at,expires_at)
    VALUES(uid,req,p,uid::text||'/'||gen_random_uuid()::text||CASE WHEN mime='image/png' THEN '.png' ELSE '.jpg' END,
      mime,declared_bytes,p->>'sha256',clock_time,clock_time+interval '15 minutes') RETURNING * INTO item;
  END IF;
  -- Expired replay retains its original path/expiry for existing-object recovery only.
  RETURN jsonb_build_object('bucket','oneshot-receipts','path',item.path,'declaredSize',item.declared_size,
    'declaredMime',item.declared_mime,'sha256',item.sha256,'expiresAt',item.expires_at,
    'uploadAllowed',item.expires_at>clock_timestamp(),'replayed',replay);
END $$;
REVOKE ALL ON FUNCTION oneshot_private.receipt_upload_intent(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION oneshot_private.receipt_upload_intent(jsonb) TO authenticated;
CREATE OR REPLACE FUNCTION public.oneshot_receipt_upload_intent(payload jsonb)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$
  SELECT oneshot_private.receipt_upload_intent(payload);
$$;
REVOKE ALL ON FUNCTION public.oneshot_receipt_upload_intent(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.oneshot_receipt_upload_intent(jsonb) TO authenticated;

CREATE OR REPLACE FUNCTION oneshot_private.has_receipt_upload_intent(p_path text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path='' AS $$
DECLARE uid uuid:=auth.uid();
BEGIN
  IF uid IS NULL THEN RETURN false; END IF;
  -- Serialize direct caller INSERT checks with allocation and recheck fresh time.
  -- Storage may roll back this permission probe before its final superuser write;
  -- the hard allocation bound therefore counts ALL issued unlinked paths above.
  PERFORM pg_advisory_xact_lock(hashtextextended('oneshot:receipt-intents:'||uid::text,0));
  IF NOT oneshot_private.verified_customer() THEN RETURN false; END IF;
  RETURN EXISTS (
    SELECT 1 FROM oneshot_private.receipt_upload_intents AS i
    WHERE i.owner_user_id=uid AND i.path=p_path AND i.expires_at>clock_timestamp()
  );
END;
$$;
REVOKE ALL ON FUNCTION oneshot_private.has_receipt_upload_intent(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION oneshot_private.has_receipt_upload_intent(text) TO anon,authenticated;
DROP POLICY IF EXISTS receipt_upload_intent_guard ON storage.objects;
CREATE POLICY receipt_upload_intent_guard ON storage.objects AS RESTRICTIVE FOR INSERT TO PUBLIC
WITH CHECK(bucket_id<>'oneshot-receipts' OR (
  storage.allow_only_operation('object.upload')
  AND (SELECT oneshot_private.has_receipt_upload_intent(name))
));
DROP POLICY IF EXISTS receipt_authenticated_read_guard ON storage.objects;
CREATE POLICY receipt_authenticated_read_guard ON storage.objects AS RESTRICTIVE FOR SELECT TO PUBLIC
USING(bucket_id<>'oneshot-receipts' OR storage.allow_only_operation('object.get_authenticated'));
COMMIT;

-- SHA256, MIME and byte count above are customer declarations bound to an intent,
-- not server verification of uploaded bytes. Bucket/API limits remain the MIME/size
-- enforcement boundary. Content scanning/hash verification and orphan retention
-- require separate trusted processing; this draft does not claim those capabilities.
-- Five issued unlinked paths require finishing a booking or reviewed staff help;
-- this policy neither deletes evidence nor implements a trusted cleanup workflow.
-- Expired unused paths are NOT automatically reclaimed. A future owner cleanup
-- must establish final-write completion before releasing them; that workflow is
-- an explicit release/failed-ticket support gate and is not implemented here.
-- Standard uploads only: signed-upload URL minting, copy, TUS and S3 operations
-- must not mint capabilities that outlive this guard. The current hosted Storage
-- helper/operation implementation must be verified before rollout. Direct SQL
-- INSERT transaction tests do not prove Storage API final-write lock semantics.
-- Receipt reads likewise require authenticated object download, never signed URL
-- minting/listing/direct Data API SELECT. Existing leaked public/signed capabilities
-- still require their separate migration/revocation/expiry review.
