-- Browser/USB recordings must be MP4 before they can enter the Drive queue.
-- Older WebM files remain on their originating browser as downloadable backups.
create function public.hold_unsupported_browser_recording(
  p_session uuid,
  p_device uuid
)
returns boolean language plpgsql security definer set search_path='' as $$
declare s public.recording_sessions; b public.browser_recordings;
begin
  select * into s from public.recording_sessions where id=p_session for update;
  select * into b from public.browser_recordings
  where session_id=p_session and device_id=p_device for update;
  if not found then return false; end if;
  if s.failure_stage='unsupported_format' and b.upload_state='local_only' then
    return true;
  end if;
  if b.mime_type is null or b.mime_type='video/mp4' then return false; end if;
  if s.status not in ('uploading','sharing','failed') or b.file_id is null then
    return false;
  end if;
  update public.browser_recordings
  set upload_state='local_only',upload_updated_at=now(),lease_until=null,
      upload_uri_encrypted=null,
      safe_error='Older WebM recording. Kept only on the original device.'
  where session_id=p_session;
  update public.recording_sessions
  set status='failed',failure_stage='unsupported_format',
      stop_reason='unsupported_format'
  where id=p_session;
  return true;
end; $$;

revoke all on function public.hold_unsupported_browser_recording(uuid,uuid)
from public,anon,authenticated;
grant execute on function public.hold_unsupported_browser_recording(uuid,uuid)
to service_role;

-- Stop any not-yet-finished legacy WebM upload from blocking the venue queue.
update public.browser_recordings b
set upload_state='local_only',upload_updated_at=now(),lease_until=null,
    upload_uri_encrypted=null,
    safe_error='Older WebM recording. Kept only on the original device.'
from public.recording_sessions s
where s.id=b.session_id and b.mime_type<>'video/mp4'
  and b.upload_state in ('idle','queued','uploading','failed','cancelled')
  and s.status in ('uploading','sharing','failed');

update public.recording_sessions s
set status='failed',failure_stage='unsupported_format',
    stop_reason='unsupported_format'
from public.browser_recordings b
where b.session_id=s.id and b.mime_type<>'video/mp4'
  and b.upload_state='local_only'
  and b.safe_error='Older WebM recording. Kept only on the original device.';
