-- Venue policy: keep sub-minute recordings locally without Drive or email.
-- This supersedes migration 033's duration policy, not its recovery safeguards.
create or replace function public.hold_short_browser_recording(
  p_session uuid,p_device uuid,p_duration_ms bigint default null
) returns boolean language plpgsql security definer set search_path='' as $$
declare s public.recording_sessions; b public.browser_recordings; duration bigint;
begin
  if p_duration_ms is not null and (p_duration_ms<0 or p_duration_ms>7200000) then
    raise exception 'Invalid recording duration';
  end if;
  select * into s from public.recording_sessions where id=p_session for update;
  select * into b from public.browser_recordings
    where session_id=p_session and device_id=p_device for update;
  if not found then return false; end if;
  if s.failure_stage='short_recording' and b.upload_state='local_only' then return true; end if;
  if s.status not in ('uploading','sharing','failed') or b.file_id is null then return false; end if;
  duration:=coalesce(p_duration_ms,b.duration_ms,
    floor(extract(epoch from (s.stopped_at-s.started_at))*1000)::bigint);
  update public.browser_recordings set duration_ms=coalesce(duration,duration_ms)
    where session_id=p_session;
  if duration is null or duration>=60000 then return false; end if;
  update public.browser_recordings set upload_state='local_only',upload_updated_at=now(),
    lease_until=null,lease_token=null,
    last_error='Recording under one minute. Saved locally; no Drive upload or email.',
    safe_error='Recording under one minute. Saved locally; no Drive upload or email.'
    where session_id=p_session;
  update public.recording_sessions set status='failed',failure_stage='short_recording',stop_reason='short_recording'
    where id=p_session;
  update public.kiosk_devices set current_session_id=null
    where id=s.kiosk_id and current_session_id=p_session;
  return true;
end; $$;

-- Protect retries of email jobs, including short videos already uploaded under
-- the previous policy. Existing sent emails and Drive files are not deleted.
create function public.hold_short_recording_email()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.status in ('pending','sending') and exists(
    select 1 from public.browser_recordings b where b.file_id=new.file_id and b.duration_ms<60000
  ) then
    new.status:='failed';
    new.safe_error:='short_recording_local_only';
    new.lease_until:=null;
    new.lease_token:=null;
  end if;
  return new;
end; $$;
create trigger email_short_recording_hold before insert or update on public.email_jobs
for each row execute function public.hold_short_recording_email();
revoke all on function public.hold_short_recording_email() from public,anon,authenticated;

do $$ declare clip record;
begin
  for clip in select b.session_id,b.device_id from public.browser_recordings b
    join public.recording_sessions s on s.id=b.session_id
    where b.duration_ms<60000 and b.device_id is not null and s.status in ('uploading','sharing','failed')
  loop
    perform public.hold_short_browser_recording(clip.session_id,clip.device_id);
  end loop;
end $$;
update public.email_jobs e set status='failed',safe_error='short_recording_local_only',lease_until=null,lease_token=null
where e.status in ('pending','sending') and exists(
  select 1 from public.browser_recordings b where b.file_id=e.file_id and b.duration_ms<60000
);
