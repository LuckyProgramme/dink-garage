create table public.cleanup_jobs (
 file_id uuid primary key references public.recording_files(id),
 recorder_id uuid not null references public.recorders(id),
 status text not null default 'pending' check(status in ('pending','cloud_deleted','done')),
 attempts integer not null default 0,
 lease_token uuid, lease_until timestamptz,
 next_attempt_at timestamptz not null default now(),
 safe_error text, cloud_deleted_at timestamptz, local_deleted_at timestamptz,
 created_at timestamptz not null default now()
);
alter table public.cleanup_jobs enable row level security;
revoke all on public.cleanup_jobs from public,anon,authenticated;
grant all on public.cleanup_jobs to service_role;
create function public.claim_cleanup(p_recorder uuid) returns setof public.cleanup_jobs
language plpgsql security definer set search_path='' as $$
begin
 insert into public.cleanup_jobs(file_id,recorder_id)
 select f.id,c.recorder_id from public.recording_files f join public.capture_jobs c on c.session_id=f.session_id
 join public.drive_upload_jobs u on u.file_id=f.id and u.status='ready' and u.drive_id=f.drive_file_id
 where c.recorder_id=p_recorder and c.status='completed' and f.status='ready' and f.expires_at<=now() and f.deleted_at is null
 on conflict(file_id) do nothing;
 update public.recording_sessions s set status='deleting' from public.recording_files f,public.cleanup_jobs j
 where s.id=f.session_id and f.id=j.file_id and j.recorder_id=p_recorder and j.status='pending';
 update public.recording_files f set status='deleting' from public.cleanup_jobs j
 where f.id=j.file_id and j.recorder_id=p_recorder and j.status='pending';
 update public.email_jobs e set status='expired',safe_error='recording_expired'
 from public.cleanup_jobs j where e.file_id=j.file_id and j.recorder_id=p_recorder and e.status in ('pending','failed');
 return query update public.cleanup_jobs set attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes'
 where file_id=(select j.file_id from public.cleanup_jobs j where j.recorder_id=p_recorder and j.status<>'done'
 and j.next_attempt_at<=now() and (j.lease_until is null or j.lease_until<now()) order by j.next_attempt_at for update skip locked limit 1) returning *;
end; $$;
create function public.confirm_cloud_cleanup(p_file uuid,p_token uuid) returns boolean
language plpgsql security definer set search_path='' as $$
declare s uuid;
begin
 update public.cleanup_jobs set status='cloud_deleted',cloud_deleted_at=coalesce(cloud_deleted_at,now()),safe_error=null
 where file_id=p_file and lease_token=p_token and lease_until>now() and status in ('pending','cloud_deleted');
 if not found then return false; end if;
 update public.recording_files set status='deleted',deleted_at=coalesce(deleted_at,now()) where id=p_file returning session_id into s;
 update public.recording_sessions set status='deleted' where id=s;
 insert into public.audit_events(session_id,action) values(s,'retention.cloud_deleted');
 return true;
end; $$;
revoke all on function public.claim_cleanup(uuid),public.confirm_cloud_cleanup(uuid,uuid) from public,anon,authenticated;
grant execute on function public.claim_cleanup(uuid),public.confirm_cloud_cleanup(uuid,uuid) to service_role;
