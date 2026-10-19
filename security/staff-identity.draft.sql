-- REVIEW DRAFT: apply after customer-identity and private-receipts candidates.
-- Cloud staff enrollment is an owner-controlled operation, never customer signup.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='10s';
DO $$ BEGIN
  IF current_setting('oneshot.secure_gateway_cutover',true) IS DISTINCT FROM 'reviewed' THEN
    RAISE EXCEPTION 'Stop: review and coordinate the secure staff cutover first';
  END IF;
  IF to_regprocedure('oneshot_private.verified_customer()') IS NULL THEN
    RAISE EXCEPTION 'Stop: reviewed customer identity guard required';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='storage.objects'::regclass AND polname='receipt_read_guard') THEN
    RAISE EXCEPTION 'Stop: reviewed private receipt policies required';
  END IF;
END $$;

CREATE TEMPORARY TABLE oneshot_staff_memberships_expected (
  user_id uuid PRIMARY KEY,
  venue_id text NOT NULL DEFAULT 'oneshot' CHECK (venue_id='oneshot'),
  role text NOT NULL CHECK (role IN ('cashier','manager')),
  active boolean NOT NULL DEFAULT false,
  approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT active OR approved_by IS NOT NULL)
) ON COMMIT DROP;
CREATE TABLE IF NOT EXISTS oneshot_private.staff_memberships (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id),
  venue_id text NOT NULL DEFAULT 'oneshot' CHECK (venue_id='oneshot'),
  role text NOT NULL CHECK (role IN ('cashier','manager')),
  active boolean NOT NULL DEFAULT false,
  approved_by uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT active OR approved_by IS NOT NULL)
);
-- Reapplication never resets authoritative membership rows. Compare the actual
-- authorization table to the same typed/constraint definition before accepting it.
DO $$
DECLARE actual_oid oid;
  expected_oid oid:='pg_temp.oneshot_staff_memberships_expected'::regclass;
  shapes jsonb; column_name text;
BEGIN
  LOCK TABLE oneshot_private.staff_memberships IN ACCESS EXCLUSIVE MODE;
  actual_oid:='oneshot_private.staff_memberships'::regclass;
  IF (SELECT relkind FROM pg_class WHERE oid=actual_oid)<>'r' THEN
    RAISE EXCEPTION 'Stop: incompatible existing staff membership relation';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_inherits WHERE inhrelid=actual_oid OR inhparent=actual_oid) THEN
    RAISE EXCEPTION 'Stop: incompatible existing staff membership inheritance';
  END IF;
  WITH targets AS (SELECT unnest(ARRAY[actual_oid,expected_oid]) AS target_oid),
  definitions AS (
    SELECT t.target_oid,jsonb_build_object(
      'relation',(SELECT jsonb_build_array(c.relkind,c.relowner,c.relispartition)
        FROM pg_class c WHERE c.oid=t.target_oid),
      'columns',(SELECT jsonb_agg(jsonb_build_array(a.attnum,a.attname,a.atttypid,a.atttypmod,
          a.attnotnull,a.attidentity,a.attgenerated,a.attcollation,a.attacl,a.attinhcount,a.attislocal,pg_get_expr(d.adbin,d.adrelid,false)) ORDER BY a.attnum)
        FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        WHERE a.attrelid=t.target_oid AND a.attnum>0 AND NOT a.attisdropped),
      'constraints',(SELECT jsonb_agg(jsonb_build_array(c.contype,pg_get_constraintdef(c.oid,false),
          c.convalidated,c.condeferrable,c.condeferred,c.connoinherit,c.conislocal,c.coninhcount)
          ORDER BY c.contype,pg_get_constraintdef(c.oid,false))
        FROM pg_constraint c WHERE c.conrelid=t.target_oid AND c.contype<>'f'),
      'customTriggers',(SELECT count(*) FROM pg_trigger g WHERE g.tgrelid=t.target_oid AND NOT g.tgisinternal),
      'rules',(SELECT count(*) FROM pg_rewrite r WHERE r.ev_class=t.target_oid)
    ) AS shape FROM targets t
  ) SELECT jsonb_object_agg(target_oid::text,shape) INTO shapes FROM definitions;
  -- PostgreSQL temporary tables cannot reference permanent auth.users. Check
  -- the two foreign keys separately against their exact authoritative target.
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid=actual_oid AND contype='f')<>2 THEN
    RAISE EXCEPTION 'Stop: incompatible existing staff membership foreign keys';
  END IF;
  FOREACH column_name IN ARRAY ARRAY['user_id','approved_by'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid=actual_oid AND c.contype='f'
      AND c.conkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid=actual_oid AND attname=column_name)]::smallint[]
      AND c.confrelid='auth.users'::regclass
      AND c.confkey=ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid='auth.users'::regclass AND attname='id')]::smallint[]
      AND c.convalidated AND NOT c.condeferrable AND NOT c.condeferred
      AND c.confupdtype='a' AND c.confdeltype='a' AND c.confmatchtype='s'
      AND c.conislocal AND c.coninhcount=0) THEN
      RAISE EXCEPTION 'Stop: incompatible existing staff membership foreign keys';
    END IF;
  END LOOP;
  IF shapes->actual_oid::text IS DISTINCT FROM shapes->expected_oid::text
    OR (SELECT relpersistence FROM pg_class WHERE oid=actual_oid)<>'p' THEN
    RAISE EXCEPTION 'Stop: incompatible existing staff membership table; review schema before reapplying';
  END IF;
