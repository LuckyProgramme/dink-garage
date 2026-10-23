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
    and exists(select 1 from public.recording_sessions s where s.id=b.session_id and (s.status in ('uploading','sharing','failed') or (s.status='finalizing' and s.stopped_at is not null and b.upload_state='failed')))
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

-- Remove atomically: a rejected removal must not revoke the enrollment.
create function public.remove_browser_device(p_device uuid,p_actor uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare d public.browser_devices; sid uuid;
begin
 select * into d from public.browser_devices where id=p_device for update;
 if not found then return false; end if;
 -- Only ended captures with an explicitly failed upload are stale finalizers.
 for sid in select s.id from public.recording_sessions s
   join public.browser_recordings b on b.session_id=s.id
   where b.device_id=p_device and b.upload_state='failed'
     and s.status='finalizing' and s.stopped_at is not null
 loop
   perform public.cancel_browser_upload(sid,p_device);
 end loop;
 -- The existing trigger still rejects a genuine active capture.
 delete from public.browser_devices where id=p_device;
 update public.kiosk_devices set active=false,current_session_id=null where id=d.kiosk_id;
 insert into public.audit_events(actor_id,action,safe_detail)
 values(p_actor,'tablet.removed',jsonb_build_object('device_id',p_device,'device_name',d.name));
 return true;
end; $$;
revoke all on function public.remove_browser_device(uuid,uuid) from public,anon,authenticated;
grant execute on function public.remove_browser_device(uuid,uuid) to service_role;
