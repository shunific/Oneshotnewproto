-- REVIEW DRAFT ONLY. Apply customer-identity.draft.sql and booking ownership first.
-- Coordinate with containment and this client. No guest/CAPTCHA claim flow is supplied.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='10s';
DO $$ BEGIN
 IF current_setting('oneshot.secure_gateway_cutover',true) IS DISTINCT FROM 'reviewed' THEN
  RAISE EXCEPTION 'Stop: reviewed coordinated customer cutover required';
 END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS oneshot_private;
REVOKE ALL ON SCHEMA oneshot_private FROM PUBLIC;
GRANT USAGE ON SCHEMA oneshot_private TO authenticated;
ALTER TABLE public.feedback ADD COLUMN IF NOT EXISTS customer_user_id uuid REFERENCES auth.users(id);
ALTER TABLE public.feedback ADD COLUMN IF NOT EXISTS customer_email text;
CREATE INDEX IF NOT EXISTS feedback_customer_user_id_idx ON public.feedback(customer_user_id);
CREATE TABLE IF NOT EXISTS oneshot_private.feedback_operations (
 customer_user_id uuid NOT NULL REFERENCES auth.users(id), request_id uuid NOT NULL,
 payload jsonb NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
 PRIMARY KEY(customer_user_id,request_id)
);
CREATE INDEX IF NOT EXISTS feedback_operations_rate_idx ON oneshot_private.feedback_operations(customer_user_id,created_at);
ALTER TABLE oneshot_private.feedback_operations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON oneshot_private.feedback_operations FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION oneshot_private.feedback_create(p jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 uid uuid:=auth.uid(); account_email text; v_request_id uuid; old_operation record;
 customer_name text; contact text; category text; message text; reservation_id text;
 feedback_id text; saved_at timestamptz; result jsonb;
BEGIN
 IF uid IS NULL OR NOT oneshot_private.verified_customer() THEN RAISE EXCEPTION 'VERIFIED_ACCOUNT_REQUIRED' USING ERRCODE='42501'; END IF;
 SELECT email INTO account_email FROM auth.users WHERE id=uid;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR octet_length(p::text)>16384 THEN RAISE EXCEPTION 'INVALID_PAYLOAD'; END IF;
 IF EXISTS(SELECT 1 FROM jsonb_object_keys(p) key WHERE key<>ALL(ARRAY['requestId','expectedCustomerId','customerName','contactInfo','feedbackType','comment','reservationId'])) THEN RAISE EXCEPTION 'INVALID_FIELDS'; END IF;
 IF p->>'expectedCustomerId' IS DISTINCT FROM uid::text THEN RAISE EXCEPTION 'ACCOUNT_CHANGED' USING ERRCODE='42501'; END IF;
 IF jsonb_typeof(p->'requestId') IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'INVALID_REQUEST_ID'; END IF;
 BEGIN v_request_id:=(p->>'requestId')::uuid; EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'INVALID_REQUEST_ID'; END;
 IF v_request_id IS NULL THEN RAISE EXCEPTION 'INVALID_REQUEST_ID'; END IF;
 -- A per-account transaction lock serializes quota and idempotency across connections.
 PERFORM pg_advisory_xact_lock(hashtextextended('oneshot-feedback:'||uid::text,0));
 SELECT * INTO old_operation FROM oneshot_private.feedback_operations WHERE customer_user_id=uid AND feedback_operations.request_id=v_request_id;
 IF FOUND THEN
  IF old_operation.payload<>p THEN RAISE EXCEPTION 'IDEMPOTENCY_CONFLICT'; END IF;
  RETURN old_operation.result||jsonb_build_object('replayed',true);
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(p) pair WHERE pair.key IN ('customerName','contactInfo','feedbackType','comment') AND jsonb_typeof(pair.value) IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'INVALID_FIELDS'; END IF;
 customer_name:=btrim(p->>'customerName'); contact:=btrim(p->>'contactInfo'); category:=p->>'feedbackType'; message:=btrim(p->>'comment');
 IF customer_name IS NULL OR length(customer_name) NOT BETWEEN 1 AND 120 OR message IS NULL OR length(message) NOT BETWEEN 1 AND 4000 THEN RAISE EXCEPTION 'INVALID_MESSAGE'; END IF;
 IF category IS NULL OR category<>ALL(ARRAY['suggestion','complaint','lost_item','compliment','other']) THEN RAISE EXCEPTION 'INVALID_CATEGORY'; END IF;
 IF contact IS NULL OR length(contact) NOT BETWEEN 1 AND 254 OR NOT (contact~'^(09[0-9]{9}|639[0-9]{9}|\+639[0-9]{9})$' OR contact~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$') THEN RAISE EXCEPTION 'INVALID_CONTACT'; END IF;
 IF p ? 'reservationId' AND p->'reservationId'<>'null'::jsonb THEN
  IF jsonb_typeof(p->'reservationId') IS DISTINCT FROM 'string' OR length(btrim(p->>'reservationId')) NOT BETWEEN 1 AND 100 THEN RAISE EXCEPTION 'INVALID_RESERVATION_ID'; END IF;
  reservation_id:=btrim(p->>'reservationId');
  IF reservation_id~*'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN reservation_id:=lower(reservation_id); END IF;
  PERFORM 1 FROM public.reservations WHERE id=reservation_id AND customer_user_id=uid FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'BOOKING_NOT_FOUND' USING ERRCODE='42501'; END IF;
 END IF;
 IF (SELECT count(*) FROM oneshot_private.feedback_operations WHERE customer_user_id=uid AND created_at>statement_timestamp()-interval '15 minutes')>=5 THEN RAISE EXCEPTION 'FEEDBACK_RATE_LIMIT'; END IF;
 feedback_id:=gen_random_uuid()::text; saved_at:=clock_timestamp();
 INSERT INTO public.feedback(id,customername,"customerName","contactInfo",feedbacktype,"feedbackType",comment,reservationid,"reservationId",tags,date,status,notes,customer_user_id,customer_email)
 VALUES(feedback_id,customer_name,customer_name,contact,category,category,message,reservation_id,reservation_id,jsonb_build_array(category)::text,saved_at,'pending',NULL,uid,account_email);
 result:=jsonb_build_object('feedback',jsonb_build_object('id',feedback_id,'customer_user_id',uid,'status','pending','date',saved_at),'replayed',false);
 INSERT INTO oneshot_private.feedback_operations(customer_user_id,request_id,payload,result) VALUES(uid,v_request_id,p,result);
 RETURN result;
END $$;
REVOKE ALL ON FUNCTION oneshot_private.feedback_create(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION oneshot_private.feedback_create(jsonb) TO authenticated;
CREATE OR REPLACE FUNCTION public.oneshot_feedback_create(payload jsonb) RETURNS jsonb
LANGUAGE sql SECURITY INVOKER SET search_path='' AS $$SELECT oneshot_private.feedback_create(payload)$$;
REVOKE ALL ON FUNCTION public.oneshot_feedback_create(jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.oneshot_feedback_create(jsonb) TO authenticated;
ALTER TABLE public.feedback ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.feedback FROM PUBLIC,anon,authenticated;
COMMIT;
