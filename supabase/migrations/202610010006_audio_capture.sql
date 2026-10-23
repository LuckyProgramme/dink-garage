alter table public.cameras add column audio_source text not null default '' check (audio_source='' or (source_type='network' and audio_source='stream') or (source_type='usb' and audio_source ~ '^mic-[a-f0-9]{24}$'));
alter table public.recorder_devices add column audio_sources jsonb not null default '[]';
alter table public.capture_jobs add column audio_source text not null default '';
drop trigger protect_recording_camera on public.cameras;
create trigger protect_recording_camera before update of recorder_id,court_id,device_reference,source_type,is_primary,enabled,audio_source on public.cameras for each row execute function public.protect_recording_camera();
create trigger audit_camera_audio after update of audio_source on public.cameras for each row execute function public.audit_configuration();
create or replace function public.reset_camera_health() returns trigger language plpgsql set search_path='' as $$
begin
  if new.recorder_id is distinct from old.recorder_id or new.device_reference is distinct from old.device_reference or new.source_type is distinct from old.source_type or new.audio_source is distinct from old.audio_source then
    new.health='unknown'; new.last_health_check_at=null;
  end if;
  return new;
end; $$;
create or replace function public.finish_recorder_command(p_recorder_id uuid,p_command_id uuid,p_lease_token uuid,p_success boolean,p_devices jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_job public.recorder_commands; v_device jsonb;
begin
  select * into v_job from public.recorder_commands where id=p_command_id and recorder_id=p_recorder_id and lease_token=p_lease_token and status='running' and lease_until>now() for update;
  if not found then return false; end if;
  if jsonb_typeof(p_devices)<>'array' or jsonb_array_length(p_devices)>64 then raise exception 'Invalid inventory'; end if;
  if p_success then
    if v_job.kind='test' and jsonb_array_length(p_devices)<>1 then raise exception 'Expected one test result'; end if;
    if v_job.kind='discover' then
      -- A new discovery invalidates old health. Only an explicit test makes a feed online.
      update public.recorder_devices set health='offline',diagnostic='device_missing' where recorder_id=p_recorder_id;
      update public.cameras set health='unknown',last_health_check_at=null where recorder_id=p_recorder_id;
    end if;
    for v_device in select * from jsonb_array_elements(p_devices) loop
      if v_job.kind='test' and v_device->>'device_reference'<>v_job.device_reference then raise exception 'Wrong device'; end if;
      insert into public.recorder_devices(recorder_id,device_reference,name,source_type,health,diagnostic,last_seen_at,last_test_at,audio_sources)
      values(p_recorder_id,v_device->>'device_reference',v_device->>'name',v_device->>'source_type',
        case when v_job.kind='discover' then 'unknown' else v_device->>'health' end,
        case when v_job.kind='discover' then 'not_tested' else v_device->>'diagnostic' end,now(),case when v_job.kind='test' then now() else null end,coalesce(v_device->'audio_sources','[]'::jsonb))
      on conflict(recorder_id,device_reference) do update set name=excluded.name,source_type=excluded.source_type,health=excluded.health,diagnostic=excluded.diagnostic,last_seen_at=excluded.last_seen_at,last_test_at=excluded.last_test_at,audio_sources=excluded.audio_sources;
      if v_job.kind='test' then
        update public.cameras set health=case when v_device->>'health'='online' then 'online' else 'offline' end,last_health_check_at=now()
        where recorder_id=p_recorder_id and device_reference=v_device->>'device_reference' and audio_source=coalesce(v_device->>'audio_source','');
      end if;
    end loop;
  else
    if v_job.kind='test' then
      update public.cameras set health='unknown',last_health_check_at=null where recorder_id=p_recorder_id and device_reference=v_job.device_reference;
      update public.recorder_devices set health='unknown',diagnostic='not_tested',last_test_at=null where recorder_id=p_recorder_id and device_reference=v_job.device_reference;
    end if;
  end if;
  update public.recorder_commands set status=case when p_success then 'succeeded' else 'failed' end,result_code=case when p_success then 'completed' else 'agent_error' end,finished_at=now() where id=p_command_id;
  insert into public.audit_events(action,safe_detail) values('recorder.'||v_job.kind,jsonb_build_object('recorder_id',p_recorder_id,'success',p_success));
  return true;
end; $$;
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
  if not exists(select 1 from public.recorders where id=v_camera.recorder_id and paired_at is not null and last_seen_at>now()-interval '45 seconds' and ffmpeg_available and agent_version in ('0.3.0','0.4.0') and (v_camera.audio_source='' or agent_version='0.4.0')) then raise exception 'Recording service is offline or needs updating'; end if;
  select * into v_settings from public.venue_settings where id=true;
  insert into public.recording_sessions(player_id,court_id,idempotency_key,configuration_snapshot,recipient_email,duration_seconds)
  values(p_player,p_court,p_key,jsonb_build_object('camera_id',v_camera.id,'audio_enabled',v_camera.audio_source<>'','max_duration_seconds',v_settings.max_duration_seconds,'retention_seconds',v_settings.retention_seconds,'venue_time_zone',coalesce(v_settings.venue_time_zone,'UTC')),p_email,v_settings.max_duration_seconds) returning id into v_id;
  insert into public.capture_jobs(session_id,recorder_id,camera_id,device_reference,max_seconds,audio_source) values(v_id,v_camera.recorder_id,v_camera.id,v_camera.device_reference,v_settings.max_duration_seconds,v_camera.audio_source);
  insert into public.audit_events(session_id,actor_id,action) values(v_id,p_player,'capture.requested');
  return v_id;
end; $$;
drop function public.sync_captures(uuid);
create function public.sync_captures(p_recorder uuid) returns table(session_id uuid,claim_token uuid,device_reference text,max_seconds integer,claimed_at timestamptz,stop_requested boolean,audio_source text)
language plpgsql security definer set search_path='' as $$
declare v_job public.capture_jobs;
begin
  -- Never release an active camera on heartbeat expiry: its offline worker may still be recording.
  for v_job in select * from public.capture_jobs j where j.recorder_id=p_recorder and j.status='pending' for update loop
    if v_job.created_at<now()-interval '60 seconds' or exists(select 1 from public.recording_sessions s where s.id=v_job.session_id and s.stop_requested_at is not null) then
      update public.capture_jobs set status='failed' where capture_jobs.session_id=v_job.session_id;
      update public.recording_sessions set status='failed',failure_stage='capture',stop_reason='cancelled_before_start',stopped_at=now() where id=v_job.session_id;
    else
      update public.capture_jobs set status='active',claimed_at=now(),last_seen_at=now() where capture_jobs.session_id=v_job.session_id;
      update public.recording_sessions set status='starting',started_at=now() where id=v_job.session_id;
      insert into public.audit_events(session_id,action) values(v_job.session_id,'capture.starting');
    end if;
  end loop;
  return query select j.session_id,j.claim_token,j.device_reference,j.max_seconds,j.claimed_at,s.stop_requested_at is not null,j.audio_source from public.capture_jobs j join public.recording_sessions s on s.id=j.session_id where j.recorder_id=p_recorder and j.status='active';
end; $$;
revoke all on function public.sync_captures(uuid) from public,anon,authenticated;
grant execute on function public.sync_captures(uuid) to service_role;
drop function public.player_court_status();
create or replace function public.player_court_status() returns table(id uuid,name text,location text,camera_status text,audio_enabled boolean)
language sql stable security definer set search_path='' as $$
  select c.id,c.name,c.location,case
    when exists(select 1 from public.recording_sessions s where s.court_id=c.id and s.status in ('requested','starting','recording','finalizing')) then 'busy'
    when exists(select 1 from public.cameras cam join public.recorders r on r.id=cam.recorder_id where cam.court_id=c.id and cam.enabled and cam.is_primary and cam.health='online' and cam.last_health_check_at is not null and r.last_seen_at>now()-interval '45 seconds' and r.paired_at is not null and r.agent_version in ('0.3.0','0.4.0') and (cam.audio_source='' or r.agent_version='0.4.0')) then 'online' else 'offline' end, exists(select 1 from public.cameras a where a.court_id=c.id and a.enabled and a.is_primary and a.audio_source<>'')
  from public.courts c where c.active and exists(select 1 from public.profiles p where p.id=auth.uid() and p.active) order by c.created_at;
$$;
revoke all on function public.player_court_status() from public,anon;
grant execute on function public.player_court_status() to authenticated;
