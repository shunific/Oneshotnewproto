-- Website CMS: track when each CMS row (including gallery images) was first
-- added, so an upload can never replace an older, valid image with a blank or
-- stale value.
--
-- The live `cms` table uses lower-case column names (`keyname`,
-- `settingvalue`, `updatedat`).  The new column is intentionally quoted so the
-- camelCase name requested by the app (`dateAdded`) is preserved by Postgres
-- and PostgREST.

ALTER TABLE public.cms
  ADD COLUMN IF NOT EXISTS "dateAdded" timestamp with time zone;

-- Existing rows are as old as their last update; use that as the best known
-- creation time instead of stamping them all with "now".
UPDATE public.cms
   SET "dateAdded" = COALESCE(updatedat, now())
 WHERE "dateAdded" IS NULL;

ALTER TABLE public.cms
  ALTER COLUMN "dateAdded" SET DEFAULT now();

-- A row's creation date must never move forward when it is updated.  Upserts
-- that omit the column keep the original value, and explicit values from a
-- client are ignored on update.
CREATE OR REPLACE FUNCTION public.cms_set_date_added()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    NEW."dateAdded" := COALESCE(NEW."dateAdded", NEW.updatedat, now());
  ELSE
    NEW."dateAdded" := OLD."dateAdded";
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS cms_set_date_added ON public.cms;
CREATE TRIGGER cms_set_date_added
  BEFORE INSERT OR UPDATE ON public.cms
  FOR EACH ROW
  EXECUTE FUNCTION public.cms_set_date_added();
