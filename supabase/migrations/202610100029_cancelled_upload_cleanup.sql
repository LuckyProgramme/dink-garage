-- Uploads are independent from capture setup. Cancelling an upload releases
-- stale session/device locks while preserving recording logs and local files.

update public.recording_sessions s
set status='failed',
    failure_stage='upload_cancelled',
    stopped_at=coalesce(s.stopped_at,now())
from public.browser_recordings b
where b.session_id=s.id
  and b.upload_state='cancelled'
  and s.status in ('uploading','sharing');

update public.kiosk_devices k
set current_session_id=null
where current_session_id is not null
  and exists(
    select 1 from public.recording_sessions s
    where s.id=k.current_session_id
      and s.status not in ('requested','starting','recording','finalizing')
  );

create or replace function public.cancel_browser_upload(p_session uuid,p_device uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare changed uuid; kiosk uuid;
begin
  perform 1 from public.venue_settings where id=true for update;
  update public.browser_recordings b
  set upload_state='cancelled',upload_updated_at=now(),lease_until=null,
      last_error='Upload cancelled. The local video remains on its original device.',
      safe_error='Upload cancelled. The local video remains on its original device.'
  where b.session_id=p_session and b.device_id=p_device
    and b.upload_state in ('pending','uploading','retrying','failed','queued')
    and exists(select 1 from public.recording_sessions s where s.id=b.session_id and s.status in ('uploading','sharing','failed'))
  returning b.session_id into changed;
  if changed is null then return false; end if;

  update public.recording_sessions
  set status='failed',failure_stage='upload_cancelled',stopped_at=coalesce(stopped_at,now())
  where id=p_session
  returning kiosk_id into kiosk;
  update public.kiosk_devices set current_session_id=null
  where id=kiosk and current_session_id=p_session;
  return true;
end; $$;

create or replace function public.retry_browser_upload(p_session uuid,p_device uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare changed uuid;
begin
  perform 1 from public.venue_settings where id=true for update;
  update public.browser_recordings
  set upload_state='retrying',upload_queued_at=now(),upload_started_at=null,
      upload_updated_at=now(),retry_count=0,last_error=null,safe_error=null
  where session_id=p_session and device_id=p_device
    and upload_state in ('failed','cancelled') and file_id is not null
  returning session_id into changed;
  if changed is null then return false; end if;
  update public.recording_sessions
  set status='uploading',failure_stage=null
  where id=p_session and status='failed' and failure_stage in ('upload','upload_cancelled');
  return true;
end; $$;

create or replace function public.protect_browser_device_delete() returns trigger
language plpgsql set search_path='' as $$
begin
  if exists(
    select 1 from public.browser_recordings b
    join public.recording_sessions s on s.id=b.session_id
    where b.device_id=old.id
      and s.status in ('requested','starting','recording','finalizing')
  ) then
    raise exception 'Finish or recover the active recording before removing this device';
  end if;
  return old;
end; $$;

create or replace function public.protect_browser_assignment() returns trigger
language plpgsql set search_path='' as $$
declare changed boolean;
begin
  changed := (new.court_id,new.kiosk_id,new.enabled,new.video_device,new.audio_device,
    new.source_type,new.stream_url,new.recorder_mode,new.rtsp_url,new.rtsp_username,
    new.rtsp_password_encrypted,new.camera_name,new.video_rotation,
    new.video_flip_horizontal,new.video_flip_vertical)
  is distinct from
    (old.court_id,old.kiosk_id,old.enabled,old.video_device,old.audio_device,
    old.source_type,old.stream_url,old.recorder_mode,old.rtsp_url,old.rtsp_username,
    old.rtsp_password_encrypted,old.camera_name,old.video_rotation,
    old.video_flip_horizontal,old.video_flip_vertical);
  if changed and exists(
    select 1 from public.browser_recordings b
    join public.recording_sessions s on s.id=b.session_id
    where b.device_id=old.id
      and s.status in ('requested','starting','recording','finalizing')
  ) then
    raise exception 'Finish or recover the current recording before changing its assignment';
  end if;
  if changed or (new.test_requested and not old.test_requested) then
    new.config_revision=gen_random_uuid();
    new.tested_revision=null;
    if new.recorder_mode='android_rtsp' then
      new.tested_at=null;
      new.test_requested=true;
      new.diagnostic='Waiting for tablet camera test.';
    end if;
  end if;
  return new;
end; $$;

create or replace function public.enroll_browser(p_hash text,p_token text,p_setup text,p_admin uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare d public.browser_devices; k uuid;
begin
  select * into d from public.browser_devices
  where enrollment_hash=p_hash and enrollment_expires_at>now() and enabled for update;
  if not found then raise exception 'Enrollment code is invalid or expired'; end if;
  if exists(
    select 1 from public.browser_recordings b
    join public.recording_sessions s on s.id=b.session_id
    where b.device_id=d.id
      and s.status in ('requested','starting','recording','finalizing')
  ) then
    raise exception 'Finish the current recording first';
  end if;
  if d.kiosk_id is not null then
    update public.kiosk_devices set active=false,current_session_id=null where id=d.kiosk_id;
  end if;
  insert into public.kiosk_devices(token_hash,created_by)
  values(p_token,p_admin) returning id into k;
  update public.browser_devices
  set kiosk_id=k,enrollment_hash=null,enrollment_expires_at=null,
      setup_hash=p_setup,setup_expires_at=now()+interval '15 minutes',tested_at=null
  where id=d.id;
  return k;
end; $$;

create or replace function public.preserve_court_history_before_delete()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists(
    select 1 from public.recording_sessions
    where court_id=old.id
      and status in ('requested','starting','recording','finalizing')
  ) then
    raise exception 'Stop the active recording before removing this court';
  end if;
  update public.recording_sessions
  set configuration_snapshot=configuration_snapshot || jsonb_build_object('court_name',old.name)
  where court_id=old.id;
  return old;
end; $$;

revoke all on function public.cancel_browser_upload(uuid,uuid),public.retry_browser_upload(uuid,uuid),
  public.enroll_browser(text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.cancel_browser_upload(uuid,uuid),public.retry_browser_upload(uuid,uuid),
  public.enroll_browser(text,text,text,uuid) to service_role;
