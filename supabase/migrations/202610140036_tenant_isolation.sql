-- Stage and verify before deployment. Existing objects and IDs are retained.
-- The historical venue becomes the default tenant; no videos or jobs are deleted.
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check(char_length(trim(name)) between 1 and 100),
  slug text not null unique check(slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
  active boolean not null default true,
  max_devices integer check(max_devices > 0),
  max_courts integer check(max_courts > 0),
  storage_limit_bytes bigint check(storage_limit_bytes > 0),
  created_at timestamptz not null default now()
);
insert into public.tenants(id,name,slug)
values('00000000-0000-4000-8000-000000000001','DinkVision','dinkvision');
alter table public.profiles add column is_super_admin boolean not null default false;
create table public.tenant_memberships (
  tenant_id uuid not null references public.tenants(id),
  user_id uuid not null references public.profiles(id),
  role text not null check(role in ('admin','player')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  primary key(tenant_id,user_id)
);
insert into public.tenant_memberships(tenant_id,user_id,role,active)
select '00000000-0000-4000-8000-000000000001',id,role,active from public.profiles;

create function public.is_super_admin() returns boolean
language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.profiles where id=auth.uid() and active and is_super_admin);
$$;
create function public.is_tenant_member(p_tenant uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select public.is_super_admin() or exists(
    select 1 from public.tenant_memberships m join public.profiles p on p.id=m.user_id
    join public.tenants t on t.id=m.tenant_id
    where m.tenant_id=p_tenant and m.user_id=auth.uid() and m.active and p.active and t.active);
$$;
create function public.is_tenant_admin(p_tenant uuid) returns boolean
language sql stable security definer set search_path='' as $$
  select public.is_super_admin() or exists(
    select 1 from public.tenant_memberships m join public.profiles p on p.id=m.user_id
    join public.tenants t on t.id=m.tenant_id
    where m.tenant_id=p_tenant and m.user_id=auth.uid() and m.role='admin' and m.active and p.active and t.active);
$$;
create function public.current_tenant_id() returns uuid
language plpgsql stable security definer set search_path='' as $$
declare tid uuid; request_role text;
begin
  tid:=coalesce(nullif(coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb
    ->>'x-dinkvision-tenant-id','')::uuid,'00000000-0000-4000-8000-000000000001'::uuid);
  if not exists(select 1 from public.tenants where id=tid and active) then return null; end if;
  request_role:=coalesce(nullif(current_setting('request.jwt.claim.role',true),''),
    coalesce(nullif(current_setting('request.jwt.claims',true),''),'{}')::jsonb->>'role',current_setting('role',true));
  if request_role='authenticated' and not public.is_tenant_member(tid) then return null; end if;
  return tid;
end; $$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path='' as $$
  select public.is_tenant_admin(public.current_tenant_id());
$$;

-- NOLOGIN and no BYPASSRLS: existing SECURITY DEFINER recording RPCs now obey
-- tenant RLS too. Merely adding policies while leaving postgres as their owner
-- would not isolate them. Clients cannot SET ROLE to this execution identity.
create role dinkvision_executor nologin nosuperuser nobypassrls;
grant dinkvision_executor to postgres;
grant usage, create on schema public to dinkvision_executor;
grant usage on schema public,auth to dinkvision_executor;
grant execute on function auth.uid() to dinkvision_executor;

do $$ declare tab text;
begin
  foreach tab in array array['venue_settings','courts','recorders','cameras','recording_sessions',
    'recording_files','delivery_attempts','audit_events','recorder_credentials','recorder_devices',
    'recorder_commands','capture_jobs','google_integration','google_oauth_states','drive_folders',
    'drive_upload_jobs','email_jobs','cleanup_jobs','kiosk_devices','browser_devices','browser_recordings']
  loop
    execute format('alter table public.%I add column tenant_id uuid not null default ''00000000-0000-4000-8000-000000000001'' references public.tenants(id)',tab);
    execute format('alter table public.%I alter column tenant_id set default public.current_tenant_id()',tab);
    execute format('create index %I on public.%I(tenant_id)',tab||'_tenant',tab);
    execute format('create policy tenant_boundary on public.%I as restrictive for all to authenticated using (tenant_id=public.current_tenant_id() and public.is_tenant_member(tenant_id)) with check (tenant_id=public.current_tenant_id() and public.is_tenant_member(tenant_id))',tab);
    execute format('create policy tenant_executor on public.%I for all to dinkvision_executor using (tenant_id=public.current_tenant_id()) with check (tenant_id=public.current_tenant_id())',tab);
    execute format('grant all on public.%I to dinkvision_executor,service_role',tab);
  end loop;
end $$;

-- Preserve id=true in API contracts, but allow one settings/connection row per tenant.
alter table public.venue_settings drop constraint venue_settings_pkey;
alter table public.venue_settings add primary key(tenant_id,id);
alter table public.venue_settings add column browser_worker_attempt_at timestamptz;
alter table public.google_integration drop constraint google_integration_pkey;
alter table public.google_integration add primary key(tenant_id,id);
create unique index google_root_one_tenant on public.google_integration(root_folder_id);
drop index public.unique_court_name;
create unique index unique_court_name on public.courts(tenant_id,lower(trim(name)));
alter table public.recording_sessions drop constraint recording_sessions_idempotency_key_key;
alter table public.recording_sessions add unique(tenant_id,idempotency_key);
grant insert(tenant_id) on public.courts,public.cameras,public.recorders to authenticated;

create table public.locations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null default public.current_tenant_id() references public.tenants(id),
  name text not null check(char_length(trim(name)) between 1 and 150),
  active boolean not null default true,
  unique(tenant_id,name), unique(tenant_id,id)
);
insert into public.locations(tenant_id,name)
select distinct tenant_id,coalesce(nullif(trim(location),''),'Main venue') from public.courts;
insert into public.locations(tenant_id,name)
values('00000000-0000-4000-8000-000000000001','Main venue') on conflict do nothing;
alter table public.courts add column location_id uuid;
update public.courts c set location_id=l.id from public.locations l
where l.tenant_id=c.tenant_id and l.name=coalesce(nullif(trim(c.location),''),'Main venue');
alter table public.courts add constraint courts_location_scope foreign key(tenant_id,location_id)
references public.locations(tenant_id,id);

