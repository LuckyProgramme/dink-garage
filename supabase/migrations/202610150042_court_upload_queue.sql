-- One FIFO upload queue per court. Cameras assigned to the same court take
-- turns, so a slow connection on one camera cannot let two devices on the same
-- court saturate the link at once, while cameras on other courts keep uploading
-- independently. Replaces the 202610100028 per-device scoping. The queue_state,
-- report, retry, and cancel helpers are unchanged.
create or replace function public.browser_upload_turn(p_session uuid,p_device uuid,p_claim boolean default false)
returns table(allowed boolean,upload_state text,queue_position integer,queue_total integer,active_session uuid,
 active_device_name text,active_court_name text,active_uploaded_bytes bigint,active_total_bytes bigint,
 active_percent integer,blocked_by_failure boolean)
language plpgsql security definer set search_path='' as $$
declare target public.browser_recordings; head public.browser_recordings; target_status text; head_device text; head_court text;
 position_value integer; total_value integer; court_scope uuid;
begin
 select court_id into court_scope from public.recording_sessions where id=p_session;
 if court_scope is not null then
  perform 1 from public.courts where id=court_scope for update;
 else
  perform 1 from public.browser_devices where id=p_device for update;
 end if;
 perform public.expire_browser_uploads(null);
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
 select b.* into head from public.browser_recordings b join public.recording_sessions s on s.id=b.session_id
 where ((court_scope is not null and s.court_id=court_scope) or (court_scope is null and b.device_id=p_device))
   and s.status in ('uploading','sharing') and b.file_id is not null and b.upload_state in ('pending','retrying','uploading')
 order by b.upload_queued_at,b.client_created_at,s.created_at,b.session_id for update of b limit 1;
 if not found then return; end if;
 select ranked.position,ranked.total into position_value,total_value from (
  select b.session_id,row_number() over(order by b.upload_queued_at,b.client_created_at,s.created_at,b.session_id)::integer position,count(*) over()::integer total
  from public.browser_recordings b join public.recording_sessions s on s.id=b.session_id
  where ((court_scope is not null and s.court_id=court_scope) or (court_scope is null and b.device_id=p_device))
    and s.status in ('uploading','sharing') and b.file_id is not null and b.upload_state in ('pending','retrying','uploading')
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

alter function public.browser_upload_turn(uuid,uuid,boolean) owner to dinkvision_executor;
revoke all on function public.browser_upload_turn(uuid,uuid,boolean) from public,anon,authenticated;
grant execute on function public.browser_upload_turn(uuid,uuid,boolean) to service_role;
