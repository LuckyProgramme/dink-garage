create table public.google_integration (
  id boolean primary key default true check(id),
  owner_email text not null,
  root_folder_id text not null,
  refresh_token_encrypted text not null,
  connected_at timestamptz not null default now(),
  safe_error text
);
create table public.google_oauth_states (
  state_hash text primary key,
  admin_id uuid not null references public.profiles(id),
  expires_at timestamptz not null
);
create table public.drive_folders (
  root_id text not null,
  day text not null,
  drive_id text not null unique,
  primary key(root_id,day)
);
create table public.drive_upload_jobs (
  file_id uuid primary key references public.recording_files(id),
  recorder_id uuid not null references public.recorders(id),
  root_id text not null,
  status text not null default 'pending' check(status in ('pending','uploading','sharing','ready','failed')),
  drive_id text unique,
  folder_id text,
  upload_uri_encrypted text,
  expected_md5 text,
  lease_token uuid,
  lease_until timestamptz,
  attempts integer not null default 0,
  next_attempt_at timestamptz not null default now(),
  safe_error text,
  created_at timestamptz not null default now()
);
alter table public.recording_files add column drive_permission_id text;
alter table public.google_integration enable row level security;
alter table public.google_oauth_states enable row level security;
alter table public.drive_folders enable row level security;
alter table public.drive_upload_jobs enable row level security;
revoke all on public.google_integration,public.google_oauth_states,public.drive_folders,public.drive_upload_jobs from public,anon,authenticated;
grant all on public.google_integration,public.google_oauth_states,public.drive_folders,public.drive_upload_jobs to service_role;

create function public.claim_drive_upload(p_recorder uuid) returns setof public.drive_upload_jobs
language plpgsql security definer set search_path='' as $$
begin
  -- Only new recordings are auto-uploaded. Older clips need an explicit admin queue action.
  insert into public.drive_upload_jobs(file_id,recorder_id,root_id)
  select f.id,j.recorder_id,g.root_folder_id from public.recording_files f
  join public.recording_sessions s on s.id=f.session_id
  join public.capture_jobs j on j.session_id=s.id
  join public.google_integration g on g.id=true
  where j.recorder_id=p_recorder and j.status='completed' and f.status='local_ready'
    and s.created_at>=g.connected_at
  on conflict(file_id) do nothing;
  return query update public.drive_upload_jobs set lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes',attempts=attempts+1
  where file_id=(select u.file_id from public.drive_upload_jobs u
    join public.google_integration g on g.root_folder_id=u.root_id
    where u.recorder_id=p_recorder and u.status in ('pending','uploading','sharing')
      and u.next_attempt_at<=now() and (u.lease_until is null or u.lease_until<now())
    order by u.created_at for update of u skip locked limit 1) returning *;
end; $$;

create function public.finish_drive_upload(p_file uuid,p_token uuid,p_permission text) returns boolean
language plpgsql security definer set search_path='' as $$
declare j public.drive_upload_jobs; s_id uuid;
begin
  select * into j from public.drive_upload_jobs where file_id=p_file and lease_token=p_token and lease_until>now() for update;
  if not found then return false; end if;
  if j.status='ready' then return true; end if;
  if j.status<>'sharing' or p_permission is null then raise exception 'Upload not verified'; end if;
  update public.recording_files set status='ready',drive_permission_id=p_permission where id=p_file returning session_id into s_id;
  update public.recording_sessions set status='ready',failure_stage=null where id=s_id;
  update public.drive_upload_jobs set status='ready',safe_error=null,upload_uri_encrypted=null,lease_until=null where file_id=p_file;
  insert into public.audit_events(session_id,action) values(s_id,'drive.ready');
  return true;
end; $$;
revoke all on function public.claim_drive_upload(uuid),public.finish_drive_upload(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.claim_drive_upload(uuid),public.finish_drive_upload(uuid,uuid,text) to service_role;
