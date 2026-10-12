-- Preserve subscription classification on immutable ledger entries when expense links change.
alter table public.subscriptions add constraint subscriptions_workspace_id_id_key unique(workspace_id,id);
alter table public.transactions add column subscription_id uuid,
  add foreign key(workspace_id,subscription_id) references public.subscriptions(workspace_id,id),
  add constraint subscription_expense_source check(subscription_id is null or (kind='expense' and recurring_id is not null));
create index transaction_subscription on public.transactions(subscription_id) where subscription_id is not null;
create function private.attribute_subscription_expense() returns trigger
language plpgsql security definer set search_path='' as $$ begin
  if new.kind='expense' and new.recurring_id is not null then
    select s.id into new.subscription_id from public.subscriptions s where s.recurring_id=new.recurring_id
      and s.workspace_id=new.workspace_id and s.owner_id=new.owner_id;
  end if;
  return new;
end $$;
create trigger attribute_subscription_expense before insert on public.transactions
for each row execute function private.attribute_subscription_expense();
create function private.attribute_linked_subscription_history() returns trigger
language plpgsql security definer set search_path='' as $$ begin
  if new.recurring_id is not null then
    update public.transactions set subscription_id=new.id where recurring_id=new.recurring_id and subscription_id is null
      and workspace_id=new.workspace_id and owner_id=new.owner_id and kind='expense';
  end if;
  return null;
end $$;
create trigger attribute_linked_subscription_history after insert or update of recurring_id on public.subscriptions
for each row execute function private.attribute_linked_subscription_history();
update public.transactions t set subscription_id=s.id from public.subscriptions s where t.recurring_id=s.recurring_id
  and t.workspace_id=s.workspace_id and t.owner_id=s.owner_id and t.kind='expense' and t.subscription_id is null;
revoke all on function private.attribute_subscription_expense(),private.attribute_linked_subscription_history() from public,anon,authenticated;
