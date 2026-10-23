alter table public.recorders add column paired_at timestamptz;
alter table public.recorders add column agent_version text;
alter table public.recorders add column platform text;
alter table public.recorders add column ffmpeg_available boolean not null default false;
alter table public.cameras add column last_health_check_at timestamptz;

-- Keep ten-second heartbeats out of the human activity log.
drop trigger audit_recorders on public.recorders;
create trigger audit_recorders after insert or update of name on public.recorders for each row execute function public.audit_configuration();
drop trigger audit_cameras on public.cameras;
create trigger audit_cameras after insert or update of name,recorder_id,court_id,source_type,device_reference,is_primary,enabled on public.cameras for each row execute function public.audit_configuration();

create function public.reset_camera_health() returns trigger language plpgsql set search_path='' as $$
begin
  if new.recorder_id is distinct from old.recorder_id or new.device_reference is distinct from old.device_reference or new.source_type is distinct from old.source_type then
    new.health='unknown'; new.last_health_check_at=null;
  end if;
  return new;
end; $$;
revoke all on function public.reset_camera_health() from public;
create trigger reset_camera_health before update on public.cameras for each row execute function public.reset_camera_health();

create table public.recorder_credentials (
  recorder_id uuid primary key references public.recorders(id) on delete cascade,
  pairing_hash text unique,
  pairing_expires_at timestamptz,
  token_hash text unique
);
alter table public.recorder_credentials enable row level security;
revoke all on public.recorder_credentials from anon, authenticated;

create table public.recorder_devices (
  id uuid primary key default gen_random_uuid(),
  recorder_id uuid not null references public.recorders(id) on delete cascade,
  device_reference text not null check (device_reference ~ '^[a-zA-Z0-9._:-]{1,120}$'),
  name text not null check (char_length(name) between 1 and 100),
  source_type text not null check (source_type in ('network','usb')),
  health text not null default 'unknown' check (health in ('unknown','online','offline','needs_configuration')),
  last_seen_at timestamptz not null default now(),
  last_test_at timestamptz,
  diagnostic text check (diagnostic in ('not_tested','connected','unreachable','needs_configuration','ffmpeg_missing','device_missing','unsupported_platform')),
  unique(recorder_id,device_reference)
);
alter table public.recorder_devices enable row level security;
revoke all on public.recorder_devices from anon, authenticated;
grant select on public.recorder_devices to authenticated;
create policy devices_admin_read on public.recorder_devices for select to authenticated using(public.is_admin());

create table public.recorder_commands (
  id uuid primary key default gen_random_uuid(),
  recorder_id uuid not null references public.recorders(id) on delete cascade,
  kind text not null check(kind in ('discover','test')),
  device_reference text not null default '',
  status text not null default 'pending' check(status in ('pending','running','succeeded','failed')),
  requested_by uuid references public.profiles(id),
  created_at timestamptz not null default now(),
  lease_until timestamptz,
  lease_token uuid,
  attempts integer not null default 0,
  finished_at timestamptz,
  result_code text check(result_code in ('completed','agent_error','expired','revoked'))
);
alter table public.recorder_commands enable row level security;
revoke all on public.recorder_commands from anon, authenticated;
grant select on public.recorder_commands to authenticated;
create policy commands_admin_read on public.recorder_commands for select to authenticated using(public.is_admin());
create unique index one_pending_recorder_command on public.recorder_commands(recorder_id,kind,device_reference) where status in ('pending','running');

create function public.redeem_recorder_pair(p_pairing_hash text,p_token_hash text) returns uuid
language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  update public.recorder_credentials set token_hash=p_token_hash,pairing_hash=null,pairing_expires_at=null
  where pairing_hash=p_pairing_hash and pairing_expires_at>now() returning recorder_id into v_id;
  if v_id is not null then
    update public.recorders set paired_at=now(),last_seen_at=null where id=v_id;
    update public.recorder_commands set status='failed',result_code='revoked',finished_at=now() where recorder_id=v_id and status in ('pending','running');
    update public.cameras set health='unknown',last_health_check_at=null where recorder_id=v_id;
    update public.recorder_devices set health='unknown',diagnostic='not_tested',last_test_at=null where recorder_id=v_id;
    insert into public.audit_events(action,safe_detail) values('recorder.paired',jsonb_build_object('recorder_id',v_id));
  end if;
  return v_id;
end; $$;
revoke all on function public.redeem_recorder_pair(text,text) from public,anon,authenticated;
grant execute on function public.redeem_recorder_pair(text,text) to service_role;

create function public.issue_recorder_pair(p_recorder_id uuid,p_hash text,p_expires timestamptz) returns void
language sql security definer set search_path='' as $$
  insert into public.recorder_credentials(recorder_id,pairing_hash,pairing_expires_at)
  values(p_recorder_id,p_hash,p_expires)
  on conflict(recorder_id) do update set pairing_hash=excluded.pairing_hash,pairing_expires_at=excluded.pairing_expires_at;
$$;
revoke all on function public.issue_recorder_pair(uuid,text,timestamptz) from public,anon,authenticated;
grant execute on function public.issue_recorder_pair(uuid,text,timestamptz) to service_role;

