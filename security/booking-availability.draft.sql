-- Coordinated customer cutover candidate. Never apply independently of its caller migration.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '10s';
DO $$ BEGIN
  IF current_setting('oneshot.secure_gateway_cutover', true) IS DISTINCT FROM 'reviewed' THEN
    RAISE EXCEPTION 'Stop: review and coordinate the secure customer cutover first';
  END IF;
END $$;
CREATE SCHEMA IF NOT EXISTS oneshot_private;
REVOKE ALL ON SCHEMA oneshot_private FROM PUBLIC;
GRANT USAGE ON SCHEMA oneshot_private TO anon, authenticated;
CREATE OR REPLACE FUNCTION oneshot_private.availability(p_from date, p_to date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  today date := (statement_timestamp() AT TIME ZONE 'Asia/Manila')::date;
  announcement_rows jsonb := '[]'; cms_rows jsonb := '{}';
  table_rows jsonb := '[]'; busy_rows jsonb := '[]'; settings_rows jsonb := '[]';
  configuration_issues jsonb := '[]';
  closure_rows jsonb := '[]'; promo_rows jsonb := '[]'; event_rows jsonb := '[]';
  t record; s jsonb; active boolean; safe_status text;
  cfg jsonb; setting_key text; raw text; value numeric; minimum numeric; maximum numeric; prefix text;
  capacity_valid boolean:=true; party_valid boolean:=true; pricing_valid boolean:=true; hours_valid boolean:=true;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_from < today - 1 OR p_to < p_from OR p_to - p_from > 31 OR p_to > today + 90 THEN
    RAISE EXCEPTION 'Availability requires a valid range of at most 31 days within the next 90 days' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(*) FROM public.tables) > 500 THEN
    RAISE EXCEPTION 'Availability configuration needs review';
  END IF;
  FOR t IN SELECT id,name,status,isactive,"isActive",sessiondata,"sessionData" FROM public.tables ORDER BY id LOOP
    active := t.isactive = 1 AND t."isActive" = 1;
    safe_status := CASE WHEN t.status IN ('available','occupied','reserved','maintenance','event') THEN t.status ELSE 'maintenance' END;
    s := NULL;
    -- Legacy aliases must agree. Invalid or open-ended sessions block the table without leaking their contents.
    IF t.sessiondata IS NOT NULL AND t."sessionData" IS NOT NULL AND t.sessiondata IS DISTINCT FROM t."sessionData" THEN
      active := false; safe_status := 'maintenance';
    ELSIF COALESCE(t.sessiondata,t."sessionData") IS NOT NULL THEN
      BEGIN
        s := COALESCE(t.sessiondata,t."sessionData")::jsonb;
        IF s->>'kind'='trusted-native-move-hold' AND safe_status='reserved' THEN
          active:=false;s:=NULL;
        ELSIF s='null'::jsonb OR s='{}'::jsonb THEN
          s:=NULL;
          IF safe_status='occupied' THEN active:=false; safe_status:='maintenance'; END IF;
        ELSIF jsonb_typeof(s) <> 'object' OR NOT (s ? 'startTime') OR (s->>'isOpenTime')::boolean IS DISTINCT FROM false
          OR (s->>'durationMinutes')::numeric <= 0 OR (s->>'durationMinutes')::numeric > 1440
          OR s->>'durationMinutes' IS NULL OR s->>'startTime' IS NULL THEN
          active := false; safe_status := 'maintenance'; s := NULL;
        ELSE
          PERFORM (s->>'startTime')::timestamptz;
          s := jsonb_build_object('startTime',s->>'startTime','durationMinutes',(s->>'durationMinutes')::numeric,'isOpenTime',false);
        END IF;
      EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
        active := false; safe_status := 'maintenance'; s := NULL;
      END;
    ELSIF safe_status = 'occupied' THEN
      active := false; safe_status := 'maintenance';
    END IF;
    IF safe_status IN ('occupied','event') THEN active := false; END IF;
    table_rows := table_rows || jsonb_build_array(jsonb_build_object('id',t.id,'name',t.name,'status',safe_status,'isActive',COALESCE(active,false),'session',s));
  END LOOP;
  IF EXISTS (SELECT 1 FROM public.reservations WHERE date IS NULL AND COALESCE(status,'') NOT IN ('cancelled','completed','pending-refund')) THEN
    RAISE EXCEPTION 'Availability contains an unresolved booking date';
  END IF;
  IF (SELECT count(*) FROM public.reservations WHERE date BETWEEN p_from - 1 AND p_to AND COALESCE(status,'') NOT IN ('cancelled','completed','pending-refund')) > 5000 THEN
    RAISE EXCEPTION 'Availability volume requires a smaller range';
  END IF;
  IF EXISTS (SELECT 1 FROM public.reservations WHERE date BETWEEN p_from - 1 AND p_to AND COALESCE(status,'') NOT IN ('cancelled','completed','pending-refund')
    AND ("timeSlot" IS NULL OR "timeSlot" !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' OR "durationHours" IS NULL OR "durationHours" NOT BETWEEN 1 AND 24 OR "tableId" IS NULL)) THEN
    RAISE EXCEPTION 'Availability contains an unresolved booking interval';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('tableId',"tableId",'date',date,'timeSlot',"timeSlot",'durationHours',"durationHours",'status','confirmed') ORDER BY date,"timeSlot"),'[]')
    INTO busy_rows FROM public.reservations WHERE date BETWEEN p_from - 1 AND p_to AND COALESCE(status,'') NOT IN ('cancelled','completed','pending-refund');
  SELECT COALESCE(jsonb_agg(jsonb_build_object('key_name',key_name,'setting_value',setting_value) ORDER BY key_name),'[]') INTO settings_rows
  FROM public.system_settings WHERE key_name IN (
    'hourlyRate','overtimeRate','downPaymentPercent','bookingCutoffMinutes','weekdayStartTime','weekdayEndTime','weekendStartTime','weekendEndTime',
    'isWeekdayHappyHourActive','weekdayHappyHourRate','weekdayHappyHourStart','weekdayHappyHourEnd','isWeekendHappyHourActive','weekendHappyHourRate',
    'weekendHappyHourStart','weekendHappyHourEnd','weekdayOnlineCapacityLimit','weekendOnlineCapacityLimit','minHours','maxHours','cancellationHours',
    'advanceBookingHours','bookingCapacityMode','weekdayMinPartySize','weekdayMaxPartySize','weekendMinPartySize','weekendMaxPartySize','cancellationPolicy','termsAndConditions');
  IF (SELECT count(*) FROM public.closed_dates WHERE (type = 'weekly' OR closed_date BETWEEN p_from - 1 AND p_to) AND status IS DISTINCT FROM 'cancelled' AND cancelled_at IS NULL) > 500 THEN
    RAISE EXCEPTION 'Closure configuration requires review';
  END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'date',closed_date,'reason',reason,'isFullDay',is_full_day,'openTime',open_time,'closeTime',close_time,'type',type,'dayOfWeek',day_of_week)),'[]')
    INTO closure_rows FROM public.closed_dates WHERE (type = 'weekly' OR closed_date BETWEEN p_from - 1 AND p_to) AND status IS DISTINCT FROM 'cancelled' AND cancelled_at IS NULL;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'code',code,'discountPercent',discount_percent,'description',description,'isActive',is_active,
    'isLimitedUses',is_limited_uses,'exhausted',is_limited_uses AND COALESCE(usage_count,0) >= COALESCE(max_usage,0),'startDate',start_date,'expiresAt',expires_at)),'[]')
    INTO promo_rows FROM public.promo_codes WHERE is_active = true AND (expires_at IS NULL OR expires_at > statement_timestamp()) AND (start_date IS NULL OR start_date <= statement_timestamp());
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'title',title,'date',date,'type',type,'description',description,'allowReservations',allowreservations=1,
    'caterWalkIns',caterwalkins=1,'walkInTableCount',walkintablecount)),'[]') INTO event_rows FROM public.events WHERE date BETWEEN p_from - 1 AND p_to
    AND COALESCE(iscancelled,0)=0 AND status IS DISTINCT FROM 'cancelled' AND cancelled_at IS NULL;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'title',title,'content',content,'type',type,'isActive',true,'createdAt',createdat,'expiresAt',expiresat)),'[]')
    INTO announcement_rows FROM public.announcements WHERE isactive=1 AND (expiresat IS NULL OR expiresat>statement_timestamp());
  SELECT COALESCE(jsonb_object_agg(keyname,settingvalue),'{}') INTO cms_rows FROM public.cms WHERE keyname IN ('heroImages','aboutImage');
  SELECT COALESCE(jsonb_object_agg(entry.value->>'key_name',entry.value->>'setting_value'),'{}')
    INTO cfg FROM jsonb_array_elements(settings_rows) AS entry(value);
  FOREACH setting_key IN ARRAY ARRAY['weekdayOnlineCapacityLimit','weekendOnlineCapacityLimit'] LOOP
    raw:=btrim(cfg->>setting_key);
    IF raw IS NULL OR length(raw)>64 OR raw!~'^[0-9]+([.][0-9]+)?$' THEN
      capacity_valid:=false;
    ELSE
      value:=raw::numeric;
      IF value<0 OR value>9007199254740991 OR value<>trunc(value) THEN capacity_valid:=false; END IF;
    END IF;
  END LOOP;
  FOREACH prefix IN ARRAY ARRAY['weekday','weekend'] LOOP
    minimum:=NULL; maximum:=NULL;
    raw:=btrim(cfg->>(prefix||'MinPartySize'));
    IF raw IS NOT NULL AND length(raw)<=64 AND raw~'^[0-9]+([.][0-9]+)?$' THEN minimum:=raw::numeric; END IF;
    raw:=btrim(cfg->>(prefix||'MaxPartySize'));
    IF raw IS NOT NULL AND length(raw)<=64 AND raw~'^[0-9]+([.][0-9]+)?$' THEN maximum:=raw::numeric; END IF;
    IF minimum IS NULL OR maximum IS NULL OR minimum<1 OR maximum<minimum OR minimum>9007199254740991 OR maximum>9007199254740991
      OR minimum<>trunc(minimum) OR maximum<>trunc(maximum) THEN party_valid:=false; END IF;
  END LOOP;
  FOREACH setting_key IN ARRAY ARRAY['hourlyRate','downPaymentPercent'] LOOP
    raw:=btrim(cfg->>setting_key);
    BEGIN
      IF raw IS NULL OR raw='' OR length(raw)>64 THEN pricing_valid:=false;
      ELSE
        value:=raw::numeric;
        IF value<0 OR (setting_key='hourlyRate' AND (value>100000 OR value*100<>trunc(value*100)))
          OR (setting_key='downPaymentPercent' AND value>100) THEN pricing_valid:=false; END IF;
      END IF;
    EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN pricing_valid:=false;
    END;
  END LOOP;
  FOREACH setting_key IN ARRAY ARRAY['weekdayStartTime','weekdayEndTime','weekendStartTime','weekendEndTime'] LOOP
    IF cfg->>setting_key IS NULL OR cfg->>setting_key!~'^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN hours_valid:=false; END IF;
  END LOOP;
  IF NOT capacity_valid THEN configuration_issues:=configuration_issues||jsonb_build_array('CONFIG_CAPACITY_LIMITS_REQUIRED'); END IF;
  IF NOT party_valid THEN configuration_issues:=configuration_issues||jsonb_build_array('CONFIG_PARTY_BOUNDS_REQUIRED'); END IF;
  IF NOT pricing_valid THEN configuration_issues:=configuration_issues||jsonb_build_array('CONFIG_PRICING_REQUIRED'); END IF;
  IF NOT hours_valid THEN configuration_issues:=configuration_issues||jsonb_build_array('CONFIG_OPERATING_HOURS_REQUIRED'); END IF;
  IF NOT EXISTS (SELECT 1 FROM public.system_settings WHERE key_name='termsAndConditions' AND length(trim(setting_value)) > 0) THEN
    configuration_issues := configuration_issues || '"CONFIG_TERMS_REQUIRED"'::jsonb;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.system_settings WHERE key_name='bookingCapacityMode' AND setting_value='tables') THEN
    configuration_issues := configuration_issues || '"CONFIG_CAPACITY_REVIEW_REQUIRED"'::jsonb;
  END IF;
  RETURN jsonb_build_object('queueSummary',jsonb_build_object('waitingCount',(SELECT count(*) FROM public.queue WHERE status='waiting')),'announcements',announcement_rows,'cms',cms_rows,'bookingReady',jsonb_array_length(configuration_issues)=0,'configurationIssues',configuration_issues,'version',1,'tables',table_rows,'busy',busy_rows,'settings',settings_rows,'closedDates',closure_rows,'promos',promo_rows,'events',event_rows);
END $$;
REVOKE ALL ON FUNCTION oneshot_private.availability(date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION oneshot_private.availability(date,date) TO anon,authenticated;
CREATE OR REPLACE FUNCTION public.oneshot_booking_availability(p_from date,p_to date)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$ SELECT oneshot_private.availability(p_from,p_to) $$;
REVOKE ALL ON FUNCTION public.oneshot_booking_availability(date,date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.oneshot_booking_availability(date,date) TO anon,authenticated;
COMMIT;
