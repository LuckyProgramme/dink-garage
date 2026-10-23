-- A removed device disappears permanently, while historical sessions, videos,
-- and recording logs remain available to the venue administrator.
alter table public.browser_recordings
  drop constraint browser_recordings_device_id_fkey;
alter table public.browser_recordings
  alter column device_id drop not null;
alter table public.browser_recordings
  add constraint browser_recordings_device_id_fkey
  foreign key(device_id) references public.browser_devices(id) on delete set null;

create function public.protect_browser_device_delete() returns trigger
language plpgsql set search_path='' as $$
begin
  if exists(
    select 1
    from public.browser_recordings b
    join public.recording_sessions s on s.id=b.session_id
    where b.device_id=old.id
      and s.status not in ('ready','failed','deleted')
  ) then
    raise exception 'Finish or recover the current recording before removing this device';
  end if;
  return old;
end; $$;
create trigger protect_browser_device_delete
before delete on public.browser_devices
for each row execute function public.protect_browser_device_delete();

create or replace function public.browser_event(
  p_kiosk uuid,
  p_session uuid,
  p_action text,
  p_bytes bigint default null,
  p_mime text default null
) returns boolean
language plpgsql security definer set search_path='' as $$
declare s public.recording_sessions; b public.browser_recordings; f uuid;
begin
 perform 1 from public.browser_devices where kiosk_id=p_kiosk and enabled for update;
 if not found then return false; end if;
 perform 1 from public.kiosk_devices where id=p_kiosk and active and current_session_id=p_session for update;
 if not found then return false; end if;
 select * into s from public.recording_sessions where id=p_session and kiosk_id=p_kiosk for update;
 if not found then return false; end if;
 select * into b from public.browser_recordings where session_id=p_session for update;
 if not found then return false; end if;
 update public.browser_recordings set last_seen_at=now() where session_id=p_session;
 if p_action='started' then
  if s.status='recording' then return true; end if;
  if s.status<>'requested' then return false; end if;
  update public.recording_sessions set status='recording',started_at=now() where id=p_session;
 elsif p_action='stopped' then
  if s.status='finalizing' then return true; end if;
  if s.status not in ('requested','recording') then return false; end if;
  update public.recording_sessions
    set status='finalizing',started_at=coalesce(started_at,now()),stopped_at=coalesce(stopped_at,now())
    where id=p_session;
 elsif p_action='saved' then
  if p_bytes is null or p_bytes<1 or p_bytes>4294967296 or p_mime not in ('video/webm','video/mp4') then raise exception 'Invalid recording'; end if;
  if b.file_id is not null then return b.bytes=p_bytes and b.mime_type=p_mime; end if;
  if s.status not in ('requested','recording','finalizing','failed') then return false; end if;
  insert into public.recording_files(session_id,status,bytes) values(p_session,'local_ready',p_bytes) returning id into f;
  update public.browser_recordings set file_id=f,bytes=p_bytes,mime_type=p_mime,safe_error=null where session_id=p_session;
  update public.recording_sessions set status='uploading',stopped_at=coalesce(stopped_at,now()),failure_stage=null where id=p_session;
 elsif p_action='failed' then
  if s.status not in ('requested','recording','finalizing') then return false; end if;
  update public.recording_sessions set status='failed',stopped_at=coalesce(stopped_at,now()),failure_stage='browser_capture' where id=p_session;
 elsif p_action='reset' then
  if s.status not in ('ready','failed','deleted') then return false; end if;
  update public.kiosk_devices set current_session_id=null where id=p_kiosk;
 elsif p_action<>'heartbeat' then return false;
 end if;
 return true;
end; $$;

revoke all on function public.browser_event(uuid,uuid,text,bigint,text) from public,anon,authenticated;
grant execute on function public.browser_event(uuid,uuid,text,bigint,text) to service_role;
