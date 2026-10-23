-- RTSP credentials remain service-role-only and encrypted by the application.
alter table public.browser_devices
 add column recorder_mode text not null default 'browser' check(recorder_mode in ('browser','android_rtsp')),
 add column rtsp_url text not null default '',
 add column rtsp_username text not null default '',
 add column rtsp_password_encrypted text,
 add column config_revision uuid not null default gen_random_uuid(),
 add column tested_revision uuid;
create or replace function public.protect_browser_assignment() returns trigger language plpgsql set search_path='' as $$
declare changed boolean;
begin
 changed := (new.court_id,new.kiosk_id,new.enabled,new.video_device,new.audio_device,new.source_type,new.stream_url,new.recorder_mode,new.rtsp_url,new.rtsp_username,new.rtsp_password_encrypted,new.camera_name)
 is distinct from (old.court_id,old.kiosk_id,old.enabled,old.video_device,old.audio_device,old.source_type,old.stream_url,old.recorder_mode,old.rtsp_url,old.rtsp_username,old.rtsp_password_encrypted,old.camera_name);
 if changed and exists(select 1 from public.browser_recordings b join public.recording_sessions s on s.id=b.session_id where b.device_id=old.id and s.status not in ('ready','failed','deleted')) then
 raise exception 'Finish or recover the current recording before changing its assignment'; end if;
 if changed or (new.test_requested and not old.test_requested) then
  new.config_revision=gen_random_uuid();new.tested_revision=null;
  if new.recorder_mode='android_rtsp' then new.tested_at=null;new.test_requested=true;new.diagnostic='Waiting for tablet camera test.';end if;
 end if;
 return new;
end; $$;
create function public.native_camera_test(p_kiosk uuid,p_revision uuid,p_passed boolean) returns boolean
language plpgsql security definer set search_path='' as $$
declare d public.browser_devices;
begin
 select * into d from public.browser_devices where kiosk_id=p_kiosk and enabled for update;
 if not found or d.recorder_mode<>'android_rtsp' or d.config_revision<>p_revision then return false;end if;
 if not exists(select 1 from public.kiosk_devices where id=p_kiosk and active) then return false;end if;
 if exists(select 1 from public.browser_recordings b join public.recording_sessions s on s.id=b.session_id where b.device_id=d.id and s.status not in ('ready','failed','deleted')) then return false;end if;
 update public.browser_devices set tested_at=case when p_passed then now() else null end,
 tested_revision=case when p_passed then p_revision else null end,test_requested=false,
 diagnostic=case when p_passed then 'Video/audio recording test passed.' else 'Camera test failed. Check camera settings and tablet Wi-Fi, then retry.' end
 where id=d.id;
 return true;
end; $$;
revoke all on function public.native_camera_test(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.native_camera_test(uuid,uuid,boolean) to service_role;
drop function public.browser_start(uuid,text,uuid);
create function public.browser_start(p_kiosk uuid,p_email text,p_key uuid,p_revision uuid default null) returns uuid
language plpgsql security definer set search_path='' as $$
declare d public.browser_devices; settings public.venue_settings; sid uuid;
begin
 select * into d from public.browser_devices where kiosk_id=p_kiosk and enabled for update;
 if not found then raise exception 'Tablet is not enrolled'; end if;
 perform 1 from public.kiosk_devices where id=p_kiosk and active for update;
 if not found then raise exception 'Tablet was revoked'; end if;
 select id into sid from public.recording_sessions where kiosk_id=p_kiosk and idempotency_key=p_key;
 if found then return sid; end if;
 if p_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(p_email)>254 then raise exception 'Enter a valid email'; end if;
 if d.recorder_mode='android_rtsp' and (p_revision is distinct from d.config_revision or d.tested_revision is distinct from d.config_revision) then raise exception 'Camera configuration changed. Test again'; end if;
 if d.tested_at is null then raise exception 'Test this tablet camera first'; end if;
 if exists(select 1 from public.browser_recordings b join public.recording_sessions s on s.id=b.session_id where b.device_id=d.id and s.status not in ('ready','failed','deleted')) then raise exception 'Finish or recover the previous recording first'; end if;
 if (select count(*) from public.recording_sessions where kiosk_id=p_kiosk and created_at>now()-interval '1 minute')>=5 then raise exception 'Please wait before starting another recording'; end if;
 perform 1 from public.courts where id=d.court_id and active for update;
 if not found then raise exception 'Assign an active court first'; end if;
 if exists(select 1 from public.recording_sessions where court_id=d.court_id and status in ('requested','starting','recording','finalizing')) then raise exception 'Court is already recording'; end if;
 select * into settings from public.venue_settings where id=true;
 insert into public.recording_sessions(kiosk_id,court_id,idempotency_key,recipient_email,duration_seconds,configuration_snapshot)
 values(p_kiosk,d.court_id,p_key,p_email,settings.max_duration_seconds,jsonb_build_object('capture_mode','browser','device_id',d.id,'camera_name',d.camera_name,'sharing_mode','link','audio_enabled',d.audio_device<>'','retention_seconds',settings.retention_seconds,'venue_time_zone',coalesce(settings.venue_time_zone,'Asia/Manila'))) returning id into sid;
 insert into public.browser_recordings(session_id,device_id) values(sid,d.id);
 update public.kiosk_devices set current_session_id=sid where id=p_kiosk;
 return sid;
end; $$;

revoke all on function public.browser_start(uuid,text,uuid,uuid) from public,anon,authenticated;
grant execute on function public.browser_start(uuid,text,uuid,uuid) to service_role;
