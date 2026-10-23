-- Recordings shorter than one minute remain only on their originating device.
-- They never enter the venue upload queue or Google Drive.
alter table public.browser_recordings
  drop constraint browser_recordings_upload_state_check;
alter table public.browser_recordings
  add constraint browser_recordings_upload_state_check
  check(upload_state in ('idle','queued','uploading','failed','cancelled','local_only','complete'));

create function public.hold_short_browser_recording(
  p_session uuid,
  p_device uuid,
  p_duration_ms bigint default null
)
returns boolean language plpgsql security definer set search_path='' as $$
declare s public.recording_sessions; b public.browser_recordings;
begin
  select * into s from public.recording_sessions where id=p_session for update;
  select * into b from public.browser_recordings
  where session_id=p_session and device_id=p_device for update;
  if not found then return false; end if;
  if s.failure_stage='short_recording' and b.upload_state='local_only' then
    return true;
  end if;
  if s.status not in ('uploading','sharing') or b.file_id is null then
    return false;
  end if;
  if p_duration_ms is not null then
    if p_duration_ms<0 or p_duration_ms>7200000 then
      raise exception 'Invalid recording duration';
    end if;
    if p_duration_ms>=60000 then return false; end if;
  elsif s.started_at is null or s.stopped_at is null
    or s.stopped_at-s.started_at>=interval '1 minute' then
    return false;
  end if;
  update public.browser_recordings
  set upload_state='local_only',upload_updated_at=now(),lease_until=null,
      safe_error='Recording under one minute. Kept only on the original device.'
  where session_id=p_session;
  update public.recording_sessions
  set status='failed',failure_stage='short_recording',
      stop_reason='short_recording'
  where id=p_session;
  return true;
end; $$;

revoke all on function public.hold_short_browser_recording(uuid,uuid,bigint)
from public,anon,authenticated;
grant execute on function public.hold_short_browser_recording(uuid,uuid,bigint)
to service_role;
