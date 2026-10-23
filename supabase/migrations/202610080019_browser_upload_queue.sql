-- Serialize browser and Android-tablet uploads across the venue. Recordings
-- remain on their originating device until the server confirms Drive is ready.
alter table public.browser_recordings
  add column upload_state text not null default 'idle'
    check(upload_state in ('idle','queued','uploading','failed','complete')),
  add column upload_queued_at timestamptz,
  add column upload_started_at timestamptz,
  add column upload_updated_at timestamptz,
  add column uploaded_bytes bigint not null default 0 check(uploaded_bytes>=0);

create index browser_upload_queue_order
  on public.browser_recordings(upload_queued_at,session_id)
  where upload_state in ('queued','uploading','failed');

update public.browser_recordings b
set upload_state=case
      when s.status in ('ready','deleted') then 'complete'
      when s.status in ('uploading','sharing') then 'queued'
      else 'idle'
    end,
    upload_queued_at=case
      when s.status in ('uploading','sharing','ready','deleted')
        then coalesce(s.stopped_at,s.created_at)
      else null
    end,
    upload_updated_at=case
      when s.status in ('uploading','sharing','ready','deleted') then now()
      else null
    end,
    uploaded_bytes=case
      when s.status in ('ready','deleted') then coalesce(b.bytes,0)
      else 0
    end
from public.recording_sessions s
where s.id=b.session_id;

create function public.queue_browser_upload(p_session uuid,p_device uuid)
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
      and b.upload_state in ('queued','uploading','failed','complete')
  );
end; $$;

create function public.browser_upload_turn(
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
  -- The singleton settings row is the venue-wide queue mutex.
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
  if target_status not in ('uploading','sharing') or target.upload_state='idle' then
    return query select false,target.upload_state,0,0,null::uuid,null::text,null::text,
      0::bigint,coalesce(target.bytes,0),0,false;
    return;
  end if;

  -- A disappeared uploader pauses the queue instead of allowing a later video
  -- to skip it. The original device can reclaim the same first position.
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

create function public.report_browser_upload(
  p_session uuid,
  p_device uuid,
  p_state text,
  p_uploaded_bytes bigint
) returns boolean language plpgsql security definer set search_path='' as $$
declare b public.browser_recordings;
begin
  select * into b from public.browser_recordings
  where session_id=p_session and device_id=p_device for update;
  if not found or p_state not in ('uploading','failed','complete')
    or p_uploaded_bytes<0 or p_uploaded_bytes>coalesce(b.bytes,0) then return false; end if;
  if p_state='uploading' and b.upload_state<>'uploading' then return false; end if;
  if p_state='failed' and b.upload_state not in ('uploading','failed') then return false; end if;
  if p_state='complete' and b.upload_state not in ('uploading','complete') then return false; end if;
  update public.browser_recordings
  set upload_state=p_state,
      uploaded_bytes=greatest(uploaded_bytes,p_uploaded_bytes),
      upload_updated_at=now(),
      safe_error=case
        when p_state='failed' then 'Upload paused. Retry on the original device.'
        else null
      end
  where session_id=p_session;
  return true;
end; $$;

revoke all on function public.queue_browser_upload(uuid,uuid),
  public.browser_upload_turn(uuid,uuid,boolean),
  public.report_browser_upload(uuid,uuid,text,bigint)
from public,anon,authenticated;
grant execute on function public.queue_browser_upload(uuid,uuid),
  public.browser_upload_turn(uuid,uuid,boolean),
  public.report_browser_upload(uuid,uuid,text,bigint)
to service_role;
