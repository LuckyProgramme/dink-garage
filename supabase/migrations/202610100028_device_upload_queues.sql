-- Durable per-device queues. Uploads no longer occupy the kiosk's active
-- recording slot and devices assigned to the same court upload independently.
drop index if exists public.browser_court_assignment;

alter table public.browser_recordings
  add column job_id uuid not null default gen_random_uuid(),
  add column retry_count integer not null default 0 check(retry_count between 0 and 100),
  add column last_error text,
  add column client_created_at timestamptz,
  add column duration_ms bigint check(duration_ms is null or duration_ms>=0),
  add column local_available boolean not null default true;
create unique index browser_upload_job_id on public.browser_recordings(job_id);
create index browser_device_queue on public.browser_recordings(device_id,upload_queued_at,client_created_at,session_id);

alter table public.browser_recordings drop constraint browser_recordings_upload_state_check;
alter table public.browser_recordings add constraint browser_recordings_upload_state_check
  check(upload_state in ('idle','queued','complete','cancelled','local_only',
    'saved_locally','pending','uploading','retrying','uploaded','failed'));
update public.browser_recordings set
  upload_state=case upload_state when 'idle' then 'saved_locally' when 'queued' then 'pending' when 'complete' then 'uploaded' else upload_state end,
  client_created_at=coalesce(upload_queued_at,last_seen_at),
  last_error=safe_error;

-- Only an active capture blocks the next capture on this device. Locally saved
-- and uploading sessions stay independently addressable by kiosk ownership.
do $$
declare definition text; updated text;
begin
  definition := pg_get_functiondef('public.browser_start(uuid,text,uuid,uuid,jsonb)'::regprocedure);
  updated := replace(definition,
    's.status not in (''ready'',''failed'',''deleted'')',
    's.status in (''requested'',''starting'',''recording'',''finalizing'')');
  if updated=definition then raise exception 'browser_start active-session check was not updated'; end if;
  execute updated;
end $$;

create or replace function public.browser_event(
  p_kiosk uuid,p_session uuid,p_action text,p_bytes bigint default null,p_mime text default null
) returns boolean language plpgsql security definer set search_path='' as $$
declare s public.recording_sessions; b public.browser_recordings; f uuid; device uuid;
begin
 select id into device from public.browser_devices where kiosk_id=p_kiosk and enabled for update;
 if not found then return false; end if;
 perform 1 from public.kiosk_devices where id=p_kiosk and active for update;
 if not found then return false; end if;
 select * into s from public.recording_sessions where id=p_session and kiosk_id=p_kiosk for update;
 if not found then return false; end if;
 select * into b from public.browser_recordings where session_id=p_session and device_id=device for update;
 if not found then return false; end if;
 update public.browser_recordings set last_seen_at=now() where session_id=p_session;
 if p_action='started' then
  if s.status='recording' then return true; end if;
  if s.status<>'requested' then return false; end if;
  update public.recording_sessions set status='recording',started_at=now() where id=p_session;
 elsif p_action='stopped' then
  if s.status='finalizing' then return true; end if;
  if s.status not in ('requested','recording') then return false; end if;
  update public.recording_sessions set status='finalizing',started_at=coalesce(started_at,now()),stopped_at=coalesce(stopped_at,now()) where id=p_session;
 elsif p_action='saved' then
  if p_bytes is null or p_bytes<1 or p_bytes>4294967296 or p_mime not in ('video/webm','video/mp4') then raise exception 'Invalid recording'; end if;
  if b.file_id is not null then return b.bytes=p_bytes and b.mime_type=p_mime; end if;
  if s.status not in ('requested','recording','finalizing','failed') then return false; end if;
  insert into public.recording_files(session_id,status,bytes) values(p_session,'local_ready',p_bytes) returning id into f;
  update public.browser_recordings set file_id=f,bytes=p_bytes,mime_type=p_mime,safe_error=null,last_error=null,
    upload_state='saved_locally',upload_updated_at=now(),client_created_at=coalesce(client_created_at,s.created_at)
    where session_id=p_session;
  update public.recording_sessions set status='uploading',stopped_at=coalesce(stopped_at,now()),failure_stage=null where id=p_session;
  update public.kiosk_devices set current_session_id=null where id=p_kiosk and current_session_id=p_session;
 elsif p_action='failed' then
  if s.status not in ('requested','recording','finalizing') then return false; end if;
  update public.recording_sessions set status='failed',stopped_at=coalesce(stopped_at,now()),failure_stage='browser_capture' where id=p_session;
  update public.browser_recordings set upload_state='failed',last_error='Recording was interrupted.',safe_error='Recording was interrupted.',upload_updated_at=now() where session_id=p_session;
  update public.kiosk_devices set current_session_id=null where id=p_kiosk and current_session_id=p_session;
 elsif p_action='reset' then
  if s.status not in ('ready','failed','deleted') then return false; end if;
  update public.kiosk_devices set current_session_id=null where id=p_kiosk and current_session_id=p_session;
 elsif p_action<>'heartbeat' then return false;
 end if;
 return true;
end; $$;

