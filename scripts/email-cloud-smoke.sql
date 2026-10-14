-- No provider requests. Every synthetic identity, preference, job and payload rolls back.
begin;
create temporary table lifeos_email_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;t uuid;job jsonb;again jsonb;total integer:=0;before_count integer;rev integer;denied boolean;begin
 insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)values(a,'lifeos-smoke-'||a||'@example.invalid',now(),'{"display_name":"Disposable email owner"}'),(b,'lifeos-smoke-'||b||'@example.invalid',now(),'{"display_name":"Disposable email member"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;
 w:=public.create_workspace('Disposable email workspace','family');perform public.set_workspace_member(w,b,'editor');
 insert into public.tasks(workspace_id,title,due_date)values(w,'Other owner private sentinel',(now()at time zone'UTC')::date);
 perform set_config('request.jwt.claim.sub',b::text,true);
 insert into public.tasks(workspace_id,title,due_date)values(w,'Synthetic own task',(now()at time zone'UTC')::date)returning id into t;
 perform public.save_reminder_preferences(true,false,false,30,3,30,0,'UTC');
 denied:=false;begin perform public.queue_email_deliveries();exception when others then denied:=true;end;if not denied then raise exception 'Browser could queue email';end if;
 reset role;set local role service_role;perform public.set_email_delivery_ready(true);
 reset role;set local role authenticated;
 rev:=(public.save_email_preferences(0,true,true,true,'weekly',0,extract(dow from now()at time zone'UTC')::integer,'UTC')).revision;
 if rev<>1 then raise exception 'Email preference initialization failed';end if;
 reset role;set local role service_role;perform public.queue_email_deliveries();perform public.queue_email_deliveries();
 reset role;select count(*)into before_count from public.email_deliveries where workspace_id=w and owner_id=b;
 if before_count<>4 then raise exception 'Expected exactly four synthetic jobs after duplicate queue calls';end if;
 set local role service_role;
 job:=public.claim_email_delivery('synthetic@example.invalid');
 if job is null then raise exception 'No synthetic email was claimable';end if;
 reset role;if not exists(select 1 from public.email_deliveries where id=(job->>'id')::uuid and owner_id=b and workspace_id=w) then raise exception 'Existing production queue prevents isolated smoke check';end if;set local role service_role;
 perform public.finish_email_delivery((job->>'id')::uuid,(job->>'lease')::uuid,'retry',null,'network_outcome_unknown');
 loop
  again:=public.claim_email_delivery('changed-sender@example.invalid',now()+interval '2 minutes');exit when again is null;
  reset role;if not exists(select 1 from public.email_deliveries where id=(again->>'id')::uuid and owner_id=b and workspace_id=w) then raise exception 'Existing production queue prevents isolated smoke check';end if;set local role service_role;
  if again->'payload'->>'text' like '%Other owner private sentinel%' then raise exception 'Other owner data reached email';end if;
  if again->>'id'=job->>'id' and again->'payload' is distinct from job->'payload' then raise exception 'Retry payload changed';end if;
  perform public.finish_email_delivery((again->>'id')::uuid,(again->>'lease')::uuid,'accepted','synthetic-provider-id');
  total:=total+1;if total>10 then raise exception 'Unbounded claim loop';end if;
 end loop;
 if total<>4 then raise exception 'Synthetic claim/retry coverage failed';end if;
 reset role;set local role authenticated;perform set_config('request.jwt.claim.sub',a::text,true);
 if exists(select 1 from public.email_preferences where owner_id=b) or exists(select 1 from public.email_deliveries where workspace_id=w) then raise exception 'Workspace owner read private email history/preferences';end if;
 perform public.remove_workspace_member(w,b);perform set_config('request.jwt.claim.sub',b::text,true);
 if exists(select 1 from public.email_deliveries where workspace_id=w) then raise exception 'Revoked member retained email history';end if;
 reset role;insert into lifeos_email_smoke values('Verified-recipient opt-ins, service-only queue/claim, per-workspace owner privacy, period deduplication, retry payload freezing and membership revocation passed. No email was sent; all synthetic data rolled back.');
end $$;
select * from lifeos_email_smoke;
rollback;
