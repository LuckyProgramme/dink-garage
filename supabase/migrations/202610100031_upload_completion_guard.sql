-- A confirmed remote file is terminal. Late tablet failures must not reopen it.
create function public.guard_completed_browser_upload()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if exists (
    select 1 from public.recording_sessions s
    join public.recording_files f on f.session_id=s.id
    where s.id=new.session_id and s.status='ready'
      and f.status='ready' and f.drive_file_id is not null
  ) then
    new.upload_state := 'uploaded';
    new.uploaded_bytes := coalesce(new.bytes,0);
    new.safe_error := null;
    new.last_error := null;
  end if;
  return new;
end; $$;
create trigger browser_upload_terminal_guard before update on public.browser_recordings
for each row execute function public.guard_completed_browser_upload();

create function public.sync_completed_browser_upload()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.status='ready' then
    update public.browser_recordings set upload_state='uploaded',
      uploaded_bytes=coalesce(bytes,0),safe_error=null,last_error=null,
      upload_updated_at=now() where session_id=new.id;
  end if;
  return new;
end; $$;
create trigger browser_upload_session_completed after update of status on public.recording_sessions
for each row when (new.status='ready') execute function public.sync_completed_browser_upload();

update public.browser_recordings b set upload_state='uploaded',
  uploaded_bytes=coalesce(b.bytes,0),safe_error=null,last_error=null,upload_updated_at=now()
where exists (select 1 from public.recording_sessions s join public.recording_files f on f.session_id=s.id
  where s.id=b.session_id and s.status='ready' and f.status='ready' and f.drive_file_id is not null);

-- An explicit email retry must claim that exact replay, not an older queue item.
create function public.claim_browser_email_for_file(p_file uuid)
returns setof public.email_jobs language plpgsql security definer set search_path='' as $$
begin
  return query update public.email_jobs set status='sending',lease_token=gen_random_uuid(),
    lease_until=now()+interval '3 minutes',attempts=attempts+1
  where file_id=(select j.file_id from public.email_jobs j join public.recording_files f on f.id=j.file_id
    where j.file_id=p_file and j.recorder_id is null and j.status='pending'
      and j.next_attempt_at<=now() and f.status='ready' and f.deleted_at is null and f.expires_at>now()
    for update of j skip locked limit 1)
  returning *;
end; $$;
revoke all on function public.guard_completed_browser_upload(),public.sync_completed_browser_upload(),
  public.claim_browser_email_for_file(uuid) from public,anon,authenticated;
grant execute on function public.claim_browser_email_for_file(uuid) to service_role;
