DO $$
BEGIN
  IF (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='tables') <> 2
     OR (SELECT count(*) FROM pg_policies WHERE schemaname='public' AND tablename='tables' AND cmd='SELECT' AND qual='true' AND with_check IS NULL AND ((policyname='Public can view billiard tables' AND roles=ARRAY['anon','authenticated']::name[]) OR (policyname='allow public table select' AND roles=ARRAY['anon']::name[]))) <> 2 THEN
    RAISE EXCEPTION 'Table read policy changed; review before enabling RLS';
  END IF;
END $$;
ALTER TABLE public.tables ENABLE ROW LEVEL SECURITY;

