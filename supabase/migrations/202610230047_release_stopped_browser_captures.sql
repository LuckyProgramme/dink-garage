-- A `stopped` event ends capture even if the page closes before local storage
-- finishes and the follow-up `captured` request is lost. Release that stopped
-- capture so a locally saved or pending clip never blocks the next match.
create or replace function public.release_stopped_browser_captures(p_kiosk uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare d uuid; item record; released integer:=0;
begin
  select id into d from public.browser_devices where kiosk_id=p_kiosk and enabled;
  if d is null then return 0; end if;
  for item in
    select s.id,s.created_at from public.recording_sessions s
    join public.browser_recordings b on b.session_id=s.id
    where s.kiosk_id=p_kiosk and b.device_id=d
      and s.status='finalizing' and s.stopped_at is not null
    for update of s,b
  loop
    update public.recording_sessions
    set status='uploading',failure_stage=null,stopped_at=coalesce(stopped_at,now())
    where id=item.id;
    update public.browser_recordings
    set upload_state=case
          when file_id is null and upload_state in ('idle','saved_locally') then 'saved_locally'
          else upload_state end,
        upload_updated_at=now(),
        client_created_at=coalesce(client_created_at,item.created_at),
        safe_error=null
    where session_id=item.id and device_id=d;
    update public.kiosk_devices
    set current_session_id=null
    where id=p_kiosk and current_session_id=item.id;
    released:=released+1;
  end loop;
  return released;
end; $$;

-- Heartbeats from the tablet also release a stopped capture whose `captured`
-- follow-up was lost, so the kiosk returns to the welcome screen on its own.
create or replace function public.browser_event(
  p_kiosk uuid,p_session uuid,p_action text,p_bytes bigint default null,p_mime text default null
) returns boolean language plpgsql security definer set search_path='' as $$
declare s public.recording_sessions; b public.browser_recordings; f uuid; device uuid;
begin
 select id into device from public.browser_devices where kiosk_id=p_kiosk and enabled for update;
 if not found then return false; end if;
 perform 1 from public.kiosk_devices where id=p_kiosk and active for update;
 if not found then return false; end if;
 select * into s from public.recording_sessions where id=p_session and kiosk_id=p_kiosk for update;
 if not found then return false; end if;
 select * into b from public.browser_recordings where session_id=p_session and device_id=device for update;
 if not found then return false; end if;
 update public.browser_recordings set last_seen_at=now() where session_id=p_session;
 if p_action='started' then
  if s.status='recording' then return true; end if;
  if s.status<>'requested' then return false; end if;
  update public.recording_sessions set status='recording',started_at=now() where id=p_session;
 elsif p_action='stopped' then
  if s.status='finalizing' then return true; end if;
  if s.status not in ('requested','recording') then return false; end if;
  update public.recording_sessions set status='finalizing',started_at=coalesce(started_at,now()),stopped_at=coalesce(stopped_at,now()) where id=p_session;
 elsif p_action='captured' then
  if s.status in ('uploading','sharing','ready') then
   update public.kiosk_devices set current_session_id=null where id=p_kiosk and current_session_id=p_session;
   return true;
  end if;
  if s.status not in ('requested','recording','finalizing') then return false; end if;
  update public.recording_sessions set status='uploading',started_at=coalesce(started_at,now()),
    stopped_at=coalesce(stopped_at,now()),failure_stage=null where id=p_session;
  update public.browser_recordings set
    upload_state=case when file_id is null and upload_state in ('idle','saved_locally') then 'saved_locally' else upload_state end,
    upload_updated_at=now(),client_created_at=coalesce(client_created_at,s.created_at),safe_error=null
    where session_id=p_session;
  update public.kiosk_devices set current_session_id=null where id=p_kiosk and current_session_id=p_session;
 elsif p_action='saved' then
  if p_bytes is null or p_bytes<1 or p_bytes>4294967296 or p_mime not in ('video/webm','video/mp4') then raise exception 'Invalid recording'; end if;
  if b.file_id is not null then return b.bytes=p_bytes and b.mime_type=p_mime; end if;
  if s.status not in ('requested','recording','finalizing','uploading','failed') then return false; end if;
  insert into public.recording_files(session_id,status,bytes) values(p_session,'local_ready',p_bytes) returning id into f;
  update public.browser_recordings set file_id=f,bytes=p_bytes,mime_type=p_mime,safe_error=null,last_error=null,
    upload_state='saved_locally',upload_updated_at=now(),client_created_at=coalesce(client_created_at,s.created_at)
    where session_id=p_session;
  update public.recording_sessions set status='uploading',stopped_at=coalesce(stopped_at,now()),failure_stage=null where id=p_session;
  update public.kiosk_devices set current_session_id=null where id=p_kiosk and current_session_id=p_session;
 elsif p_action='failed' then
  if s.status not in ('requested','recording','finalizing') then return false; end if;
  update public.recording_sessions set status='failed',stopped_at=coalesce(stopped_at,now()),failure_stage='browser_capture' where id=p_session;
  update public.browser_recordings set upload_state='failed',last_error='Recording was interrupted.',safe_error='Recording was interrupted.',upload_updated_at=now() where session_id=p_session;
  update public.kiosk_devices set current_session_id=null where id=p_kiosk and current_session_id=p_session;
 elsif p_action='reset' then
  if s.status not in ('ready','failed','deleted') then return false; end if;
  update public.kiosk_devices set current_session_id=null where id=p_kiosk and current_session_id=p_session;
 elsif p_action='heartbeat' then
  perform public.release_stopped_browser_captures(p_kiosk);
 elsif p_action<>'heartbeat' then return false;
 end if;
 return true;
end; $$;

-- The next capture may proceed once the previous browser has reported `stopped`;
-- its local clip remains independently recoverable and uploadable.
create or replace function public.browser_start(
 p_kiosk uuid,p_email text,p_key uuid,p_revision uuid default null,p_recipients jsonb default null
) returns uuid
language plpgsql security definer set search_path='' as $$
declare d public.browser_devices; settings public.venue_settings; sid uuid; v_recipients jsonb;
begin
 select coalesce(jsonb_agg(lower(trim(value)) order by ordinality),'[]'::jsonb) into v_recipients
 from jsonb_array_elements_text(coalesce(p_recipients,jsonb_build_array(p_email))) with ordinality e(value,ordinality);
 if jsonb_array_length(v_recipients) not between 1 and 4
   or exists(select 1 from jsonb_array_elements_text(v_recipients) e(value)
     where length(value)>254 or value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
       or value ~* '@example\.(com|net|org)$')
   or (select count(distinct value) from jsonb_array_elements_text(v_recipients) e(value))<>jsonb_array_length(v_recipients)
   or (v_recipients->>0)<>lower(trim(p_email)) then
  raise exception 'Enter at least one valid email address on either team';
 end if;
 select * into d from public.browser_devices where kiosk_id=p_kiosk and enabled for update;
 if not found then raise exception 'Tablet is not enrolled'; end if;
 perform 1 from public.kiosk_devices where id=p_kiosk and active for update;
 if not found then raise exception 'Tablet was revoked'; end if;
 select id into sid from public.recording_sessions where kiosk_id=p_kiosk and idempotency_key=p_key;
 if found then return sid; end if;
 if d.recorder_mode='android_rtsp' and (p_revision is distinct from d.config_revision or d.tested_revision is distinct from d.config_revision) then raise exception 'Camera configuration changed. Test again'; end if;
 if d.tested_at is null then raise exception 'Test this tablet camera first'; end if;
 perform public.release_stopped_browser_captures(p_kiosk);
 if exists(select 1 from public.browser_recordings b join public.recording_sessions s on s.id=b.session_id where b.device_id=d.id and s.status in ('requested','starting','recording','finalizing')) then raise exception 'Finish or recover the previous recording first'; end if;
 if (select count(*) from public.recording_sessions where kiosk_id=p_kiosk and created_at>now()-interval '1 minute')>=5 then raise exception 'Please wait before starting another recording'; end if;
 perform 1 from public.courts where id=d.court_id and active for update;
 if not found then raise exception 'Assign an active court first'; end if;
 -- Registered device lock and unique active-device index prevent overlapping capture.
 select * into settings from public.venue_settings where id=true;
 insert into public.recording_sessions(kiosk_id,court_id,idempotency_key,recipient_email,duration_seconds,configuration_snapshot)
 values(p_kiosk,d.court_id,p_key,v_recipients->>0,settings.max_duration_seconds,
   jsonb_build_object('capture_mode','browser','device_id',d.id,'camera_name',d.camera_name,'sharing_mode','private','recipient_emails',v_recipients,'audio_enabled',d.audio_device<>'','retention_seconds',settings.retention_seconds,'venue_time_zone',coalesce(settings.venue_time_zone,'Asia/Manila'))) returning id into sid;
 insert into public.browser_recordings(session_id,device_id) values(sid,d.id);
 update public.kiosk_devices set current_session_id=sid where id=p_kiosk;
 return sid;
end; $$;

-- Repair captures already stranded in finalizing by an older client.
do $$ declare k uuid; begin
  for k in select distinct s.kiosk_id from public.recording_sessions s
    join public.browser_recordings b on b.session_id=s.id
    where s.status='finalizing' and s.stopped_at is not null and s.kiosk_id is not null
  loop
    perform public.release_stopped_browser_captures(k);
  end loop;
end $$;

alter function public.release_stopped_browser_captures(uuid) owner to dinkvision_executor;
alter function public.browser_event(uuid,uuid,text,bigint,text) owner to dinkvision_executor;
alter function public.browser_start(uuid,text,uuid,uuid,jsonb) owner to dinkvision_executor;
revoke all on function public.release_stopped_browser_captures(uuid) from public,anon,authenticated;
revoke all on function public.browser_event(uuid,uuid,text,bigint,text) from public,anon,authenticated;
revoke all on function public.browser_start(uuid,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.release_stopped_browser_captures(uuid) to service_role;
grant execute on function public.browser_event(uuid,uuid,text,bigint,text) to service_role;
grant execute on function public.browser_start(uuid,text,uuid,uuid,jsonb) to service_role;
