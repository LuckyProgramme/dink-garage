-- One match has two teams with two recipients each. The first address remains
-- in recipient_email for compatibility; the complete list stays in the snapshot.
drop function public.browser_start(uuid,text,uuid,uuid);
create function public.browser_start(
 p_kiosk uuid,p_email text,p_key uuid,p_revision uuid default null,p_recipients jsonb default null
) returns uuid
language plpgsql security definer set search_path='' as $$
declare d public.browser_devices; settings public.venue_settings; sid uuid; v_recipients jsonb;
begin
 select coalesce(jsonb_agg(lower(trim(value)) order by ordinality),'[]'::jsonb) into v_recipients
 from jsonb_array_elements_text(coalesce(p_recipients,jsonb_build_array(p_email))) with ordinality e(value,ordinality);
 if jsonb_array_length(v_recipients) not in (1,4)
   or exists(select 1 from jsonb_array_elements_text(v_recipients) e(value)
     where length(value)>254 or value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
       or value ~* '@example\.(com|net|org)$')
   or (select count(distinct value) from jsonb_array_elements_text(v_recipients) e(value))<>jsonb_array_length(v_recipients)
   or (v_recipients->>0)<>lower(trim(p_email)) then
  raise exception 'Enter two different email addresses for each team';
 end if;
 select * into d from public.browser_devices where kiosk_id=p_kiosk and enabled for update;
 if not found then raise exception 'Tablet is not enrolled'; end if;
 perform 1 from public.kiosk_devices where id=p_kiosk and active for update;
 if not found then raise exception 'Tablet was revoked'; end if;
 select id into sid from public.recording_sessions where kiosk_id=p_kiosk and idempotency_key=p_key;
 if found then return sid; end if;
 if d.recorder_mode='android_rtsp' and (p_revision is distinct from d.config_revision or d.tested_revision is distinct from d.config_revision) then raise exception 'Camera configuration changed. Test again'; end if;
 if d.tested_at is null then raise exception 'Test this tablet camera first'; end if;
 if exists(select 1 from public.browser_recordings b join public.recording_sessions s on s.id=b.session_id where b.device_id=d.id and s.status not in ('ready','failed','deleted')) then raise exception 'Finish or recover the previous recording first'; end if;
 if (select count(*) from public.recording_sessions where kiosk_id=p_kiosk and created_at>now()-interval '1 minute')>=5 then raise exception 'Please wait before starting another recording'; end if;
 perform 1 from public.courts where id=d.court_id and active for update;
 if not found then raise exception 'Assign an active court first'; end if;
 if exists(select 1 from public.recording_sessions where court_id=d.court_id and status in ('requested','starting','recording','finalizing')) then raise exception 'Court is already recording'; end if;
 select * into settings from public.venue_settings where id=true;
 insert into public.recording_sessions(kiosk_id,court_id,idempotency_key,recipient_email,duration_seconds,configuration_snapshot)
 values(p_kiosk,d.court_id,p_key,v_recipients->>0,settings.max_duration_seconds,
   jsonb_build_object('capture_mode','browser','device_id',d.id,'camera_name',d.camera_name,'sharing_mode','link','recipient_emails',v_recipients,'audio_enabled',d.audio_device<>'','retention_seconds',settings.retention_seconds,'venue_time_zone',coalesce(settings.venue_time_zone,'Asia/Manila'))) returning id into sid;
 insert into public.browser_recordings(session_id,device_id) values(sid,d.id);
 update public.kiosk_devices set current_session_id=sid where id=p_kiosk;
 return sid;
end; $$;
revoke all on function public.browser_start(uuid,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.browser_start(uuid,text,uuid,uuid,jsonb) to service_role;

drop function public.start_guest_capture(uuid,text,uuid,uuid);
create function public.start_guest_capture(
 p_kiosk uuid,p_email text,p_court uuid,p_key uuid,p_recipients jsonb default null
) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_id uuid; v_camera public.cameras; v_settings public.venue_settings; v_recipients jsonb;
begin
  select coalesce(jsonb_agg(lower(trim(value)) order by ordinality),'[]'::jsonb) into v_recipients
  from jsonb_array_elements_text(coalesce(p_recipients,jsonb_build_array(p_email))) with ordinality e(value,ordinality);
  if jsonb_array_length(v_recipients) not in (1,4)
    or exists(select 1 from jsonb_array_elements_text(v_recipients) e(value)
      where length(value)>254 or value !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
        or value ~* '@example\.(com|net|org)$')
    or (select count(distinct value) from jsonb_array_elements_text(v_recipients) e(value))<>jsonb_array_length(v_recipients)
    or (v_recipients->>0)<>lower(trim(p_email)) then
   raise exception 'Enter two different email addresses for each team';
  end if;
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
  values(p_kiosk,p_court,p_key,jsonb_build_object('sharing_mode','link','recipient_emails',v_recipients,'camera_id',v_camera.id,'audio_enabled',v_camera.audio_source<>'','max_duration_seconds',v_settings.max_duration_seconds,'retention_seconds',v_settings.retention_seconds,'venue_time_zone',coalesce(v_settings.venue_time_zone,'UTC')),v_recipients->>0,v_settings.max_duration_seconds) returning id into v_id;
  insert into public.capture_jobs(session_id,recorder_id,camera_id,device_reference,max_seconds,audio_source) values(v_id,v_camera.recorder_id,v_camera.id,v_camera.device_reference,v_settings.max_duration_seconds,v_camera.audio_source);
  insert into public.audit_events(session_id,actor_id,action) values(v_id,null,'capture.requested');
  update public.kiosk_devices set current_session_id=v_id where id=p_kiosk;
  return v_id;
end; $$;
revoke all on function public.start_guest_capture(uuid,text,uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function public.start_guest_capture(uuid,text,uuid,uuid,jsonb) to service_role;
