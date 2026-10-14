-- Synthetic accounts and shopping records only; the entire transaction rolls back.
begin;
create temporary table lifeos_shopping_smoke(result text);
do $$
declare a uuid:=gen_random_uuid();b uuid:=gen_random_uuid();w uuid;l uuid:=gen_random_uuid();i uuid:=gen_random_uuid();request uuid:=gen_random_uuid();r public.shopping_lists;c public.shopping_items;denied boolean;begin
 insert into auth.users(id,raw_user_meta_data)values(a,'{"display_name":"Disposable shopping creator"}'),(b,'{"display_name":"Disposable shopping editor"}');
 perform set_config('request.jwt.claim.sub',a::text,true);set local role authenticated;
 w:=public.create_workspace('Disposable shopping review','family');perform public.set_workspace_member(w,b,'editor');
 perform public.save_shopping_list(request,l,w,null,'Synthetic groceries','grocery','Literal <script>text</script>','private');
 perform public.save_shopping_list(request,l,w,null,'Synthetic groceries','grocery','Literal <script>text</script>','private');
 perform public.save_shopping_item(gen_random_uuid(),i,l,null,1,'Milk','Dairy',1.5,'litres','',false,false);
 perform set_config('request.jwt.claim.sub',b::text,true);
 if exists(select 1 from public.shopping_lists where id=l) or exists(select 1 from public.shopping_items where id=i) then raise exception 'Private list leaked';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);perform public.save_shopping_list(gen_random_uuid(),l,w,2,'Synthetic groceries','grocery','Literal <script>text</script>','workspace');
 perform set_config('request.jwt.claim.sub',b::text,true);request:=gen_random_uuid();
 perform public.save_shopping_item(request,i,l,1,3,'Milk','Dairy',1.5,'litres','',true,false);
 perform public.save_shopping_item(request,i,l,1,3,'Milk','Dairy',1.5,'litres','',true,false);
 select * into c from public.shopping_items where id=i;select * into r from public.shopping_lists where id=l;
 if c.owner_id<>a or c.checked_by<>b or c.checked_at is null or not c.checked or c.revision<>2 or r.revision<>4 then raise exception 'Collaboration/check audit/replay failed';end if;
 denied:=false;begin perform public.set_shopping_archived(gen_random_uuid(),l,4,true);exception when others then denied:=true;end;if not denied then raise exception 'Editor archived another creator list';end if;
 denied:=false;begin perform public.save_shopping_item(gen_random_uuid(),i,l,1,3,'Milk','Dairy',1.5,'litres','',false,false);exception when others then denied:=true;end;if not denied then raise exception 'Stale change accepted';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);perform public.set_shopping_archived(gen_random_uuid(),l,4,true);
 perform set_config('request.jwt.claim.sub',b::text,true);denied:=false;begin perform public.save_shopping_item(gen_random_uuid(),i,l,2,5,'Milk','Dairy',1.5,'litres','',false,false);exception when others then denied:=true;end;if not denied then raise exception 'Archived list accepted item change';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);perform public.set_shopping_archived(gen_random_uuid(),l,5,false);perform public.save_shopping_list(gen_random_uuid(),l,w,6,'Synthetic groceries','grocery','','private');
 perform set_config('request.jwt.claim.sub',b::text,true);if exists(select 1 from public.shopping_items where id=i) then raise exception 'Child sharing did not follow parent';end if;
 perform set_config('request.jwt.claim.sub',a::text,true);perform public.save_shopping_list(gen_random_uuid(),l,w,7,'Synthetic groceries','grocery','','workspace');perform public.set_workspace_member(w,b,'viewer');
 perform set_config('request.jwt.claim.sub',b::text,true);denied:=false;begin perform public.save_shopping_item(request,i,l,1,3,'Milk','Dairy',1.5,'litres','',true,false);exception when others then denied:=true;end;if not denied then raise exception 'Viewer replay accepted';end if;
 denied:=false;begin update public.shopping_items set checked=false where id=i;exception when others then denied:=true;end;if not denied then raise exception 'Direct item mutation accepted';end if;
 reset role;insert into lifeos_shopping_smoke values('Private sharing and inherited child access, shared editor collaboration, check audit, exact retries, revision conflicts, parent archive/restore, creator metadata control and viewer denial passed. All synthetic records rolled back.');
end $$;
select * from lifeos_shopping_smoke;
rollback;
