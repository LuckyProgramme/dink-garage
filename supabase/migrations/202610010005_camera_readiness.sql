-- Keep successful camera checks valid while the recorder is connected.
-- Capture still opens the device and confirms frames before reporting recording.
create or replace function public.start_capture(p_player uuid,p_email text,p_court uuid,p_key uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_camera public.cameras; v_settings public.venue_settings;
begin
  perform 1 from public.profiles where id=p_player and active for update;
  if not found then raise exception 'Account is inactive'; end if;
  select id into v_id from public.recording_sessions where idempotency_key=p_key and player_id=p_player;
  if found then return v_id; end if;
  if exists(select 1 from public.recording_sessions where player_id=p_player and status in ('requested','starting','recording','finalizing')) then raise exception 'You already have an active recording'; end if;
  if (select count(*) from public.recording_sessions where player_id=p_player and created_at>now()-interval '1 minute')>=5 then raise exception 'Please wait before starting another recording'; end if;
  perform 1 from public.courts where id=p_court and active for update;
  if not found then raise exception 'Court is unavailable'; end if;
  if exists(select 1 from public.recording_sessions where court_id=p_court and status in ('requested','starting','recording','finalizing')) then raise exception 'This court is already recording'; end if;
  select * into v_camera from public.cameras where court_id=p_court and is_primary and enabled for update;
  if not found then raise exception 'Court has no primary camera'; end if;
  perform 1 from public.recorders where id=v_camera.recorder_id for update;
  if exists(select 1 from public.recorder_commands where recorder_id=v_camera.recorder_id and status='running' and lease_until>now()) then raise exception 'Camera checks are running. Please retry shortly'; end if;
  if v_camera.health<>'online' or v_camera.last_health_check_at is null then raise exception 'Camera needs a connection test in the admin dashboard'; end if;
  if not exists(select 1 from public.recorders where id=v_camera.recorder_id and paired_at is not null and last_seen_at>now()-interval '45 seconds' and ffmpeg_available and agent_version='0.3.0') then raise exception 'Recording service is offline or needs updating'; end if;
  select * into v_settings from public.venue_settings where id=true;
  insert into public.recording_sessions(player_id,court_id,idempotency_key,configuration_snapshot,recipient_email,duration_seconds)
  values(p_player,p_court,p_key,jsonb_build_object('camera_id',v_camera.id,'max_duration_seconds',v_settings.max_duration_seconds,'retention_seconds',v_settings.retention_seconds,'venue_time_zone',coalesce(v_settings.venue_time_zone,'UTC')),p_email,v_settings.max_duration_seconds) returning id into v_id;
  insert into public.capture_jobs(session_id,recorder_id,camera_id,device_reference,max_seconds) values(v_id,v_camera.recorder_id,v_camera.id,v_camera.device_reference,v_settings.max_duration_seconds);
  insert into public.audit_events(session_id,actor_id,action) values(v_id,p_player,'capture.requested');
  return v_id;
end; $$;

create or replace function public.player_court_status() returns table(id uuid,name text,location text,camera_status text)
language sql stable security definer set search_path='' as $$
  select c.id,c.name,c.location,case
    when exists(select 1 from public.recording_sessions s where s.court_id=c.id and s.status in ('requested','starting','recording','finalizing')) then 'busy'
    when exists(select 1 from public.cameras cam join public.recorders r on r.id=cam.recorder_id where cam.court_id=c.id and cam.enabled and cam.is_primary and cam.health='online' and cam.last_health_check_at is not null and r.last_seen_at>now()-interval '45 seconds' and r.paired_at is not null and r.agent_version='0.3.0') then 'online' else 'offline' end
  from public.courts c where c.active and exists(select 1 from public.profiles p where p.id=auth.uid() and p.active) order by c.created_at;
$$;
