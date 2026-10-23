alter table public.profiles add column active boolean not null default true;
alter table public.courts add column location text not null default '';
alter table public.courts add constraint court_name_length check (char_length(trim(name)) between 1 and 100);
create unique index unique_court_name on public.courts(lower(trim(name)));
alter table public.cameras add constraint camera_name_length check (char_length(trim(name)) between 1 and 100);
alter table public.cameras add constraint primary_requires_court check (not is_primary or court_id is not null);
alter table public.cameras add constraint camera_reference_format check (device_reference ~ '^[a-zA-Z0-9._:-]{1,120}$');
alter table public.recorders add constraint recorder_name_length check (char_length(trim(name)) between 1 and 100);

create or replace function public.is_admin() returns boolean language sql stable security definer
set search_path = '' as $$ select exists(select 1 from public.profiles where id = auth.uid() and role = 'admin' and active); $$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to authenticated;

create function public.create_player_profile() returns trigger language plpgsql security definer
set search_path = '' as $$
begin
  -- Never trust user-editable metadata for role assignment.
  insert into public.profiles(id, display_name, role) values (new.id, '', 'player') on conflict (id) do nothing;
  return new;
end; $$;
revoke all on function public.create_player_profile() from public;
create trigger provision_player_profile after insert on auth.users for each row execute function public.create_player_profile();
insert into public.profiles(id) select id from auth.users on conflict (id) do nothing;

create function public.audit_configuration() returns trigger language plpgsql security definer
set search_path = '' as $$
begin
  insert into public.audit_events(actor_id,action,safe_detail)
  values (auth.uid(), lower(tg_op) || '.' || tg_table_name,
    jsonb_build_object('entity_id', to_jsonb(new)->>'id', 'name', to_jsonb(new)->>'name'));
  return new;
end; $$;
revoke all on function public.audit_configuration() from public;
create trigger audit_courts after insert or update on public.courts for each row execute function public.audit_configuration();
create trigger audit_cameras after insert or update on public.cameras for each row execute function public.audit_configuration();
create trigger audit_recorders after insert or update on public.recorders for each row execute function public.audit_configuration();
create trigger audit_settings after update on public.venue_settings for each row execute function public.audit_configuration();

create function public.validate_venue_settings() returns trigger language plpgsql set search_path = '' as $$
begin
  if new.venue_time_zone is not null and not exists(select 1 from pg_catalog.pg_timezone_names where name = new.venue_time_zone) then
    raise exception 'Invalid venue time zone' using errcode = '23514';
  end if;
  new.updated_at = now();
  return new;
end; $$;
create trigger validate_settings before update on public.venue_settings for each row execute function public.validate_venue_settings();

-- Authenticated browser clients cannot fake hardware health or create recorder heartbeats.
revoke all on public.recorders, public.cameras, public.courts, public.venue_settings from anon, authenticated;
grant select on public.recorders, public.cameras, public.courts, public.venue_settings to authenticated;
grant insert (name), update (name) on public.recorders to authenticated;
grant insert (name,location,active), update (name,location,active) on public.courts to authenticated;
grant insert (name,recorder_id,court_id,source_type,device_reference,is_primary,enabled),
  update (name,recorder_id,court_id,source_type,device_reference,is_primary,enabled) on public.cameras to authenticated;
grant update (max_duration_seconds,retention_seconds,venue_time_zone,updated_at) on public.venue_settings to authenticated;

create function public.protect_recording_camera() returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and exists(
    select 1 from public.recording_sessions where court_id in (old.court_id,new.court_id)
      and status in ('requested','starting','recording','finalizing')
  ) then
    raise exception 'Camera configuration cannot change during capture' using errcode = '23514';
  end if;
  return new;
end; $$;
revoke all on function public.protect_recording_camera() from public;
create trigger protect_recording_camera before update on public.cameras for each row execute function public.protect_recording_camera();
