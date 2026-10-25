#!/usr/bin/env python3
"""Run the bounded public availability contract on an isolated PostgreSQL server."""
from pathlib import Path
import os, subprocess, tempfile, time, json
pg=Path(os.environ.get('ONESHOT_TEST_PG_BIN','/opt/homebrew/opt/postgresql@17/bin'))
with tempfile.TemporaryDirectory(prefix='oneshot-availability-') as directory:
    base=Path(directory)
    subprocess.run([str(pg/'initdb'),'-D',str(base/'db'),'-A','trust','-U','postgres','--no-locale'],check=True,stdout=subprocess.DEVNULL)
    with (base/'postgres.log').open('w') as log:
        process=subprocess.Popen([str(pg/'postgres'),'-D',str(base/'db'),'-k',str(base),'-p','54393','-h',''],stdout=log,stderr=log)
        try:
            def sql(query,ok=True):
                r=subprocess.run([str(pg/'psql'),'-X','-q','-v','ON_ERROR_STOP=1','-At','-h',str(base),'-p','54393','-U','postgres'],input=query,text=True,capture_output=True)
                assert (r.returncode==0)==ok,r.stderr or r.stdout
                return r.stdout.strip()
            for _ in range(100):
                if subprocess.run([str(pg/'pg_isready'),'-h',str(base),'-p','54393','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
                if process.poll() is not None:raise RuntimeError((base/'postgres.log').read_text())
                time.sleep(.05)
            else:raise RuntimeError('Postgres startup failed')
            sql('''create role anon; create role authenticated;
create table tables(id text primary key,name text,status text,isactive integer,"isActive" integer,sessiondata text,"sessionData" text);
create table reservations(id text,"customerName" text,"contactNumber" text,email text,date date,"timeSlot" text,"durationHours" integer,"tableId" text,status text,"receiptImg" text);
create table system_settings(key_name text primary key,setting_value text);
create table closed_dates(id text,closed_date date,reason text,is_full_day boolean,open_time text,close_time text,type text,day_of_week integer,status text,cancelled_at timestamptz);
create table promo_codes(id text,code text,discount_percent real,description text,is_active boolean,is_limited_uses boolean,max_usage integer,usage_count integer,start_date timestamptz,expires_at timestamptz);
create table queue(status text,customername text);
insert into queue values ('waiting','PRIVATE-QUEUE'),('seated','PRIVATE-QUEUE');
create table cms(keyname text,settingvalue text);
create table announcements(id text,title text,content text,type text,isactive integer,createdat timestamptz,expiresat timestamptz);
insert into cms values ('heroImages','["public.jpg"]'),('secretKey','PRIVATE-KEY');
insert into announcements values ('PUBLIC','Public QA','Public text','info',1,now(),null),('PRIVATE','PRIVATE-NAME','Private text','info',0,now(),null);
create table events(id text,title text,date date,type text,description text,allowreservations integer,caterwalkins integer,walkintablecount integer,iscancelled integer,status text,cancelled_at timestamptz);
insert into tables values('QA','QA Table','available',1,1,null,null);
insert into reservations values('PRIVATE-ID','PRIVATE-NAME','PRIVATE-PHONE','PRIVATE-EMAIL',(now() at time zone 'Asia/Manila')::date-1,'23:00',3,'QA','confirmed','PRIVATE-RECEIPT');
insert into system_settings values('hourlyRate','150'),('serviceCredential','PRIVATE-KEY');
insert into promo_codes values('P','SAFE',10,'Public promo',true,true,1,1,null,null);
''')
            script=Path(__file__).with_name('booking-availability.draft.sql').read_text()
            sql(script,False)
            sql("set oneshot.secure_gateway_cutover='reviewed';\n"+script)
            call="select public.oneshot_booking_availability((now() at time zone 'Asia/Manila')::date,(now() at time zone 'Asia/Manila')::date+7);"
            result=sql('set role anon;'+call)
            assert 'PRIVATE-' not in result
            data=json.loads(result)
            assert data['queueSummary']=={'waitingCount':1}
            assert list(data['cms'])==['heroImages'] and len(data['announcements'])==1 and data['announcements'][0]['id']=='PUBLIC'
            assert data['busy'][0]['timeSlot']=='23:00' and len(data['busy'])==1
            assert data['tables'][0]['isActive'] is True
            assert data['bookingReady'] is False and set(data['configurationIssues'])=={'CONFIG_TERMS_REQUIRED','CONFIG_CAPACITY_REVIEW_REQUIRED','CONFIG_CAPACITY_LIMITS_REQUIRED','CONFIG_PARTY_BOUNDS_REQUIRED','CONFIG_PRICING_REQUIRED','CONFIG_OPERATING_HOURS_REQUIRED'}
            assert data['settings']==[{'key_name':'hourlyRate','setting_value':'150'}]
            assert data['promos'][0]['exhausted'] is True and 'usage_count' not in data['promos'][0]
            settings={'termsAndConditions':'QA terms','bookingCapacityMode':'tables','downPaymentPercent':'20','weekdayStartTime':'12:00','weekdayEndTime':'01:00','weekendStartTime':'12:00','weekendEndTime':'01:00','weekdayOnlineCapacityLimit':'101.0','weekendOnlineCapacityLimit':'500','weekdayMinPartySize':'1.0','weekdayMaxPartySize':'10','weekendMinPartySize':'2','weekendMaxPartySize':'20'}
            for key,value in settings.items(): sql("insert into system_settings values ('%s','%s')"%(key,value))
            ready=json.loads(sql('set role anon;'+call));assert ready['bookingReady'] is True and ready['configurationIssues']==[]
            public_settings={row['key_name']:row['setting_value'] for row in ready['settings']}
            assert public_settings['bookingCapacityMode']=='tables' and public_settings['weekdayOnlineCapacityLimit']=='101.0'
            settings['hourlyRate']='150'
            for key in ['weekdayOnlineCapacityLimit','weekendOnlineCapacityLimit','weekdayMinPartySize','weekdayMaxPartySize','weekendMinPartySize','weekendMaxPartySize']:
                sql("delete from system_settings where key_name='%s'"%key)
                missing=json.loads(sql('set role anon;'+call));assert missing['bookingReady'] is False
                assert ('CONFIG_CAPACITY_LIMITS_REQUIRED' if 'CapacityLimit' in key else 'CONFIG_PARTY_BOUNDS_REQUIRED') in missing['configurationIssues']
                sql("insert into system_settings values ('%s','%s')"%(key,settings[key]))
            cases=[('weekdayOnlineCapacityLimit','1.5','CONFIG_CAPACITY_LIMITS_REQUIRED'),('weekendOnlineCapacityLimit','-1','CONFIG_CAPACITY_LIMITS_REQUIRED'),('weekdayOnlineCapacityLimit','9007199254740992','CONFIG_CAPACITY_LIMITS_REQUIRED'),('weekendOnlineCapacityLimit','NaN','CONFIG_CAPACITY_LIMITS_REQUIRED'),('weekdayMinPartySize','0','CONFIG_PARTY_BOUNDS_REQUIRED'),('weekdayMaxPartySize','0','CONFIG_PARTY_BOUNDS_REQUIRED'),('weekendMinPartySize','21','CONFIG_PARTY_BOUNDS_REQUIRED'),('weekendMaxPartySize','2.5','CONFIG_PARTY_BOUNDS_REQUIRED'),('weekendMaxPartySize','9007199254740992','CONFIG_PARTY_BOUNDS_REQUIRED'),('hourlyRate','0.001','CONFIG_PRICING_REQUIRED'),('hourlyRate','100001','CONFIG_PRICING_REQUIRED'),('hourlyRate','NaN','CONFIG_PRICING_REQUIRED'),('downPaymentPercent','101','CONFIG_PRICING_REQUIRED'),('weekdayStartTime','25:00','CONFIG_OPERATING_HOURS_REQUIRED')]
            for key,value,issue in cases:
                sql("update system_settings set setting_value='%s' where key_name='%s'"%(value,key))
                invalid=json.loads(sql('set role anon;'+call));assert invalid['bookingReady'] is False and issue in invalid['configurationIssues'],(key,value,invalid['configurationIssues'])
                sql("update system_settings set setting_value='%s' where key_name='%s'"%(settings[key],key))
            sql("update system_settings set setting_value='0' where key_name='weekdayOnlineCapacityLimit'")
            assert json.loads(sql('set role anon;'+call))['bookingReady'] is True
            sql('set role anon;select * from reservations;',False)
            sql('set role anon;select * from tables;',False)
            sql("update tables set status='occupied',sessiondata='bad-json';")
            assert json.loads(sql('set role authenticated;'+call))['tables'][0]['isActive'] is False
            sql("update tables set sessiondata='{}',\"sessionData\"='{}',status='available';")
            empty=json.loads(sql('set role anon;'+call))['tables'][0];assert empty['isActive'] is True and empty['session'] is None
            sql("update tables set status='occupied';")
            assert json.loads(sql('set role anon;'+call))['tables'][0]['isActive'] is False
            sql("update tables set sessiondata='null',\"sessionData\"='null',status='available';")
            assert json.loads(sql('set role anon;'+call))['tables'][0]['isActive'] is True
            sql("update tables set sessiondata=null,\"sessionData\"=null,status='available',isactive=0;")
            assert json.loads(sql('set role anon;'+call))['tables'][0]['isActive'] is False
            sql("update reservations set status=null;")
            assert len(json.loads(sql('set role anon;'+call))['busy']) == 1
            sql("update reservations set \"timeSlot\"='27:00';")
            sql('set role anon;'+call,False)
            sql("set role anon;select public.oneshot_booking_availability(current_date,current_date+40);",False)
            sql("set role anon;select public.oneshot_booking_availability(null,null);",False)
            assert sql("select prosecdef from pg_proc where proname='oneshot_booking_availability';")=='f'
            assert sql("select count(*) from pg_proc where proname='availability' and pronamespace='oneshot_private'::regnamespace and proconfig @> ARRAY['search_path=\"\"'];")=='1'
            print('PASS: gated availability, missing/malformed essential pricing, hours, table capacity and party bounds fail readiness; decimal integer counts above 100 and zero counts valid; sanitized mode tables; anon/authenticated sanitized intervals including previous overnight day, no PII/session JSON/private settings, no direct table grants, exhausted promo without counters, malformed/occupied/inactive table fail-closed, malformed bookings/range rejected, invoker wrapper and fixed search path.')
            print('LIMIT: local schema fixture and simulated roles, not deployed RPC/PostgREST or real JWT verification.')
        finally:
            process.terminate();process.wait(timeout=10)
