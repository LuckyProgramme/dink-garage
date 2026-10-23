-- Browser credentials and enrollment secrets are service-only, never player accounts.
create table public.browser_devices (
 id uuid primary key default gen_random_uuid(), organization text not null default 'Casa Batik' check(organization='Casa Batik'),
 name text not null, court_id uuid references public.courts(id), kiosk_id uuid unique references public.kiosk_devices(id),
 enabled boolean not null default true, enrollment_hash text unique, enrollment_expires_at timestamptz,
 setup_hash text, setup_expires_at timestamptz, source_type text not null default 'local' check(source_type in ('local','whep')),
 video_device text not null default '', audio_device text not null default '', stream_url text not null default '',
 camera_name text not null default '', tested_at timestamptz, last_seen_at timestamptz, test_requested boolean not null default false,
 diagnostic text, created_at timestamptz not null default now()
);
create unique index browser_court_assignment on public.browser_devices(court_id) where enabled;
alter table public.venue_settings add column browser_worker_at timestamptz;
create table public.browser_recordings (
 session_id uuid primary key references public.recording_sessions(id), device_id uuid not null references public.browser_devices(id),
 file_id uuid unique references public.recording_files(id), mime_type text, bytes bigint, drive_id text unique, folder_id text, root_id text,
 upload_uri_encrypted text, lease_token uuid, lease_until timestamptz, last_seen_at timestamptz not null default now(), safe_error text
);
alter table public.recording_files alter column camera_id drop not null;
alter table public.email_jobs alter column recorder_id drop not null;
alter table public.browser_devices enable row level security;
alter table public.browser_recordings enable row level security;
revoke all on public.browser_devices,public.browser_recordings from public,anon,authenticated;
grant all on public.browser_devices,public.browser_recordings to service_role;

create function public.protect_browser_assignment() returns trigger language plpgsql set search_path='' as $$
begin
 if (new.court_id,new.kiosk_id,new.enabled,new.video_device,new.audio_device,new.source_type,new.stream_url) is distinct from (old.court_id,old.kiosk_id,old.enabled,old.video_device,old.audio_device,old.source_type,old.stream_url)
 and exists(select 1 from public.browser_recordings b join public.recording_sessions s on s.id=b.session_id where b.device_id=old.id and s.status not in ('ready','failed','deleted')) then
  raise exception 'Finish or recover the current recording before changing its assignment';
 end if;
 return new;
end; $$;
create trigger protect_browser_assignment before update on public.browser_devices for each row execute function public.protect_browser_assignment();

create function public.enroll_browser(p_hash text,p_token text,p_setup text,p_admin uuid) returns uuid
language plpgsql security definer set search_path='' as $$
declare d public.browser_devices; k uuid;
begin
 select * into d from public.browser_devices where enrollment_hash=p_hash and enrollment_expires_at>now() and enabled for update;
 if not found then raise exception 'Enrollment code is invalid or expired'; end if;
 if exists(select 1 from public.browser_recordings b join public.recording_sessions s on s.id=b.session_id where b.device_id=d.id and s.status not in ('ready','failed','deleted')) then raise exception 'Finish the current recording first'; end if;
 if d.kiosk_id is not null then update public.kiosk_devices set active=false where id=d.kiosk_id; end if;
 insert into public.kiosk_devices(token_hash,created_by) values(p_token,p_admin) returning id into k;
 update public.browser_devices set kiosk_id=k,enrollment_hash=null,enrollment_expires_at=null,setup_hash=p_setup,setup_expires_at=now()+interval '15 minutes',tested_at=null where id=d.id;
 return k;
end; $$;

create function public.browser_start(p_kiosk uuid,p_email text,p_key uuid) returns uuid
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

create function public.browser_event(p_kiosk uuid,p_session uuid,p_action text,p_bytes bigint default null,p_mime text default null) returns boolean
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
 elsif p_action='saved' then
  if p_bytes is null or p_bytes<1 or p_bytes>4294967296 or p_mime not in ('video/webm','video/mp4') then raise exception 'Invalid recording'; end if;
  if b.file_id is not null then return b.bytes=p_bytes and b.mime_type=p_mime; end if;
  if s.status not in ('requested','recording','failed') then return false; end if;
  insert into public.recording_files(session_id,status,bytes) values(p_session,'local_ready',p_bytes) returning id into f;
  update public.browser_recordings set file_id=f,bytes=p_bytes,mime_type=p_mime,safe_error=null where session_id=p_session;
  update public.recording_sessions set status='uploading',stopped_at=coalesce(stopped_at,now()),failure_stage=null where id=p_session;
 elsif p_action='failed' then
  if s.status not in ('requested','recording') then return false; end if;
  update public.recording_sessions set status='failed',stopped_at=now(),failure_stage='browser_capture' where id=p_session;
 elsif p_action='reset' then
  if s.status not in ('ready','failed','deleted') then return false; end if;
  update public.kiosk_devices set current_session_id=null where id=p_kiosk;
 elsif p_action<>'heartbeat' then return false;
 end if;
 return true;
end; $$;

create function public.finish_browser_upload(p_session uuid,p_permission text) returns boolean
language plpgsql security definer set search_path='' as $$
declare b public.browser_recordings; s public.recording_sessions;
begin
 select * into s from public.recording_sessions where id=p_session for update;
 select * into b from public.browser_recordings where session_id=p_session for update;
 if not found or b.drive_id is null or b.file_id is null then return false; end if;
 if s.status='ready' then return true; end if;
 if s.status not in ('uploading','sharing') then return false; end if;
 update public.recording_files set status='ready',drive_file_id=b.drive_id,drive_permission_id=p_permission,uploaded_at=now(),expires_at=now()+make_interval(secs=>(s.configuration_snapshot->>'retention_seconds')::integer) where id=b.file_id;
 update public.recording_sessions set status='ready',failure_stage=null where id=p_session;
 update public.browser_recordings set upload_uri_encrypted=null,safe_error=null where session_id=p_session;
 insert into public.email_jobs(file_id) values(b.file_id) on conflict do nothing;
 return true;
end; $$;

revoke all on function public.enroll_browser(text,text,text,uuid),public.browser_start(uuid,text,uuid),public.browser_event(uuid,uuid,text,bigint,text),public.finish_browser_upload(uuid,text) from public,anon,authenticated;
grant execute on function public.enroll_browser(text,text,text,uuid),public.browser_start(uuid,text,uuid),public.browser_event(uuid,uuid,text,bigint,text),public.finish_browser_upload(uuid,text) to service_role;

create function public.claim_browser_email() returns setof public.email_jobs language plpgsql security definer set search_path='' as $$
begin
 update public.email_jobs set status='unknown',safe_error='send_outcome_unknown',lease_until=null where recorder_id is null and status='sending' and lease_until<now();
 update public.email_jobs j set status='expired',safe_error='recording_expired' where recorder_id is null and status='pending' and exists(select 1 from public.recording_files f where f.id=j.file_id and (f.expires_at<=now() or f.deleted_at is not null));
 return query update public.email_jobs set status='sending',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes',attempts=attempts+1 where file_id=(select file_id from public.email_jobs where recorder_id is null and status='pending' and next_attempt_at<=now() order by created_at for update skip locked limit 1) returning *;
end; $$;
revoke all on function public.claim_browser_email() from public,anon,authenticated;
grant execute on function public.claim_browser_email() to service_role;