create table public.tenant_google_settings (
  tenant_id uuid primary key references public.tenants(id),
  owner_email text not null check(char_length(owner_email) between 3 and 254),
  root_folder_id text not null unique check(root_folder_id ~ '^[A-Za-z0-9_-]{8,200}$')
);
insert into public.tenant_google_settings(tenant_id,owner_email,root_folder_id)
select tenant_id,owner_email,root_folder_id from public.google_integration;

-- Replace single-column relationships with scoped relationships, keeping their
-- names and delete behavior. This avoids ambiguous PostgREST embedded relations.
do $$ declare fk record; deletion text;
begin
  for fk in
    select c.conname,src.relname as source,dst.relname as target,a.attname as source_column,
      b.attname as target_column,c.confdeltype
    from pg_constraint c join pg_class src on src.oid=c.conrelid join pg_class dst on dst.oid=c.confrelid
    join pg_namespace ns on ns.oid=src.relnamespace
    join pg_attribute a on a.attrelid=src.oid and a.attnum=c.conkey[1]
    join pg_attribute b on b.attrelid=dst.oid and b.attnum=c.confkey[1]
    where ns.nspname='public' and c.contype='f' and cardinality(c.conkey)=1
    and src.relname=any(array['venue_settings','courts','recorders','cameras','recording_sessions','recording_files','delivery_attempts','audit_events','recorder_credentials','recorder_devices','recorder_commands','capture_jobs','google_integration','google_oauth_states','drive_folders','drive_upload_jobs','email_jobs','cleanup_jobs','kiosk_devices','browser_devices','browser_recordings'])
    and exists(select 1 from pg_attribute where attrelid=src.oid and attname='tenant_id')
    and exists(select 1 from pg_attribute where attrelid=dst.oid and attname='tenant_id')
    and dst.relname not in ('tenant_memberships','tenant_google_settings')
  loop
    execute format('create unique index if not exists %I on public.%I(tenant_id,%I)',fk.target||'_tenant_'||fk.target_column,fk.target,fk.target_column);
    deletion:=case fk.confdeltype when 'c' then 'on delete cascade'
      when 'n' then format('on delete set null (%I)',fk.source_column) else 'on delete no action' end;
    execute format('alter table public.%I drop constraint %I',fk.source,fk.conname);
    execute format('alter table public.%I add constraint %I foreign key(tenant_id,%I) references public.%I(tenant_id,%I) %s deferrable initially immediate',
      fk.source,fk.conname,fk.source_column,fk.target,fk.target_column,deletion);
  end loop;
end $$;

