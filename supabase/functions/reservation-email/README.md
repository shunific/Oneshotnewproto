# Reservation email worker

Sends reservation emails from Supabase, so the POS app does not need to be open.

```
website / POS
      │  insert or update public.reservations
      ▼
reservation_mail.enqueue_reservation_emails()   (DB trigger)
      │  one queue row per customer-visible change
      ▼
pg_cron (every minute)
      │  POST /functions/v1/reservation-email
      ▼
reservation-email Edge Function
      │  leases up to 5 rows, sends over Gmail SMTP:465
      ▼
reservation_mail.queue                          (sent / retry / failed)
```

Queueing is deduplicated by `(reservation_id, event, event_key)`. Reschedules
use the new date/time/hours as their key, so a second reschedule still sends.
Transient SMTP failures retry with exponential backoff; rejected recipients
and invalid messages fail immediately.

## Deploy

1. Run [`../../reservation-email.sql`](../../reservation-email.sql) once in the
   Supabase SQL editor. Enable the `pg_cron` and `pg_net` extensions first.

2. Set the Edge Function secrets:

   ```sh
   npx supabase secrets set \
     --project-ref <project-ref> \
     RESERVATION_SMTP_USER="notifications@example.com" \
     RESERVATION_SMTP_APP_PASSWORD="<16-character Gmail app password>" \
     RESERVATION_MAIL_WORKER_SECRET="<random secret, at least 32 characters>"
   ```

   The app password must be 16 letters with no spaces. `SUPABASE_URL` and the
   service-role secret are provided by the Supabase platform.

3. Store the worker URL and the same worker secret in Vault:

   ```sql
   select vault.create_secret(
     'https://<project-ref>.supabase.co',
     'reservation_mail_project_url'
   );
   select vault.create_secret(
     '<same worker secret>',
     'reservation_mail_worker_secret'
   );
   ```

4. Schedule the worker:

   ```sql
   select cron.schedule(
     'reservation-email-worker',
     '* * * * *',
     $job$
     select net.http_post(
       url := project.decrypted_secret || '/functions/v1/reservation-email',
       headers := jsonb_build_object(
         'Content-Type', 'application/json',
         'X-Reservation-Mail-Secret', secret.decrypted_secret
       ),
       body := '{}'::jsonb,
       timeout_milliseconds := 55000
     )
     from vault.decrypted_secrets as project
     cross join vault.decrypted_secrets as secret
     where project.name = 'reservation_mail_project_url'
       and secret.name = 'reservation_mail_worker_secret';
     $job$
   );
   ```

5. Deploy the function:

   ```sh
   npx supabase functions deploy reservation-email \
     --project-ref <project-ref> --no-verify-jwt --use-api
   ```

6. Check SMTP without sending mail:

   ```sh
   curl -X POST \
     -H "X-Reservation-Mail-Secret: <worker secret>" \
     "https://<project-ref>.supabase.co/functions/v1/reservation-email?check=smtp"
   # {"smtp":"ready"}
   ```

7. Disable the POS sender to avoid duplicate emails:

   ```dotenv
   EMAIL_NOTIFICATIONS_ENABLED=false
   ```

   Restart the POS after changing its `.env`.

## Monitoring

```sql
-- recent sends and failures
select id, reservation_id, event, attempts, sent_at, failed_at, last_error
from reservation_mail.queue
order by id desc
limit 20;

-- cron invocations
select runid, status, return_message, start_time
from cron.job_run_details
order by runid desc
limit 10;
```

The worker's HTTP responses are also in `net._http_response`. A healthy idle
run returns `{"sent":0,"unsuccessful":0}`.