END $$;
ALTER TABLE oneshot_private.staff_memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE oneshot_private.staff_memberships FROM PUBLIC,anon,authenticated;

CREATE OR REPLACE FUNCTION oneshot_private.staff_role()
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT m.role FROM oneshot_private.staff_memberships AS m
  WHERE m.user_id=(SELECT auth.uid()) AND m.venue_id='oneshot' AND m.active
    AND m.approved_by IS NOT NULL AND (SELECT oneshot_private.verified_customer());
$$;
REVOKE ALL ON FUNCTION oneshot_private.staff_role() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION oneshot_private.staff_role() TO authenticated;

CREATE OR REPLACE FUNCTION oneshot_private.verified_staff()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT oneshot_private.staff_role() IS NOT NULL;
$$;
REVOKE ALL ON FUNCTION oneshot_private.verified_staff() FROM PUBLIC,anon,authenticated;
-- Restrictive storage SELECT policies also run for anon; this reveals only own status.
GRANT EXECUTE ON FUNCTION oneshot_private.verified_staff() TO anon,authenticated;

CREATE OR REPLACE FUNCTION oneshot_private.staff_identity()
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $$
DECLARE member_role text := oneshot_private.staff_role();
BEGIN
  IF member_role IS NULL THEN
    RAISE EXCEPTION 'TRUSTED_STAFF_REQUIRED' USING ERRCODE='42501';
  END IF;
  RETURN (SELECT jsonb_build_object('userId',u.id,'venueId','oneshot','role',member_role,'email',u.email)
    FROM auth.users AS u WHERE u.id=(SELECT auth.uid()));
END $$;
REVOKE ALL ON FUNCTION oneshot_private.staff_identity() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION oneshot_private.staff_identity() TO authenticated;
CREATE OR REPLACE FUNCTION public.oneshot_staff_identity()
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path='' AS $$
  SELECT oneshot_private.staff_identity();
$$;
REVOKE ALL ON FUNCTION public.oneshot_staff_identity() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.oneshot_staff_identity() TO authenticated;

DROP POLICY receipt_read_guard ON storage.objects;
CREATE POLICY receipt_read_guard ON storage.objects AS RESTRICTIVE FOR SELECT TO PUBLIC
USING (bucket_id <> 'oneshot-receipts' OR (
  (SELECT oneshot_private.verified_staff())
  OR ((SELECT oneshot_private.verified_receipt_customer())
    AND owner_id=(SELECT auth.uid())::text
    AND split_part(name,'/',1)=(SELECT auth.uid())::text)
));
-- Existing permissive receipt_owner_read permits authenticated reads; the restrictive
-- guard above decides owner versus approved staff. INSERT/UPDATE/DELETE remain untouched.
COMMIT;

-- Enrollment runbook (review and execute only as the database/project owner):
-- 1. Have each staff member sign up/verify their own Supabase account and record UUID.
-- 2. Verify employment/venue and approver UUID outside user-editable metadata.
-- 3. In a reviewed owner transaction, INSERT membership inactive with exact UUID/role;
--    inspect the row, then set approved_by to the approving owner's UUID and active=true.
-- 4. Test with that member's real JWT: own identity, receipt read and denied mutations.
-- 5. To revoke immediately, UPDATE the exact membership SET active=false; verify denial.
-- No public enrollment RPC, seed membership, local-POS auto-import or self-promotion exists.
-- Reviewed owner SQL template, using operator-supplied psql variables (not defaults):
-- BEGIN;
-- INSERT INTO oneshot_private.staff_memberships(user_id,venue_id,role,active)
-- VALUES (:'staff_user_id'::uuid,'oneshot',:'staff_role',false);
-- SELECT user_id,venue_id,role,active FROM oneshot_private.staff_memberships
-- WHERE user_id=:'staff_user_id'::uuid;
-- UPDATE oneshot_private.staff_memberships SET approved_by=:'approver_user_id'::uuid,active=true
-- WHERE user_id=:'staff_user_id'::uuid AND venue_id='oneshot' AND NOT active;
-- COMMIT;
-- Revocation: UPDATE oneshot_private.staff_memberships SET active=false
-- WHERE user_id=:'staff_user_id'::uuid AND venue_id='oneshot';
