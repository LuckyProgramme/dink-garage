alter table public.google_integration add column gmail_authorized_at timestamptz;
create table public.email_jobs (
  file_id uuid primary key references public.recording_files(id),
  recorder_id uuid not null references public.recorders(id),
  status text not null default 'pending' check(status in ('pending','sending','sent','failed','unknown','expired')),
  attempts integer not null default 0,
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz not null default now(),
  safe_error text,
  gmail_message_id text,
  sent_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.email_jobs enable row level security;
revoke all on public.email_jobs from public,anon,authenticated;
grant all on public.email_jobs to service_role;

create function public.claim_recording_email(p_recorder uuid) returns setof public.email_jobs
language plpgsql security definer set search_path='' as $$
begin
  -- Start with recordings completed after email authorization. Historical sends are explicit.
  insert into public.email_jobs(file_id,recorder_id)
  select f.id,c.recorder_id from public.recording_files f
  join public.capture_jobs c on c.session_id=f.session_id
  join public.google_integration g on g.id=true
  where c.recorder_id=p_recorder and f.status='ready' and f.uploaded_at>=g.gmail_authorized_at
    and f.expires_at>now() and f.deleted_at is null
  on conflict(file_id) do nothing;
  -- Gmail has no idempotency key. A crashed send is ambiguous, not safe to repeat.
  update public.email_jobs set status='unknown',safe_error='send_outcome_unknown',lease_until=null
    where recorder_id=p_recorder and status='sending' and lease_until<now();
  update public.email_jobs j set status='expired',safe_error='recording_expired'
    where j.recorder_id=p_recorder and j.status='pending' and not exists
      (select 1 from public.recording_files f where f.id=j.file_id and f.status='ready' and f.deleted_at is null and f.expires_at>now());
  return query update public.email_jobs set status='sending',lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes',attempts=attempts+1
  where file_id=(select j.file_id from public.email_jobs j
    join public.google_integration g on g.id=true and g.gmail_authorized_at is not null
    where j.recorder_id=p_recorder and j.status='pending' and j.next_attempt_at<=now()
    order by j.created_at for update of j skip locked limit 1) returning *;
end; $$;
revoke all on function public.claim_recording_email(uuid) from public,anon,authenticated;
grant execute on function public.claim_recording_email(uuid) to service_role;
