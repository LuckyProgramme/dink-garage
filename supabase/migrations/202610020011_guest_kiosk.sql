create table public.kiosk_devices (
 id uuid primary key default gen_random_uuid(), token_hash text unique not null,
 active boolean not null default true, created_at timestamptz not null default now(),
 created_by uuid not null references public.profiles(id), current_session_id uuid
);
alter table public.kiosk_devices enable row level security;
revoke all on public.kiosk_devices from anon,authenticated;
grant all on public.kiosk_devices to service_role;
alter table public.recording_sessions alter column player_id drop not null;
alter table public.recording_sessions add column kiosk_id uuid references public.kiosk_devices(id);
alter table public.recording_sessions add constraint recording_owner check ((player_id is not null) <> (kiosk_id is not null));
alter table public.kiosk_devices add foreign key(current_session_id) references public.recording_sessions(id);
create index kiosk_sessions on public.recording_sessions(kiosk_id,created_at desc);
create or replace function public.start_guest_capture(p_kiosk uuid,p_email text,p_court uuid,p_key uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_camera public.cameras; v_settings public.venue_settings;
begin
  if length(p_email)>254 or p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then raise exception 'Enter a valid email'; end if;
  perform 1 from public.kiosk_devices where id=p_kiosk and active for update;
  if not found then raise exception 'Tablet is not enabled'; end if;
  select id into v_id from public.recording_sessions where idempotency_key=p_key and kiosk_id=p_kiosk;
  if found then return v_id; end if;
  if exists(select 1 from public.recording_sessions where kiosk_id=p_kiosk and status in ('requested','starting','recording','finalizing')) then raise exception 'You already have an active recording'; end if;
  if (select count(*) from public.recording_sessions where kiosk_id=p_kiosk and created_at>now()-interval '1 minute')>=5 then raise exception 'Please wait before starting another recording'; end if;
  perform 1 from public.courts where id=p_court and active for update;
  if not found then raise exception 'Court is unavailable'; end if;
  if exists(select 1 from public.recording_sessions where court_id=p_court and status in ('requested','starting','recording','finalizing')) then raise exception 'This court is already recording'; end if;
  select * into v_camera from public.cameras where court_id=p_court and is_primary and enabled for update;
  if not found then raise exception 'Court has no primary camera'; end if;
  perform 1 from public.recorders where id=v_camera.recorder_id for update;
  if exists(select 1 from public.recorder_commands where recorder_id=v_camera.recorder_id and status='running' and lease_until>now()) then raise exception 'Camera checks are running. Please retry shortly'; end if;
  if v_camera.health<>'online' or v_camera.last_health_check_at is null then raise exception 'Camera needs a connection test in the admin dashboard'; end if;
  if not exists(select 1 from public.recorders where id=v_camera.recorder_id and paired_at is not null and last_seen_at>now()-interval '45 seconds' and ffmpeg_available and agent_version in ('0.3.0','0.4.0') and (v_camera.audio_source='' or agent_version='0.4.0')) then raise exception 'Recording service is offline or needs updating'; end if;
  select * into v_settings from public.venue_settings where id=true;
  insert into public.recording_sessions(kiosk_id,court_id,idempotency_key,configuration_snapshot,recipient_email,duration_seconds)
  values(p_kiosk,p_court,p_key,jsonb_build_object('sharing_mode','link','camera_id',v_camera.id,'audio_enabled',v_camera.audio_source<>'','max_duration_seconds',v_settings.max_duration_seconds,'retention_seconds',v_settings.retention_seconds,'venue_time_zone',coalesce(v_settings.venue_time_zone,'UTC')),p_email,v_settings.max_duration_seconds) returning id into v_id;
  insert into public.capture_jobs(session_id,recorder_id,camera_id,device_reference,max_seconds,audio_source) values(v_id,v_camera.recorder_id,v_camera.id,v_camera.device_reference,v_settings.max_duration_seconds,v_camera.audio_source);
  insert into public.audit_events(session_id,actor_id,action) values(v_id,null,'capture.requested');
  update public.kiosk_devices set current_session_id=v_id where id=p_kiosk;
  return v_id;
end; $$;
create or replace function public.kiosk_court_status() returns table(id uuid,name text,location text,camera_status text,audio_enabled boolean)
language sql stable security definer set search_path='' as $$
  select c.id,c.name,c.location,case
    when exists(select 1 from public.recording_sessions s where s.court_id=c.id and s.status in ('requested','starting','recording','finalizing')) then 'busy'
    when exists(select 1 from public.cameras cam join public.recorders r on r.id=cam.recorder_id where cam.court_id=c.id and cam.enabled and cam.is_primary and cam.health='online' and cam.last_health_check_at is not null and r.last_seen_at>now()-interval '45 seconds' and r.paired_at is not null and r.agent_version in ('0.3.0','0.4.0') and (cam.audio_source='' or r.agent_version='0.4.0')) then 'online' else 'offline' end, exists(select 1 from public.cameras a where a.court_id=c.id and a.enabled and a.is_primary and a.audio_source<>'')
  from public.courts c where c.active order by c.created_at;
$$;
revoke all on function public.kiosk_court_status() from public,anon,authenticated;
grant execute on function public.kiosk_court_status() to service_role;

revoke all on function public.start_guest_capture(uuid,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.start_guest_capture(uuid,text,uuid,uuid) to service_role;
create function public.kiosk_session_action(p_kiosk uuid,p_session uuid,p_reset boolean) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 perform 1 from public.kiosk_devices where id=p_kiosk and active and current_session_id=p_session for update;
 if not found then return false; end if;
 perform 1 from public.recording_sessions where id=p_session and kiosk_id=p_kiosk for update;
 if not found then return false; end if;
 if p_reset then
  if exists(select 1 from public.recording_sessions where id=p_session and status in ('requested','starting','recording','finalizing')) then return false; end if;
  update public.kiosk_devices set current_session_id=null where id=p_kiosk;
 else
  update public.recording_sessions set stop_requested_at=coalesce(stop_requested_at,now()) where id=p_session and status in ('requested','starting','recording','finalizing');
 end if;
 return true;
end; $$;
revoke all on function public.kiosk_session_action(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.kiosk_session_action(uuid,uuid,boolean) to service_role;