alter table public.tenants enable row level security;
alter table public.tenant_memberships enable row level security;
alter table public.locations enable row level security;
alter table public.tenant_google_settings enable row level security;
revoke all on public.tenants,public.tenant_memberships,public.locations,public.tenant_google_settings from public,anon,authenticated;
grant select on public.tenants,public.tenant_memberships,public.locations to authenticated;
grant all on public.tenants,public.tenant_memberships,public.locations,public.tenant_google_settings to service_role;
grant all on public.locations,public.tenant_google_settings to dinkvision_executor;
grant select on public.profiles,public.tenant_memberships to dinkvision_executor;
-- start_capture locks its player row; column UPDATE privilege is required for
-- SELECT FOR UPDATE. A false check still prevents this role changing profiles.
grant update(id) on public.profiles to dinkvision_executor;
grant usage,select on all sequences in schema public to dinkvision_executor;
create policy tenants_member_read on public.tenants for select to authenticated using(public.is_tenant_member(id));
create policy memberships_member_read on public.tenant_memberships for select to authenticated
using(user_id=auth.uid() or public.is_tenant_admin(tenant_id));
create policy locations_member_read on public.locations for select to authenticated
using(tenant_id=public.current_tenant_id() and public.is_tenant_member(tenant_id));
create policy locations_executor on public.locations to dinkvision_executor
using(tenant_id=public.current_tenant_id()) with check(tenant_id=public.current_tenant_id());
create policy google_settings_executor on public.tenant_google_settings to dinkvision_executor
using(tenant_id=public.current_tenant_id()) with check(tenant_id=public.current_tenant_id());
create policy memberships_executor on public.tenant_memberships for select to dinkvision_executor
using(tenant_id=public.current_tenant_id() and active);
create policy profiles_executor on public.profiles for select to dinkvision_executor
using(active and (is_super_admin or exists(select 1 from public.tenant_memberships where user_id=profiles.id and tenant_id=public.current_tenant_id() and active)));
create policy profiles_executor_lock on public.profiles for update to dinkvision_executor
using(active and (is_super_admin or exists(select 1 from public.tenant_memberships where user_id=profiles.id and tenant_id=public.current_tenant_id() and active))) with check(false);
drop policy profile_read on public.profiles;
create policy profile_read on public.profiles for select to authenticated
using(id=auth.uid() or public.is_super_admin() or exists(select 1 from public.tenant_memberships m
  where m.user_id=profiles.id and m.tenant_id=public.current_tenant_id() and public.is_tenant_admin(m.tenant_id)));

do $$ declare fn record;
begin
  for fn in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.prosecdef
    -- Explicit first-party allowlist; never change unrelated deployed functions.
    and p.proname=any(array['audit_configuration','browser_event','browser_start','browser_upload_turn','cancel_browser_upload',
      'claim_browser_email','claim_browser_email_for_file','claim_cleanup','claim_drive_upload','claim_recorder_command','claim_recording_email',
      'confirm_cloud_cleanup','enroll_browser','expire_browser_uploads','finish_browser_upload','finish_drive_upload','finish_recorder_command','guard_completed_browser_upload','sync_completed_browser_upload',
      'hold_short_browser_recording','hold_unsupported_browser_recording','issue_recorder_pair','kiosk_court_status','kiosk_session_action',
      'native_camera_test','player_court_status','preserve_court_history_before_delete','protect_browser_assignment','protect_browser_device_delete',
      'protect_recording_camera','queue_browser_upload','redeem_recorder_pair','remove_browser_device','report_browser_upload','report_capture',
      'reset_camera_health','retry_browser_upload','revoke_recorder','start_capture','start_guest_capture','stop_capture','sync_captures'])
  loop execute format('alter function %s owner to dinkvision_executor',fn.signature); end loop;
end $$;
-- The legacy global profile role must not grant admin control in another
-- tenant where the same person only has player membership.
do $$ declare definition text; updated text;
begin
  definition:=pg_get_functiondef('public.stop_capture(uuid,uuid)'::regprocedure);
  updated:=replace(definition,
    'exists(select 1 from public.profiles where id=p_player and role=''admin'' and active)',
    'exists(select 1 from public.tenant_memberships m join public.profiles p on p.id=m.user_id where m.user_id=p_player and m.tenant_id=public.current_tenant_id() and m.role=''admin'' and m.active and p.active)');
  if updated=definition then raise exception 'Tenant stop authorization was not installed'; end if;
  execute updated;
end $$;
grant execute on all functions in schema public to dinkvision_executor;
revoke all on function public.is_super_admin(),public.is_tenant_member(uuid),public.is_tenant_admin(uuid),public.current_tenant_id() from public;
grant execute on function public.is_super_admin(),public.is_tenant_member(uuid),public.is_tenant_admin(uuid),public.current_tenant_id()
to authenticated,service_role,dinkvision_executor;

-- Cross-tenant reassignment is a migration, never an ordinary UPDATE. Historical
-- session/device/file links must retain their original tenant permanently.
create function public.keep_tenant_identity() returns trigger language plpgsql set search_path='' as $$
begin
  if new.tenant_id is distinct from old.tenant_id then
    raise exception 'Tenant ownership cannot be reassigned' using errcode='23514';
  end if;
  return new;
end; $$;
do $$ declare tab record;
begin
  for tab in select table_name from information_schema.columns where table_schema='public' and column_name='tenant_id'
    and table_name=any(array['venue_settings','courts','recorders','cameras','recording_sessions','recording_files','delivery_attempts','audit_events','recorder_credentials','recorder_devices','recorder_commands','capture_jobs','google_integration','google_oauth_states','drive_folders','drive_upload_jobs','email_jobs','cleanup_jobs','kiosk_devices','browser_devices','browser_recordings','locations','tenant_memberships','tenant_google_settings'])
  loop execute format('create trigger keep_tenant_identity before update of tenant_id on public.%I for each row execute function public.keep_tenant_identity()',tab.table_name); end loop;
end $$;
