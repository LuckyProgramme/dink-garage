-- Rotate a device credential in place. Replacing the kiosk row orphaned the
-- original session ownership, leaving saved files permanently unable to retry.
create or replace function public.enroll_browser(p_hash text,p_token text,p_setup text,p_admin uuid)
returns uuid language plpgsql security definer set search_path='' as $$
declare d public.browser_devices; k uuid;
begin
  select * into d from public.browser_devices
    where enrollment_hash=p_hash and enrollment_expires_at>now() and enabled for update;
  if not found then raise exception 'Enrollment code is invalid or expired'; end if;
  if not exists(select 1 from public.profiles p where p.id=p_admin and p.active and
    (p.is_super_admin or exists(select 1 from public.tenant_memberships m where m.tenant_id=d.tenant_id and m.user_id=p_admin and m.active and m.role='admin'))) then
    raise exception 'Enrollment administrator no longer has access';
  end if;
  if exists(select 1 from public.browser_recordings b join public.recording_sessions s on s.id=b.session_id
    where b.device_id=d.id and s.status in ('requested','starting','recording','finalizing')) then
    raise exception 'Finish the current recording first';
  end if;
  if d.kiosk_id is not null then
    update public.kiosk_devices set token_hash=p_token,created_by=p_admin,active=true,current_session_id=null
      where id=d.kiosk_id returning id into k;
  end if;
  if k is null then
    insert into public.kiosk_devices(token_hash,created_by) values(p_token,p_admin) returning id into k;
  end if;
  update public.browser_devices set kiosk_id=k,enrollment_hash=null,enrollment_expires_at=null,
    setup_hash=p_setup,setup_expires_at=now()+interval '15 minutes',tested_at=null where id=d.id;
  return k;
end; $$;
alter function public.enroll_browser(text,text,text,uuid) owner to dinkvision_executor;
revoke all on function public.enroll_browser(text,text,text,uuid) from public,anon,authenticated;
grant execute on function public.enroll_browser(text,text,text,uuid) to service_role;
