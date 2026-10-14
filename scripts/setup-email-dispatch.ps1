param([string]$ProjectRef = 'eyrqbrxohwekzizuairz')
$ErrorActionPreference = 'Stop'
if ($ProjectRef -notmatch '^[a-z]{20}$') { throw 'Use the linked Supabase project reference.' }
$taskTemp = Join-Path ([System.IO.Path]::GetTempPath()) ('lifeos-email-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $taskTemp | Out-Null
$taskEnv = Join-Path $taskTemp 'dispatch.env'
$taskSql = Join-Path $taskTemp 'schedule.sql'
try {
  $taskKey = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32)).ToLowerInvariant()
  Set-Content -LiteralPath $taskEnv -Value ('LIFEOS_EMAIL_DISPATCH_KEY=' + $taskKey) -Encoding utf8NoBOM
  & npx --yes supabase secrets set --project-ref $ProjectRef --env-file $taskEnv *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to store the private dispatch credential.' }
  $taskStatement = @'
create extension if not exists pg_net;
do $$ declare secret_id uuid;begin
 if to_regnamespace('vault') is null or to_regnamespace('cron') is null then raise exception 'Enable Supabase Vault and Cron first';end if;
 select id into secret_id from vault.secrets where name='lifeos_email_dispatch_key';
 if secret_id is null then perform vault.create_secret('__KEY__','lifeos_email_dispatch_key','LifeOS scheduler-only email authorization');
 else perform vault.update_secret(secret_id,'__KEY__');end if;
 perform cron.schedule('lifeos-email','*/5 * * * *',$job$
 select net.http_post(url:='https://__PROJECT__.supabase.co/functions/v1/email-dispatch',headers:=jsonb_build_object('Content-Type','application/json','x-lifeos-dispatch-key',(select decrypted_secret from vault.decrypted_secrets where name='lifeos_email_dispatch_key')),body:='{}'::jsonb,timeout_milliseconds:=120000);
 $job$);
end $$;
select net.http_post(url:='https://__PROJECT__.supabase.co/functions/v1/email-dispatch',headers:=jsonb_build_object('Content-Type','application/json','x-lifeos-dispatch-key',(select decrypted_secret from vault.decrypted_secrets where name='lifeos_email_dispatch_key')),body:='{"mode":"probe"}'::jsonb,timeout_milliseconds:=10000) as probe_request;
'@
  $taskStatement = $taskStatement.Replace('__KEY__',$taskKey).Replace('__PROJECT__',$ProjectRef)
  Set-Content -LiteralPath $taskSql -Value $taskStatement -Encoding utf8NoBOM
  & npx --yes supabase db query --linked --file $taskSql *> $null
  if ($LASTEXITCODE -ne 0) { throw 'Unable to install the email schedule; no credentials were printed.' }
  Write-Output 'Private dispatch credential installed, five-minute email schedule activated, no-mail configuration probe requested.'
} finally {
  $taskKey = $null
  $taskStatement = $null
  foreach ($taskFile in @($taskEnv,$taskSql)) { if (Test-Path -LiteralPath $taskFile) { Remove-Item -LiteralPath $taskFile -Force } }
  if (Test-Path -LiteralPath $taskTemp) { Remove-Item -LiteralPath $taskTemp -Force }
}
