-- Browser camera orientation is stored with the enrolled device so the test
-- clip and every match use the same recorded transform.
alter table public.browser_devices
 add column video_rotation smallint not null default 0
   check (video_rotation in (0, 90, 180, 270)),
 add column video_flip_horizontal boolean not null default false,
 add column video_flip_vertical boolean not null default false;

create or replace function public.protect_browser_assignment() returns trigger language plpgsql set search_path='' as $$
declare changed boolean;
begin
 changed := (new.court_id,new.kiosk_id,new.enabled,new.video_device,new.audio_device,new.source_type,new.stream_url,new.recorder_mode,new.rtsp_url,new.rtsp_username,new.rtsp_password_encrypted,new.camera_name,new.video_rotation,new.video_flip_horizontal,new.video_flip_vertical)
 is distinct from (old.court_id,old.kiosk_id,old.enabled,old.video_device,old.audio_device,old.source_type,old.stream_url,old.recorder_mode,old.rtsp_url,old.rtsp_username,old.rtsp_password_encrypted,old.camera_name,old.video_rotation,old.video_flip_horizontal,old.video_flip_vertical);
 if changed and exists(select 1 from public.browser_recordings b join public.recording_sessions s on s.id=b.session_id where b.device_id=old.id and s.status not in ('ready','failed','deleted')) then
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
