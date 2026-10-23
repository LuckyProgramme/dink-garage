alter table public.recording_sessions add column source_session_id uuid;
alter table public.recording_sessions add column clip_start_ms bigint check(clip_start_ms is null or clip_start_ms>=0);
alter table public.recording_sessions add constraint recording_clip_source
  foreign key(tenant_id,source_session_id) references public.recording_sessions(tenant_id,id);
create index recording_clip_sources on public.recording_sessions(tenant_id,source_session_id) where source_session_id is not null;

create function public.register_browser_clip(p_kiosk uuid,p_source uuid,p_clip uuid,p_start_ms bigint,p_duration_ms bigint)
returns uuid language plpgsql security definer set search_path='' as $$
declare d public.browser_devices; s public.recording_sessions; existing public.recording_sessions; b public.browser_recordings;
begin
  select * into d from public.browser_devices where kiosk_id=p_kiosk and enabled for update;
  if not found or not exists(select 1 from public.kiosk_devices where id=p_kiosk and active) then raise exception 'Device unavailable'; end if;
  select * into s from public.recording_sessions where id=p_source and kiosk_id=p_kiosk;
  select * into b from public.browser_recordings where session_id=p_source and device_id=d.id;
  if s.id is null or b.file_id is null or s.source_session_id is not null or b.duration_ms is null
    or s.status in ('requested','starting','recording','finalizing') then raise exception 'Finalize the source recording first'; end if;
  if p_start_ms is null or p_duration_ms is null or p_start_ms<0 or p_duration_ms<=0 or p_duration_ms>61500
    or p_start_ms+p_duration_ms>b.duration_ms+1500 then raise exception 'Invalid clip range'; end if;
  select * into existing from public.recording_sessions where id=p_clip;
  if found then
    if existing.source_session_id is distinct from p_source or existing.kiosk_id is distinct from p_kiosk
      or existing.clip_start_ms is distinct from p_start_ms then raise exception 'Clip identity conflict'; end if;
    return existing.id;
  end if;
  if (select count(*) from public.recording_sessions where kiosk_id=p_kiosk and source_session_id is not null and created_at>now()-interval '1 minute')>=5 then raise exception 'Clip creation limit reached'; end if;
  -- A derived file never takes a physical camera slot or changes current_session_id.
  insert into public.recording_sessions(id,kiosk_id,court_id,idempotency_key,recipient_email,duration_seconds,
    configuration_snapshot,status,failure_stage,source_session_id,clip_start_ms,started_at,stopped_at)
  values(p_clip,p_kiosk,s.court_id,p_clip,s.recipient_email,ceil(p_duration_ms/1000.0)::integer,
    s.configuration_snapshot||jsonb_build_object('sharing_mode','private','clip',true),
    'failed','clip_pending',p_source,p_start_ms,
    coalesce(s.started_at,s.created_at)+p_start_ms*interval '1 millisecond',
    coalesce(s.started_at,s.created_at)+(p_start_ms+p_duration_ms)*interval '1 millisecond');
  insert into public.browser_recordings(session_id,device_id,duration_ms,client_created_at)
    values(p_clip,d.id,p_duration_ms,now());
  insert into public.audit_events(session_id,action,safe_detail)
    values(p_clip,'clip.created',jsonb_build_object('source_session_id',p_source,'start_ms',p_start_ms,'duration_ms',p_duration_ms));
  return p_clip;
end; $$;
alter function public.register_browser_clip(uuid,uuid,uuid,bigint,bigint) owner to dinkvision_executor;
revoke all on function public.register_browser_clip(uuid,uuid,uuid,bigint,bigint) from public,anon,authenticated;
grant execute on function public.register_browser_clip(uuid,uuid,uuid,bigint,bigint) to service_role;
