-- Trusted provisioning is transactional. No automatic super-admin promotion.
create function public.register_tenant(p_owner uuid,p_name text,p_slug text)
returns uuid language plpgsql security definer set search_path='' as $$
declare tid uuid;
begin
  perform 1 from public.profiles where id=p_owner and active for update;
  if not found then raise exception 'Active account required'; end if;
  if (select count(*) from public.tenant_memberships m join public.tenants t on t.id=m.tenant_id
      where m.user_id=p_owner and m.role='admin' and t.created_at>now()-interval '1 day')>=3 then
    raise exception 'Tenant registration limit reached';
  end if;
  insert into public.tenants(name,slug,max_devices,max_courts,storage_limit_bytes)
    values(trim(p_name),lower(trim(p_slug)),32,64,107374182400) returning id into tid;
  insert into public.tenant_memberships(tenant_id,user_id,role) values(tid,p_owner,'admin');
  insert into public.venue_settings(tenant_id,id) values(tid,true);
  insert into public.locations(tenant_id,name) values(tid,'Main venue');
  insert into public.audit_events(tenant_id,actor_id,action) values(tid,p_owner,'tenant.created');
  return tid;
end; $$;
revoke all on function public.register_tenant(uuid,text,text) from public,anon,authenticated;
grant execute on function public.register_tenant(uuid,text,text) to service_role;

create function public.set_tenant_member(p_tenant uuid,p_actor uuid,p_email text,p_role text,p_active boolean)
returns void language plpgsql security definer set search_path='' as $$
declare member_id uuid;
begin
  -- Serialize membership changes so two admins cannot remove the last admin.
  perform 1 from public.tenants where id=p_tenant and active for update;
  if not found or not exists(select 1 from public.profiles p where p.id=p_actor and p.active and
    (p.is_super_admin or exists(select 1 from public.tenant_memberships m where m.tenant_id=p_tenant and m.user_id=p_actor and m.active and m.role='admin'))) then
    raise exception 'Tenant administrator required';
  end if;
  if p_role not in ('admin','player') then raise exception 'Invalid membership role'; end if;
  select id into member_id from auth.users where lower(email)=lower(trim(p_email));
  if member_id is null then raise exception 'Create or register this account before adding membership'; end if;
  if not p_active or p_role<>'admin' then
    if exists(select 1 from public.tenant_memberships where tenant_id=p_tenant and user_id=member_id and role='admin' and active)
      and not exists(select 1 from public.tenant_memberships m join public.profiles p on p.id=m.user_id where m.tenant_id=p_tenant and m.user_id<>member_id and m.role='admin' and m.active and p.active) then
      raise exception 'Keep at least one active tenant administrator';
    end if;
  end if;
  insert into public.tenant_memberships(tenant_id,user_id,role,active) values(p_tenant,member_id,p_role,p_active)
    on conflict(tenant_id,user_id) do update set role=excluded.role,active=excluded.active;
  insert into public.audit_events(tenant_id,actor_id,action,safe_detail)
    values(p_tenant,p_actor,'tenant.membership_changed',jsonb_build_object('user_id',member_id,'role',p_role,'active',p_active));
end; $$;
revoke all on function public.set_tenant_member(uuid,uuid,text,text,boolean) from public,anon,authenticated;
grant execute on function public.set_tenant_member(uuid,uuid,text,text,boolean) to service_role;

create function public.tenant_resource_limits() returns trigger
language plpgsql security definer set search_path='' as $$
declare t public.tenants; used_bytes bigint;
begin
  select * into t from public.tenants where id=new.tenant_id and active for update;
  if not found then raise exception 'Tenant unavailable'; end if;
  if tg_table_name='courts' and t.max_courts is not null and
    (select count(*) from public.courts where tenant_id=t.id)>=t.max_courts then raise exception 'Tenant court limit reached'; end if;
  if tg_table_name in ('browser_devices','recorders') and t.max_devices is not null and
    (select count(*) from public.browser_devices where tenant_id=t.id)+(select count(*) from public.recorders where tenant_id=t.id)>=t.max_devices then
    raise exception 'Tenant device limit reached';
  end if;
  if tg_table_name='recording_files' and t.storage_limit_bytes is not null then
    select coalesce(sum(bytes),0) into used_bytes from public.recording_files where tenant_id=t.id and deleted_at is null and id<>new.id;
    if new.deleted_at is null and used_bytes+coalesce(new.bytes,0)>t.storage_limit_bytes then raise exception 'Tenant storage limit reached; keep the local video'; end if;
  end if;
  return new;
end; $$;
create trigger tenant_court_limit before insert on public.courts for each row execute function public.tenant_resource_limits();
create trigger tenant_browser_device_limit before insert on public.browser_devices for each row execute function public.tenant_resource_limits();
create trigger tenant_recorder_limit before insert on public.recorders for each row execute function public.tenant_resource_limits();
create trigger tenant_video_limit before insert or update of bytes,deleted_at on public.recording_files for each row execute function public.tenant_resource_limits();

create function public.assign_court_location() returns trigger
language plpgsql security definer set search_path='' as $$
declare label text; resolved uuid;
begin
  -- Old clients still submit a location label. Resolve it within this tenant.
  if new.location_id is null or (tg_op='UPDATE' and new.location is distinct from old.location and new.location_id is not distinct from old.location_id) then
    label:=coalesce(nullif(trim(new.location),''),'Main venue');
    insert into public.locations(tenant_id,name) values(new.tenant_id,label) on conflict(tenant_id,name) do nothing;
    select id into resolved from public.locations where tenant_id=new.tenant_id and name=label and active;
    if resolved is null then raise exception 'Location unavailable'; end if;
    new.location_id:=resolved;
  else
    select name into label from public.locations where tenant_id=new.tenant_id and id=new.location_id and active;
    if not found then raise exception 'Location unavailable'; end if;
  end if;
  new.location:=label;
  return new;
end; $$;
create trigger assign_court_location before insert or update of location,location_id on public.courts
for each row execute function public.assign_court_location();
grant insert(location_id),update(location_id) on public.courts to authenticated;
revoke all on function public.tenant_resource_limits(),public.assign_court_location() from public,anon,authenticated;