create or replace function public.queue_browser_upload(p_session uuid,p_device uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare changed uuid;
begin
 update public.browser_recordings b set upload_state='pending',upload_queued_at=coalesce(b.upload_queued_at,now()),
   upload_updated_at=now(),last_error=null,safe_error=null
 where b.session_id=p_session and b.device_id=p_device and b.file_id is not null
   and b.upload_state in ('idle','saved_locally','retrying')
   and exists(select 1 from public.recording_sessions s where s.id=b.session_id and s.status in ('uploading','sharing'))
 returning b.session_id into changed;
 return changed is not null or exists(select 1 from public.browser_recordings b join public.recording_sessions s on s.id=b.session_id
   where b.session_id=p_session and b.device_id=p_device and s.status in ('uploading','sharing','ready')
   and b.upload_state in ('pending','uploading','retrying','failed','cancelled','uploaded'));
end; $$;

create or replace function public.browser_upload_turn(p_session uuid,p_device uuid,p_claim boolean default false)
returns table(allowed boolean,upload_state text,queue_position integer,queue_total integer,active_session uuid,
 active_device_name text,active_court_name text,active_uploaded_bytes bigint,active_total_bytes bigint,
 active_percent integer,blocked_by_failure boolean)
language plpgsql security definer set search_path='' as $$
declare target public.browser_recordings; head public.browser_recordings; target_status text; head_device text; head_court text; position_value integer; total_value integer;
begin
 perform 1 from public.browser_devices where id=p_device for update;
 select * into target from public.browser_recordings where session_id=p_session and device_id=p_device for update;
 if not found then return; end if;
 select status into target_status from public.recording_sessions where id=p_session;
 if target_status='ready' or target.upload_state in ('complete','uploaded') then
  return query select true,'uploaded'::text,0,0,null::uuid,null::text,null::text,target.bytes,target.bytes,100,false; return;
 end if;
 if target_status not in ('uploading','sharing') or target.upload_state in ('idle','saved_locally','failed','cancelled','local_only') then
  return query select false,target.upload_state,0,0,null::uuid,null::text,null::text,target.uploaded_bytes,coalesce(target.bytes,0),
   case when coalesce(target.bytes,0)>0 then least(100,floor(target.uploaded_bytes*100.0/target.bytes)::integer) else 0 end,false; return;
 end if;
 update public.browser_recordings stale set upload_state='retrying',retry_count=least(100,stale.retry_count+1),upload_updated_at=now(),
   last_error='Upload connection was lost; automatic retry scheduled.',safe_error='Upload connection was lost; automatic retry scheduled.'
 where stale.device_id=p_device and stale.upload_state='uploading' and stale.upload_updated_at<now()-interval '3 minutes';
 select b.* into head from public.browser_recordings b join public.recording_sessions s on s.id=b.session_id
 where b.device_id=p_device and s.status in ('uploading','sharing') and b.file_id is not null and b.upload_state in ('pending','retrying','uploading')
 order by b.upload_queued_at,b.client_created_at,s.created_at,b.session_id for update of b limit 1;
 if not found then return; end if;
 select ranked.position,ranked.total into position_value,total_value from (
  select b.session_id,row_number() over(order by b.upload_queued_at,b.client_created_at,s.created_at,b.session_id)::integer position,count(*) over()::integer total
  from public.browser_recordings b join public.recording_sessions s on s.id=b.session_id
  where b.device_id=p_device and s.status in ('uploading','sharing') and b.file_id is not null and b.upload_state in ('pending','retrying','uploading')
 ) ranked where ranked.session_id=p_session;
 select coalesce(d.name,'Previous device'),coalesce(c.name,s.configuration_snapshot->>'court_name','Another court') into head_device,head_court
 from public.recording_sessions s left join public.browser_devices d on d.id=head.device_id left join public.courts c on c.id=s.court_id where s.id=head.session_id;
 if p_claim and head.session_id=p_session then
  update public.browser_recordings set upload_state='uploading',upload_started_at=coalesce(upload_started_at,now()),upload_updated_at=now(),last_error=null,safe_error=null
  where session_id=p_session returning * into target;
 else select * into target from public.browser_recordings where session_id=p_session; end if;
 return query select head.session_id=p_session and (not p_claim or target.upload_state='uploading'),target.upload_state,
  coalesce(position_value,0),coalesce(total_value,0),head.session_id,head_device,head_court,coalesce(head.uploaded_bytes,0),coalesce(head.bytes,0),
  case when coalesce(head.bytes,0)>0 then least(100,floor(coalesce(head.uploaded_bytes,0)*100.0/head.bytes)::integer) else 0 end,false;
end; $$;

create or replace function public.report_browser_upload(p_session uuid,p_device uuid,p_state text,p_uploaded_bytes bigint)
returns boolean language plpgsql security definer set search_path='' as $$
declare b public.browser_recordings; normalized text;
begin
 select * into b from public.browser_recordings where session_id=p_session and device_id=p_device for update;
 normalized:=case p_state when 'complete' then 'uploaded' else p_state end;
 if not found or normalized not in ('uploading','failed','uploaded') or p_uploaded_bytes<0 or p_uploaded_bytes>coalesce(b.bytes,0) then return false; end if;
 if normalized='uploading' and b.upload_state<>'uploading' then return false; end if;
 update public.browser_recordings set upload_state=normalized,uploaded_bytes=greatest(uploaded_bytes,p_uploaded_bytes),upload_updated_at=now(),
  local_available=case when normalized='uploaded' then false else local_available end,
  last_error=case when normalized='failed' then 'Upload paused on this device.' else null end,
  safe_error=case when normalized='failed' then 'Upload paused on this device.' else null end where session_id=p_session;
 return true;
end; $$;

create or replace function public.retry_browser_upload(p_session uuid,p_device uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare changed uuid;
begin
 update public.browser_recordings set upload_state='retrying',upload_queued_at=now(),upload_started_at=null,upload_updated_at=now(),
  retry_count=0,last_error=null,safe_error=null where session_id=p_session and device_id=p_device
  and upload_state in ('failed','cancelled') and file_id is not null returning session_id into changed;
 return changed is not null;
end; $$;
