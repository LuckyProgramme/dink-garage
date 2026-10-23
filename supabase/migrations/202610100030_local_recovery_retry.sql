-- Reopening a saved local video is idempotent. This covers interrupted
-- captures and uploads cancelled by staff without requiring the admin page or
-- rejecting a tablet that has already restored the server queue.

create or replace function public.queue_browser_upload(p_session uuid,p_device uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare changed uuid;
begin
  update public.recording_sessions s
  set status='uploading',failure_stage=null
  where s.id=p_session
    and s.status='failed'
    and s.failure_stage in ('upload','upload_cancelled')
    and exists(
      select 1 from public.browser_recordings b
      where b.session_id=s.id and b.device_id=p_device and b.file_id is not null
        and b.upload_state in ('failed','cancelled')
    );

  update public.browser_recordings b
  set upload_state=case
        when b.upload_state in ('failed','cancelled') then 'retrying'
        else 'pending'
      end,
      upload_queued_at=case
        when b.upload_state in ('failed','cancelled') then now()
        else coalesce(b.upload_queued_at,now())
      end,
      upload_updated_at=now(),last_error=null,safe_error=null
  where b.session_id=p_session and b.device_id=p_device and b.file_id is not null
    and b.upload_state in ('idle','saved_locally','retrying','failed','cancelled')
    and exists(
      select 1 from public.recording_sessions s
      where s.id=b.session_id and s.status in ('uploading','sharing')
    )
  returning b.session_id into changed;

  return changed is not null or exists(
    select 1 from public.browser_recordings b
    join public.recording_sessions s on s.id=b.session_id
    where b.session_id=p_session and b.device_id=p_device
      and s.status in ('uploading','sharing','ready')
      and b.upload_state in ('pending','uploading','retrying','uploaded')
  );
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

  if changed is not null then
    update public.recording_sessions
    set status='uploading',failure_stage=null
    where id=p_session and status='failed'
      and failure_stage in ('upload','upload_cancelled');
    return true;
  end if;

  return exists(
    select 1 from public.browser_recordings b
    join public.recording_sessions s on s.id=b.session_id
    where b.session_id=p_session and b.device_id=p_device
      and b.file_id is not null
      and b.upload_state in ('pending','retrying','uploading','uploaded')
      and s.status in ('uploading','sharing','ready')
  );
end; $$;

revoke all on function public.queue_browser_upload(uuid,uuid),
  public.retry_browser_upload(uuid,uuid) from public,anon,authenticated;
grant execute on function public.queue_browser_upload(uuid,uuid),
  public.retry_browser_upload(uuid,uuid) to service_role;
