-- Let an administrator release a stuck venue upload without deleting the
-- originating tablet's local video. A manual retry joins the end of the queue.
alter table public.browser_recordings
  drop constraint browser_recordings_upload_state_check;
alter table public.browser_recordings
  add constraint browser_recordings_upload_state_check
  check(upload_state in ('idle','queued','uploading','failed','cancelled','complete'));

create or replace function public.queue_browser_upload(p_session uuid,p_device uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare changed uuid;
begin
  update public.browser_recordings b
  set upload_state='queued',upload_queued_at=coalesce(b.upload_queued_at,now()),
      upload_updated_at=now(),uploaded_bytes=0,safe_error=null
  where b.session_id=p_session and b.device_id=p_device and b.file_id is not null
    and b.upload_state='idle'
    and exists(select 1 from public.recording_sessions s where s.id=b.session_id and s.status in ('uploading','sharing'))
  returning b.session_id into changed;
  if changed is not null then return true; end if;
  return exists(
    select 1 from public.browser_recordings b
    join public.recording_sessions s on s.id=b.session_id
    where b.session_id=p_session and b.device_id=p_device
      and s.status in ('uploading','sharing','ready')
      and b.upload_state in ('queued','uploading','failed','cancelled','complete')
  );
end; $$;

create function public.cancel_browser_upload(p_session uuid,p_device uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare changed uuid;
begin
  perform 1 from public.venue_settings where id=true for update;
  update public.browser_recordings b
  set upload_state='cancelled',upload_updated_at=now(),lease_until=null,
      safe_error='Upload cancelled by venue staff. Retry from the original device.'
  where b.session_id=p_session and b.device_id=p_device
    and b.upload_state in ('queued','uploading','failed')
    and exists(select 1 from public.recording_sessions s where s.id=b.session_id and s.status in ('uploading','sharing'))
  returning b.session_id into changed;
  return changed is not null;
end; $$;

create function public.retry_browser_upload(p_session uuid,p_device uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare changed uuid;
begin
  perform 1 from public.venue_settings where id=true for update;
  update public.browser_recordings b
  set upload_state='queued',upload_queued_at=now(),upload_started_at=null,
      upload_updated_at=now(),safe_error=null
  where b.session_id=p_session and b.device_id=p_device
    and b.upload_state='cancelled' and b.file_id is not null
    and exists(select 1 from public.recording_sessions s where s.id=b.session_id and s.status in ('uploading','sharing'))
  returning b.session_id into changed;
  if changed is not null then return true; end if;
  return exists(
    select 1 from public.browser_recordings b
    join public.recording_sessions s on s.id=b.session_id
    where b.session_id=p_session and b.device_id=p_device
      and s.status in ('uploading','sharing','ready')
      and b.upload_state in ('queued','uploading','failed','complete')
  );
end; $$;

create or replace function public.browser_upload_turn(
  p_session uuid,
  p_device uuid,
  p_claim boolean default false
) returns table(
  allowed boolean,
  upload_state text,
  queue_position integer,
  queue_total integer,
  active_session uuid,
  active_device_name text,
  active_court_name text,
  active_uploaded_bytes bigint,
  active_total_bytes bigint,
  active_percent integer,
  blocked_by_failure boolean
) language plpgsql security definer set search_path='' as $$
declare
  target public.browser_recordings;
  target_status text;
  head public.browser_recordings;
  head_device text;
  head_court text;
  position_value integer;
  total_value integer;
begin
  perform 1 from public.venue_settings where id=true for update;

  select b.* into target from public.browser_recordings b
  where b.session_id=p_session and b.device_id=p_device for update;
  if not found then return; end if;
  select s.status into target_status from public.recording_sessions s where s.id=p_session;

  if target_status='ready' or target.upload_state='complete' then
    return query select true,'complete'::text,0,0,null::uuid,null::text,null::text,
      target.bytes,target.bytes,100,false;
    return;
  end if;
  if target_status not in ('uploading','sharing') or target.upload_state in ('idle','cancelled') then
    return query select false,target.upload_state,0,0,null::uuid,null::text,null::text,
      target.uploaded_bytes,coalesce(target.bytes,0),
      case when coalesce(target.bytes,0)>0
        then least(100,floor(coalesce(target.uploaded_bytes,0)*100.0/target.bytes)::integer)
        else 0 end,false;
    return;
  end if;

  update public.browser_recordings b
  set upload_state='failed',upload_updated_at=now(),
      safe_error=coalesce(b.safe_error,'Upload connection was lost. Retry on the original device.')
  where b.upload_state='uploading'
    and b.upload_updated_at<now()-interval '3 minutes'
    and exists(select 1 from public.recording_sessions s where s.id=b.session_id and s.status in ('uploading','sharing'));

  select b.* into head
  from public.browser_recordings b
  join public.recording_sessions s on s.id=b.session_id
  where s.status in ('uploading','sharing') and b.file_id is not null
    and b.upload_state in ('queued','uploading','failed')
  order by b.upload_queued_at,s.created_at,b.session_id
  for update of b limit 1;
  if not found then return; end if;

  select ranked.position,ranked.total into position_value,total_value
  from (
    select b.session_id,
      row_number() over(order by b.upload_queued_at,s.created_at,b.session_id)::integer as position,
      count(*) over()::integer as total
    from public.browser_recordings b
    join public.recording_sessions s on s.id=b.session_id
    where s.status in ('uploading','sharing') and b.file_id is not null
      and b.upload_state in ('queued','uploading','failed')
  ) ranked where ranked.session_id=p_session;

  select coalesce(d.name,'Previous device'),
         coalesce(c.name,s.configuration_snapshot->>'court_name','Another court')
  into head_device,head_court
  from public.recording_sessions s
  left join public.browser_devices d on d.id=head.device_id
  left join public.courts c on c.id=s.court_id
  where s.id=head.session_id;

  if p_claim and head.session_id=p_session then
    update public.browser_recordings b
    set upload_state='uploading',upload_started_at=coalesce(b.upload_started_at,now()),
        upload_updated_at=now(),safe_error=null
    where b.session_id=p_session
    returning b.* into target;
  else
    select b.* into target from public.browser_recordings b where b.session_id=p_session;
  end if;

  return query select
    head.session_id=p_session and (not p_claim or target.upload_state='uploading'),
    target.upload_state,
    coalesce(position_value,0),coalesce(total_value,0),head.session_id,
    head_device,head_court,coalesce(head.uploaded_bytes,0),coalesce(head.bytes,0),
    case when coalesce(head.bytes,0)>0
      then least(100,floor(coalesce(head.uploaded_bytes,0)*100.0/head.bytes)::integer)
      else 0 end,
    head.upload_state='failed';
end; $$;

revoke all on function public.cancel_browser_upload(uuid,uuid),
  public.retry_browser_upload(uuid,uuid)
from public,anon,authenticated;
grant execute on function public.cancel_browser_upload(uuid,uuid),
  public.retry_browser_upload(uuid,uuid)
to service_role;