create function public.revoke_recorder(p_recorder_id uuid,p_actor_id uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
  delete from public.recorder_credentials where recorder_id=p_recorder_id;
  update public.recorders set paired_at=null,last_seen_at=null where id=p_recorder_id;
  update public.cameras set health='unknown',last_health_check_at=null where recorder_id=p_recorder_id;
  update public.recorder_devices set health='unknown',diagnostic='not_tested',last_test_at=null where recorder_id=p_recorder_id;
  update public.recorder_commands set status='failed',result_code='revoked',finished_at=now() where recorder_id=p_recorder_id and status in ('pending','running');
  insert into public.audit_events(actor_id,action,safe_detail) values(p_actor_id,'recorder.revoked',jsonb_build_object('recorder_id',p_recorder_id));
end; $$;
revoke all on function public.revoke_recorder(uuid,uuid) from public,anon,authenticated;
grant execute on function public.revoke_recorder(uuid,uuid) to service_role;

create function public.claim_recorder_command(p_recorder_id uuid) returns setof public.recorder_commands
language plpgsql security definer set search_path='' as $$
begin
  update public.recorder_commands set status='failed',result_code='expired',finished_at=now()
    where recorder_id=p_recorder_id and status in ('pending','running') and (created_at<now()-interval '10 minutes' or (attempts>=3 and lease_until<now()));
  return query update public.recorder_commands set status='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=now()+interval '90 seconds'
    where id=(select id from public.recorder_commands where recorder_id=p_recorder_id and
    (status='pending' or (status='running' and lease_until<now())) order by created_at for update skip locked limit 1) returning *;
end; $$;
revoke all on function public.claim_recorder_command(uuid) from public,anon,authenticated;
grant execute on function public.claim_recorder_command(uuid) to service_role;

create function public.finish_recorder_command(p_recorder_id uuid,p_command_id uuid,p_lease_token uuid,p_success boolean,p_devices jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare v_job public.recorder_commands; v_device jsonb;
begin
  select * into v_job from public.recorder_commands where id=p_command_id and recorder_id=p_recorder_id and lease_token=p_lease_token and status='running' and lease_until>now() for update;
  if not found then return false; end if;
  if jsonb_typeof(p_devices)<>'array' or jsonb_array_length(p_devices)>64 then raise exception 'Invalid inventory'; end if;
  if p_success then
    if v_job.kind='test' and jsonb_array_length(p_devices)<>1 then raise exception 'Expected one test result'; end if;
    if v_job.kind='discover' then
      -- A new discovery invalidates old health. Only an explicit test makes a feed online.
      update public.recorder_devices set health='offline',diagnostic='device_missing' where recorder_id=p_recorder_id;
      update public.cameras set health='unknown',last_health_check_at=null where recorder_id=p_recorder_id;
    end if;
    for v_device in select * from jsonb_array_elements(p_devices) loop
      if v_job.kind='test' and v_device->>'device_reference'<>v_job.device_reference then raise exception 'Wrong device'; end if;
      insert into public.recorder_devices(recorder_id,device_reference,name,source_type,health,diagnostic,last_seen_at,last_test_at)
      values(p_recorder_id,v_device->>'device_reference',v_device->>'name',v_device->>'source_type',
        case when v_job.kind='discover' then 'unknown' else v_device->>'health' end,
        case when v_job.kind='discover' then 'not_tested' else v_device->>'diagnostic' end,now(),case when v_job.kind='test' then now() else null end)
      on conflict(recorder_id,device_reference) do update set name=excluded.name,source_type=excluded.source_type,health=excluded.health,diagnostic=excluded.diagnostic,last_seen_at=excluded.last_seen_at,last_test_at=excluded.last_test_at;
      if v_job.kind='test' then
        update public.cameras set health=case when v_device->>'health'='online' then 'online' else 'offline' end,last_health_check_at=now()
        where recorder_id=p_recorder_id and device_reference=v_device->>'device_reference';
      end if;
    end loop;
  else
    if v_job.kind='test' then
      update public.cameras set health='unknown',last_health_check_at=null where recorder_id=p_recorder_id and device_reference=v_job.device_reference;
      update public.recorder_devices set health='unknown',diagnostic='not_tested',last_test_at=null where recorder_id=p_recorder_id and device_reference=v_job.device_reference;
    end if;
  end if;
  update public.recorder_commands set status=case when p_success then 'succeeded' else 'failed' end,result_code=case when p_success then 'completed' else 'agent_error' end,finished_at=now() where id=p_command_id;
  insert into public.audit_events(action,safe_detail) values('recorder.'||v_job.kind,jsonb_build_object('recorder_id',p_recorder_id,'success',p_success));
  return true;
end; $$;
revoke all on function public.finish_recorder_command(uuid,uuid,uuid,boolean,jsonb) from public,anon,authenticated;
grant execute on function public.finish_recorder_command(uuid,uuid,uuid,boolean,jsonb) to service_role;

-- Health heartbeats may update during capture; only changes to configuration are blocked.
drop trigger protect_recording_camera on public.cameras;
create trigger protect_recording_camera before update of recorder_id,court_id,device_reference,source_type,is_primary,enabled on public.cameras for each row execute function public.protect_recording_camera();

create function public.player_court_status() returns table(id uuid,name text,location text,camera_status text)
language sql stable security definer set search_path='' as $$
  select c.id,c.name,c.location,
    case when exists(select 1 from public.cameras cam join public.recorders r on r.id=cam.recorder_id
      where cam.court_id=c.id and cam.enabled and cam.is_primary and cam.health='online' and cam.last_health_check_at>now()-interval '5 minutes' and r.last_seen_at>now()-interval '45 seconds') then 'online' else 'offline' end
  from public.courts c where c.active and exists(select 1 from public.profiles p where p.id=auth.uid() and p.active) order by c.created_at;
$$;
revoke all on function public.player_court_status() from public,anon;
grant execute on function public.player_court_status() to authenticated;
