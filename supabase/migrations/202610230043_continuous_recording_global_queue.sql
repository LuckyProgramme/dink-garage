-- A locally durable capture releases its camera immediately. Branding and upload
-- continue independently, and the later `saved` event supplies the immutable
-- bytes that are eligible for the upload queue.
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
 elsif p_action='captured' then
  if s.status in ('uploading','sharing','ready') then
   update public.kiosk_devices set current_session_id=null where id=p_kiosk and current_session_id=p_session;
   return true;
  end if;
  if s.status not in ('requested','recording','finalizing') then return false; end if;
  update public.recording_sessions set status='uploading',started_at=coalesce(started_at,now()),
    stopped_at=coalesce(stopped_at,now()),failure_stage=null where id=p_session;
  update public.browser_recordings set
    upload_state=case when file_id is null and upload_state in ('idle','saved_locally') then 'saved_locally' else upload_state end,
    upload_updated_at=now(),client_created_at=coalesce(client_created_at,s.created_at),safe_error=null
    where session_id=p_session;
  update public.kiosk_devices set current_session_id=null where id=p_kiosk and current_session_id=p_session;
 elsif p_action='saved' then
  if p_bytes is null or p_bytes<1 or p_bytes>4294967296 or p_mime not in ('video/webm','video/mp4') then raise exception 'Invalid recording'; end if;
  if b.file_id is not null then return b.bytes=p_bytes and b.mime_type=p_mime; end if;
  if s.status not in ('requested','recording','finalizing','uploading','failed') then return false; end if;
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

-- Serialize claims on the tenant's settings row and choose one FIFO head across
-- every device and court in that tenant. RLS still isolates tenant queues.
create or replace function public.browser_upload_turn(p_session uuid,p_device uuid,p_claim boolean default false)
returns table(allowed boolean,upload_state text,queue_position integer,queue_total integer,active_session uuid,
 active_device_name text,active_court_name text,active_uploaded_bytes bigint,active_total_bytes bigint,
 active_percent integer,blocked_by_failure boolean)
language plpgsql security definer set search_path='' as $$
declare target public.browser_recordings; head public.browser_recordings; target_status text; head_device text; head_court text;
 position_value integer; total_value integer; tenant_scope uuid;
begin
 select b.tenant_id into tenant_scope from public.browser_recordings b
 where b.session_id=p_session and b.device_id=p_device;
 if tenant_scope is null then return; end if;
 perform 1 from public.venue_settings where tenant_id=tenant_scope and id=true for update;
 if not found then return; end if;
 perform public.expire_browser_uploads(null);
 select * into target from public.browser_recordings where tenant_id=tenant_scope and session_id=p_session and device_id=p_device for update;
 if not found then return; end if;
 select status into target_status from public.recording_sessions where tenant_id=tenant_scope and id=p_session;
 if target_status='ready' or target.upload_state in ('complete','uploaded') then
  return query select true,'uploaded'::text,0,0,null::uuid,null::text,null::text,target.bytes,target.bytes,100,false; return;
 end if;
 if target_status not in ('uploading','sharing') or target.upload_state in ('idle','saved_locally','failed','cancelled','local_only') then
  return query select false,target.upload_state,0,0,null::uuid,null::text,null::text,target.uploaded_bytes,coalesce(target.bytes,0),
   case when coalesce(target.bytes,0)>0 then least(100,floor(target.uploaded_bytes*100.0/target.bytes)::integer) else 0 end,false; return;
 end if;
 select b.* into head from public.browser_recordings b join public.recording_sessions s
   on s.tenant_id=b.tenant_id and s.id=b.session_id
 where b.tenant_id=tenant_scope and s.status in ('uploading','sharing') and b.file_id is not null
   and b.upload_state in ('pending','retrying','uploading')
 order by b.upload_queued_at,b.client_created_at,s.created_at,b.session_id for update of b limit 1;
 if not found then return; end if;
 select ranked.position,ranked.total into position_value,total_value from (
  select b.session_id,row_number() over(order by b.upload_queued_at,b.client_created_at,s.created_at,b.session_id)::integer position,
    count(*) over()::integer total
  from public.browser_recordings b join public.recording_sessions s on s.tenant_id=b.tenant_id and s.id=b.session_id
  where b.tenant_id=tenant_scope and s.status in ('uploading','sharing') and b.file_id is not null
    and b.upload_state in ('pending','retrying','uploading')
 ) ranked where ranked.session_id=p_session;
 select coalesce(d.name,'Previous device'),coalesce(c.name,s.configuration_snapshot->>'court_name','Another court') into head_device,head_court
 from public.recording_sessions s
 left join public.browser_devices d on d.tenant_id=s.tenant_id and d.id=head.device_id
 left join public.courts c on c.tenant_id=s.tenant_id and c.id=s.court_id
 where s.tenant_id=tenant_scope and s.id=head.session_id;
 if p_claim and head.session_id=p_session then
  update public.browser_recordings set upload_state='uploading',upload_started_at=coalesce(upload_started_at,now()),
    upload_updated_at=now(),last_error=null,safe_error=null
  where tenant_id=tenant_scope and session_id=p_session returning * into target;
 else
  select * into target from public.browser_recordings where tenant_id=tenant_scope and session_id=p_session;
 end if;
 return query select head.session_id=p_session and (not p_claim or target.upload_state='uploading'),target.upload_state,
  coalesce(position_value,0),coalesce(total_value,0),head.session_id,head_device,head_court,coalesce(head.uploaded_bytes,0),coalesce(head.bytes,0),
  case when coalesce(head.bytes,0)>0 then least(100,floor(coalesce(head.uploaded_bytes,0)*100.0/head.bytes)::integer) else 0 end,false;
end; $$;

-- A deployment can encounter one active upload per court from the prior model.
-- Keep the oldest tenant-wide head and safely return all others to the queue.
with ranked as (
 select b.tenant_id,b.session_id,b.upload_state,
   row_number() over(partition by b.tenant_id order by b.upload_queued_at,b.client_created_at,s.created_at,b.session_id) as position
 from public.browser_recordings b join public.recording_sessions s on s.tenant_id=b.tenant_id and s.id=b.session_id
 where s.status in ('uploading','sharing') and b.file_id is not null
   and b.upload_state in ('pending','retrying','uploading')
)
update public.browser_recordings b set upload_state='retrying',upload_started_at=null,lease_until=null,lease_token=null,
 upload_updated_at=now(),last_error='Waiting for the global upload queue.',safe_error=null
from ranked r where r.tenant_id=b.tenant_id and r.session_id=b.session_id and r.position>1 and r.upload_state='uploading';

alter function public.browser_event(uuid,uuid,text,bigint,text) owner to dinkvision_executor;
alter function public.browser_upload_turn(uuid,uuid,boolean) owner to dinkvision_executor;
revoke all on function public.browser_event(uuid,uuid,text,bigint,text),public.browser_upload_turn(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.browser_event(uuid,uuid,text,bigint,text),public.browser_upload_turn(uuid,uuid,boolean) to service_role;
