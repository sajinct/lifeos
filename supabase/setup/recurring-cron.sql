-- Run once per cloud project after the finance planning migration.
-- Re-running updates the named job instead of creating a duplicate.
create extension if not exists pg_cron;
select cron.schedule('lifeos-recurring-finance','0 * * * *',
  'select public.post_due_recurring_transactions();');
select jobname,schedule,command,active from cron.job where jobname = 'lifeos-recurring-finance';
