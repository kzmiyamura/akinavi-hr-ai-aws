-- verify-agent-license を毎日 JST 2:00（UTC 17:00）に実行
SELECT cron.schedule(
  'verify-agent-license-daily',
  '0 17 * * *',
  $$
  SELECT net.http_post(
    url := 'https://argizomylbolpqxgmvim.supabase.co/functions/v1/verify-agent-license',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFyZ2l6b215bGJvbHBxeGdtdmltIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NzUwMjA1NiwiZXhwIjoyMDkzMDc4MDU2fQ.I3S9uEvTcgzthSYPLrHVpW6WPFe_cbCjjihCtgkynzY'
    ),
    body := '{"batch_size":20}'::jsonb
  ) AS request_id;
  $$
);
