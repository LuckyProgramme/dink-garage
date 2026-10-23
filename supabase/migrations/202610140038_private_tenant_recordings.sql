-- New recordings are restricted to their recipients' Google accounts. Preserve
-- existing snapshots and already-issued links until an explicit owner migration.
do $$ declare fn record; definition text; updated text;
begin
  for fn in select p.oid::regprocedure as signature from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname in ('browser_start','start_guest_capture')
  loop
    definition:=pg_get_functiondef(fn.signature);
    updated:=replace(definition,'''sharing_mode'',''link''','''sharing_mode'',''private''');
    if updated<>definition then execute updated; end if;
  end loop;
end $$;

-- Usage is aggregated in Postgres, not truncated at PostgREST's page limit.
create function public.tenant_storage_usage() returns bigint
language sql stable security definer set search_path='' as $$
  select coalesce(sum(bytes),0)::bigint from public.recording_files
  where tenant_id=public.current_tenant_id() and deleted_at is null;
$$;
alter function public.tenant_storage_usage() owner to dinkvision_executor;
revoke all on function public.tenant_storage_usage() from public,anon,authenticated;
grant execute on function public.tenant_storage_usage() to service_role;
