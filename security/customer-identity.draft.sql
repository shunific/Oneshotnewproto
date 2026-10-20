-- REVIEW DRAFT: apply before private receipts and booking command cutovers.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='10s';
DO $$ BEGIN
  IF current_setting('oneshot.secure_gateway_cutover',true) IS DISTINCT FROM 'reviewed' THEN
    RAISE EXCEPTION 'Stop: review and coordinate the secure customer cutover first';
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS oneshot_private;
REVOKE ALL ON SCHEMA oneshot_private FROM PUBLIC;
GRANT USAGE ON SCHEMA oneshot_private TO anon,authenticated;

-- Only the caller's own account/session can be checked. No user-editable metadata
-- supplies verification, role or session ownership. Compare session IDs as text
-- so missing/malformed JWT claims deny access instead of raising a cast error.
CREATE OR REPLACE FUNCTION oneshot_private.verified_customer()
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path='' AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.users AS u
    JOIN auth.sessions AS s ON s.user_id=u.id
    WHERE u.id=(SELECT auth.uid())
      AND u.email_confirmed_at IS NOT NULL
      AND NOT COALESCE(u.is_anonymous,false)
      AND u.deleted_at IS NULL
      AND (u.banned_until IS NULL OR u.banned_until<=statement_timestamp())
      AND s.id::text=(SELECT auth.jwt()->>'session_id')
      AND (s.not_after IS NULL OR s.not_after>statement_timestamp())
  );
$$;
REVOKE ALL ON FUNCTION oneshot_private.verified_customer() FROM PUBLIC,anon,authenticated;
-- anon needs the predicate for restrictive storage policies; null auth.uid() is false.
GRANT EXECUTE ON FUNCTION oneshot_private.verified_customer() TO anon,authenticated;
COMMIT;

-- This checks stored session revocation and explicit not_after only. Auth-service
-- inactivity/time-box cleanup is asynchronous; provider configuration still needs
-- its own real-token release verification. Never expose auth.users/auth.sessions.
