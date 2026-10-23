-- Deleting a device is an explicit administrator action. It overrides a live
-- capture as well as an in-flight upload: the device row and enrollment are
-- removed, while recording logs and already uploaded videos remain available.
create or replace function public.remove_browser_device(p_device uuid,p_actor uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare
  d public.browser_devices;
  sid uuid;
  active_sessions integer := 0;
  cancelled_uploads integer := 0;
begin
  select * into d from public.browser_devices where id=p_device for update;
  if not found then return false; end if;

  -- This is also the tenant-wide upload mutex used by browser_upload_turn.
  -- Holding it makes cancelling the upload and releasing the global queue turn
  -- atomic with device deletion.
  perform 1 from public.venue_settings
  where tenant_id=d.tenant_id and id=true
  for update;

  -- Preserve the existing recovery behavior for an ended capture whose failed
  -- upload left it behind in finalizing state.
  for sid in
    select s.id
    from public.recording_sessions s
    join public.browser_recordings b
      on b.tenant_id=s.tenant_id and b.session_id=s.id
    where b.tenant_id=d.tenant_id and b.device_id=p_device
      and b.upload_state='failed' and s.status='finalizing'
      and s.stopped_at is not null
  loop
    if public.cancel_browser_upload(sid,p_device) then
      cancelled_uploads := cancelled_uploads + 1;
    end if;
  end loop;

  -- An administrator removing the device overrides a live capture. Mark every
  -- session that still depends on this device as failed before deleting it so
  -- the raw-delete guard is satisfied and history remains consistent.
  update public.recording_sessions s
  set status='failed',failure_stage='device_removed',
      stopped_at=coalesce(stopped_at,now())
  where s.tenant_id=d.tenant_id
    and s.status in ('requested','starting','recording','finalizing','uploading','sharing')
    and exists(
      select 1 from public.browser_recordings b
      where b.tenant_id=d.tenant_id and b.session_id=s.id
        and b.device_id=p_device
    );
  get diagnostics active_sessions = row_count;
  cancelled_uploads := cancelled_uploads + active_sessions;

  -- Uploads cannot continue without their device. Keep completed uploads as
  -- history and cancel everything still waiting or in flight. The lease-release
  -- trigger clears any remaining lease tokens.
  update public.browser_recordings b
  set upload_state='cancelled',lease_token=null,lease_until=null,
      upload_updated_at=now(),
      last_error='Device deleted by an administrator. The upload was cancelled.',
      safe_error='Device deleted. Unsent footage may remain only on that device.'
  where b.tenant_id=d.tenant_id and b.device_id=p_device
    and b.upload_state in ('idle','saved_locally','pending','queued','uploading','retrying','failed');

  -- browser_recordings.device_id uses ON DELETE SET NULL, so completed upload
  -- history remains visible after the physical device/enrollment is gone.
  delete from public.browser_devices
  where tenant_id=d.tenant_id and id=p_device;

  update public.kiosk_devices
  set active=false,current_session_id=null
  where tenant_id=d.tenant_id and id=d.kiosk_id;

  insert into public.audit_events(tenant_id,actor_id,action,safe_detail)
  values(
    d.tenant_id,p_actor,'tablet.removed',
    jsonb_build_object(
      'device_id',p_device,
      'device_name',d.name,
      'cancelled_uploads',cancelled_uploads
    )
  );
  return true;
end; $$;

alter function public.remove_browser_device(uuid,uuid) owner to dinkvision_executor;
revoke all on function public.remove_browser_device(uuid,uuid) from public,anon,authenticated;
grant execute on function public.remove_browser_device(uuid,uuid) to service_role;
