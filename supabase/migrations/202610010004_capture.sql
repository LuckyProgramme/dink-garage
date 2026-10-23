alter table public.recording_sessions drop constraint recording_sessions_status_check;
alter table public.recording_sessions add constraint recording_sessions_status_check check(status in ('requested','starting','recording','finalizing','local_ready','uploading','sharing','ready','failed','deleting','deleted'));
alter table public.recording_sessions add column stop_requested_at timestamptz;
alter table public.recording_sessions add column duration_seconds integer;
alter table public.recording_files add column bytes bigint;
alter table public.recording_files add column local_filename text;

create table public.capture_jobs (
  session_id uuid primary key references public.recording_sessions(id),
  recorder_id uuid not null references public.recorders(id),
  camera_id uuid not null references public.cameras(id),
  device_reference text not null,
  max_seconds integer not null check(max_seconds between 1 and 7200),
  status text not null default 'pending' check(status in ('pending','active','completed','failed')),
  claim_token uuid not null default gen_random_uuid(),
  claimed_at timestamptz,
  last_seen_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index capture_device_lock on public.capture_jobs(recorder_id,device_reference) where status in ('pending','active');
alter table public.capture_jobs enable row level security;
revoke all on public.capture_jobs from anon,authenticated;
grant select on public.capture_jobs to authenticated;
create policy capture_admin_read on public.capture_jobs for select to authenticated using(public.is_admin());

create function public.start_capture(p_player uuid,p_email text,p_court uuid,p_key uuid) returns uuid
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
  if v_camera.health<>'online' or v_camera.last_health_check_at is null or v_camera.last_health_check_at<now()-interval '5 minutes' then raise exception 'Camera needs a connection test in the admin dashboard'; end if;
  if not exists(select 1 from public.recorders where id=v_camera.recorder_id and paired_at is not null and last_seen_at>now()-interval '45 seconds' and ffmpeg_available and agent_version='0.3.0') then raise exception 'Recording service is offline or needs updating'; end if;
  select * into v_settings from public.venue_settings where id=true;
  insert into public.recording_sessions(player_id,court_id,idempotency_key,configuration_snapshot,recipient_email,duration_seconds)
  values(p_player,p_court,p_key,jsonb_build_object('camera_id',v_camera.id,'max_duration_seconds',v_settings.max_duration_seconds,'retention_seconds',v_settings.retention_seconds,'venue_time_zone',coalesce(v_settings.venue_time_zone,'UTC')),p_email,v_settings.max_duration_seconds) returning id into v_id;
  insert into public.capture_jobs(session_id,recorder_id,camera_id,device_reference,max_seconds) values(v_id,v_camera.recorder_id,v_camera.id,v_camera.device_reference,v_settings.max_duration_seconds);
  insert into public.audit_events(session_id,actor_id,action) values(v_id,p_player,'capture.requested');
  return v_id;
end; $$;

create function public.stop_capture(p_player uuid,p_session uuid) returns boolean
language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.recording_sessions where id=p_session and (player_id=p_player or exists(select 1 from public.profiles where id=p_player and role='admin' and active)) for update;
  if not found then return false; end if;
  update public.recording_sessions set stop_requested_at=coalesce(stop_requested_at,now())
  where id=p_session and (player_id=p_player or exists(select 1 from public.profiles where id=p_player and role='admin' and active)) and status in ('requested','starting','recording','finalizing');
  return true;
end; $$;

create function public.sync_captures(p_recorder uuid) returns table(session_id uuid,claim_token uuid,device_reference text,max_seconds integer,claimed_at timestamptz,stop_requested boolean)
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
  return query select j.session_id,j.claim_token,j.device_reference,j.max_seconds,j.claimed_at,s.stop_requested_at is not null from public.capture_jobs j join public.recording_sessions s on s.id=j.session_id where j.recorder_id=p_recorder and j.status='active';
end; $$;

create function public.report_capture(p_recorder uuid,p_session uuid,p_token uuid,p_state text,p_reason text,p_bytes bigint) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_job public.capture_jobs; v_status text;
begin
  select * into v_job from public.capture_jobs where session_id=p_session and recorder_id=p_recorder and claim_token=p_token for update;
  if not found then return false; end if;
  if v_job.status in ('completed','failed') then return true; end if;
  if v_job.status<>'active' or p_state not in ('recording','finalizing','local_ready','failed') or p_reason not in ('running','player_stop','time_limit','interrupted','capture_error','storage_full','device_missing') or p_bytes<0 then raise exception 'Invalid capture report'; end if;
  select status into v_status from public.recording_sessions where id=p_session;
  update public.capture_jobs set last_seen_at=now() where session_id=p_session;
  if p_state='recording' and v_status='finalizing' then return true; end if;
  if p_state='local_ready' and p_bytes=0 then raise exception 'Recording is empty'; end if;
  update public.recording_sessions set status=p_state,
    stopped_at=case when p_state in ('local_ready','failed') then now() else stopped_at end,
    stop_reason=case when p_state in ('local_ready','failed') then p_reason else stop_reason end,
    failure_stage=case when p_state='failed' then 'capture' else null end where id=p_session;
  if v_status<>p_state then insert into public.audit_events(session_id,action) values(p_session,'capture.'||p_state); end if;
  if p_state in ('local_ready','failed') then
    update public.capture_jobs set status=case when p_state='local_ready' then 'completed' else 'failed' end where session_id=p_session;
    if p_bytes>0 then
      insert into public.recording_files(session_id,camera_id,status,bytes,local_filename) values(p_session,v_job.camera_id,case when p_state='local_ready' then 'local_ready' else 'partial' end,p_bytes,p_session::text||'/video.mp4')
      on conflict(session_id,camera_id) do nothing;
    end if;
    update public.cameras set health=case when p_state='local_ready' then 'online' else 'offline' end,last_health_check_at=now() where id=v_job.camera_id;
  end if;
  return true;
end; $$;
revoke all on function public.start_capture(uuid,text,uuid,uuid),public.stop_capture(uuid,uuid),public.sync_captures(uuid),public.report_capture(uuid,uuid,uuid,text,text,bigint) from public,anon,authenticated;
grant execute on function public.start_capture(uuid,text,uuid,uuid),public.stop_capture(uuid,uuid),public.sync_captures(uuid),public.report_capture(uuid,uuid,uuid,text,text,bigint) to service_role;

create or replace function public.player_court_status() returns table(id uuid,name text,location text,camera_status text)
language sql stable security definer set search_path='' as $$
  select c.id,c.name,c.location,case
    when exists(select 1 from public.recording_sessions s where s.court_id=c.id and s.status in ('requested','starting','recording','finalizing')) then 'busy'
    when exists(select 1 from public.cameras cam join public.recorders r on r.id=cam.recorder_id where cam.court_id=c.id and cam.enabled and cam.is_primary and cam.health='online' and cam.last_health_check_at>now()-interval '5 minutes' and r.last_seen_at>now()-interval '45 seconds' and r.paired_at is not null and r.agent_version='0.3.0') then 'online' else 'offline' end
  from public.courts c where c.active and exists(select 1 from public.profiles p where p.id=auth.uid() and p.active) order by c.created_at;
$$;

-- Serialize diagnostics against capture admission using the same recorder lock.
create or replace function public.claim_recorder_command(p_recorder_id uuid) returns setof public.recorder_commands
language plpgsql security definer set search_path='' as $$
begin
  perform 1 from public.recorders where id=p_recorder_id for update;
  if exists(select 1 from public.capture_jobs where recorder_id=p_recorder_id and status in ('pending','active')) then return; end if;
  update public.recorder_commands set status='failed',result_code='expired',finished_at=now()
  where recorder_id=p_recorder_id and status in ('pending','running') and (created_at<now()-interval '10 minutes' or (attempts>=3 and lease_until<now()));
  return query update public.recorder_commands set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds'
  where id=(select id from public.recorder_commands where recorder_id=p_recorder_id and (status='pending' or (status='running' and lease_until<now())) order by created_at for update skip locked limit 1) returning *;
end; $$;
